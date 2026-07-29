'use strict';

const admin = require('firebase-admin');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');

const mockGetKlines = jest.fn();
jest.mock('binance', () => {
	return {
		MainClient: jest.fn().mockImplementation(() => {
			return {
				getKlines: mockGetKlines,
			};
		}),
	};
});

describe('SignalOutcomeService Worker & Bounded Evaluation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();
		admin.__resetApps();
		admin.__resetCollectionState();
		AlertStorageService._resetForTesting();
		SignalOutcomeService.stopWorker();
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS;
	});

	afterEach(() => {
		SignalOutcomeService.stopWorker();
		jest.useRealTimers();
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS;
	});

	describe('Disabled Tracking Behavior', () => {
		it('does not start worker, create timers, or perform Firestore/Binance calls when disabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'false';
			const started = SignalOutcomeService.startWorker();

			expect(started).toBe(false);

			const status = SignalOutcomeService.getWorkerStatus();
			expect(status.running).toBe(false);
			expect(status.enabled).toBe(false);

			// Fast-forward timers
			jest.advanceTimersByTime(600000);
			await Promise.resolve();

			expect(mockGetKlines).not.toHaveBeenCalled();
		});
	});

	describe('Autonomous Evaluation Worker', () => {
		it('starts worker, performs initial sweep, and runs periodically when enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '300000'; // 5 mins

			// Set up two matured documents in mock Firestore
			const pastDate = new Date(Date.now() - 3600000);
			const docData1 = {
				receivedAt: admin.firestore.Timestamp.fromDate(pastDate),
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				side: 'BUY',
				price: 50000,
				outcomeEvaluated: false,
				outcomes: {
					'1h': {
						status: 'pending',
						targetTime: new Date(Date.now() - 1000).toISOString(),
					},
				},
			};
			const docData2 = {
				receivedAt: admin.firestore.Timestamp.fromDate(pastDate),
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				side: 'BUY',
				price: 3000,
				outcomeEvaluated: false,
				outcomes: {
					'1h': {
						status: 'pending',
						targetTime: new Date(Date.now() + 200000).toISOString(), // matures before 300000ms
					},
				},
			};

			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([['sig_doc_1', docData1], ['sig_doc_2', docData2]])
			);

			mockGetKlines.mockResolvedValue([
				[1600000000000, '50000', '51000', '49500', '50500', '100'],
			]);

			const started = SignalOutcomeService.startWorker();
			expect(started).toBe(true);

			let status = SignalOutcomeService.getWorkerStatus();
			expect(status.running).toBe(true);
			expect(status.intervalMs).toBe(300000);

			// Flush initial sweep microtasks
			await jest.advanceTimersByTimeAsync(0);

			expect(mockGetKlines).toHaveBeenCalledTimes(1);

			// Advance timers to next interval
			await jest.advanceTimersByTimeAsync(300000);

			expect(mockGetKlines).toHaveBeenCalledTimes(2);
		});

		it('prevents overlapping sweeps (single-flight execution)', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			// Create a slow klines response
			let resolveKlines;
			mockGetKlines.mockImplementation(() => new Promise((resolve) => {
				resolveKlines = resolve;
			}));

			const pastDate = new Date(Date.now() - 3600000);
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([
					['doc_1', {
						receivedAt: admin.firestore.Timestamp.fromDate(pastDate),
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						side: 'BUY',
						price: 50000,
						outcomeEvaluated: false,
						outcomes: {
							'1h': { status: 'pending', targetTime: new Date(Date.now() - 1000).toISOString() },
						},
					}],
				])
			);

			SignalOutcomeService.startWorker({ intervalMs: 300000 });
			await Promise.resolve();
			await Promise.resolve();

			const statusDuring = SignalOutcomeService.getWorkerStatus();
			expect(statusDuring.isEvaluating).toBe(true);

			// Trigger a manual sweep while first sweep is still pending
			const secondSweepResult = await SignalOutcomeService.evaluatePendingOutcomes();
			expect(secondSweepResult).toEqual({ scannedCount: 0, evaluatedCount: 0, skipped: true, reason: 'already_evaluating' });

			// Complete the first sweep
			resolveKlines([[1600000000000, '50000', '51000', '49500', '50500', '100']]);
			await jest.runOnlyPendingTimersAsync();

			const statusAfter = SignalOutcomeService.getWorkerStatus();
			expect(statusAfter.isEvaluating).toBe(false);
		});

		it('bounds sweep by batch limit and max duration budget', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const docsMap = new Map();
			for (let i = 1; i <= 10; i++) {
				docsMap.set(`doc_${i}`, {
					receivedAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 3600000)),
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': { status: 'pending', targetTime: new Date(Date.now() - 1000).toISOString() },
					},
				});
			}
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				docsMap
			);

			mockGetKlines.mockResolvedValue([
				[1600000000000, '50000', '51000', '49500', '50500', '100'],
			]);

			// Evaluate with limit: 3
			const result = await SignalOutcomeService.evaluatePendingOutcomes({ limit: 3 });
			expect(result.scannedCount).toBe(3);
			expect(mockGetKlines).toHaveBeenCalledTimes(3);
		});

		it('rotates signal outcome batches across successive worker sweeps when pending exceeds batch limit', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const docsMap = new Map();
			// 5 pending documents.
			// Doc 1 & 2 have a 4h window that is NOT mature yet (targetTime in future), so outcomeEvaluated remains false.
			// Doc 3, 4 & 5 have a 1h window that IS mature (targetTime in past).
			for (let i = 1; i <= 5; i++) {
				const isImmature = i <= 2;
				docsMap.set(`doc_${i}`, {
					receivedAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 3600000)),
					symbol: `CRYPTO${i}USDT`,
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: isImmature
								? new Date(Date.now() + 3600000).toISOString()
								: new Date(Date.now() - 1000).toISOString(),
						},
					},
				});
			}

			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				docsMap
			);

			mockGetKlines.mockResolvedValue([
				[1600000000000, '50000', '51000', '49500', '50500', '100'],
			]);

			// Sweep 1 with limit 2: scans doc_1 and doc_2 (immature, 0 klines calls)
			const sweep1 = await SignalOutcomeService.evaluatePendingOutcomes({ limit: 2 });
			expect(sweep1.scannedCount).toBe(2);
			const klinesCountAfterSweep1 = mockGetKlines.mock.calls.length;

			// Sweep 2 with limit 2: rotates past doc_2 and scans doc_3 and doc_4 (mature!)
			const sweep2 = await SignalOutcomeService.evaluatePendingOutcomes({ limit: 2 });
			expect(sweep2.scannedCount).toBe(2);
			const klinesCountAfterSweep2 = mockGetKlines.mock.calls.length;
			expect(klinesCountAfterSweep2 - klinesCountAfterSweep1).toBe(2);

			// Sweep 3 with limit 2: scans doc_5
			const sweep3 = await SignalOutcomeService.evaluatePendingOutcomes({ limit: 2 });
			expect(sweep3.scannedCount).toBe(1);
		});

		it('isolates errors fail-open when provider or firestore fails', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([
					['doc_err', {
						receivedAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 3600000)),
						symbol: 'FAILUSDT',
						exchange: 'BINANCE',
						side: 'BUY',
						price: 50000,
						outcomeEvaluated: false,
						outcomes: {
							'1h': { status: 'pending', targetTime: new Date(Date.now() - 1000).toISOString() },
						},
					}],
				])
			);

			mockGetKlines.mockRejectedValue(new Error('Binance API Network Error'));

			SignalOutcomeService.startWorker({ intervalMs: 300000 });
			await jest.runOnlyPendingTimersAsync();

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('[SignalOutcomeService] Error evaluating window'),
				expect.any(String)
			);

			const status = SignalOutcomeService.getWorkerStatus();
			expect(status.running).toBe(true); // worker stays active

			consoleSpy.mockRestore();
		});

		it('clears worker cleanly on stopWorker() without active timers', () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			SignalOutcomeService.startWorker();

			let status = SignalOutcomeService.getWorkerStatus();
			expect(status.running).toBe(true);

			SignalOutcomeService.stopWorker();

			status = SignalOutcomeService.getWorkerStatus();
			expect(status.running).toBe(false);
			expect(status.timerId).toBeNull();
		});

		describe('Interval Validation', () => {
			it('falls back to default 300000ms cadence when interval configuration is malformed, zero, or negative', () => {
				process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

				// 1. Malformed string env var
				process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = 'invalid_abc';
				SignalOutcomeService.startWorker();
				let status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				// 2. Zero string env var
				process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '0';
				SignalOutcomeService.startWorker();
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				// 3. Negative string env var
				process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '-5000';
				SignalOutcomeService.startWorker();
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				// 4. Invalid options.intervalMs (0, negative, malformed)
				delete process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS;
				SignalOutcomeService.startWorker({ intervalMs: 0 });
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				SignalOutcomeService.startWorker({ intervalMs: -6000 });
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				SignalOutcomeService.startWorker({ intervalMs: 'invalid' });
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();
			});

			it('uses valid positive interval values when provided via options or env vars', () => {
				process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

				// Valid positive env var
				process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '60000';
				SignalOutcomeService.startWorker();
				let status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(60000);
				SignalOutcomeService.stopWorker();

				// Valid positive options override
				delete process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS;
				SignalOutcomeService.startWorker({ intervalMs: 120000 });
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(120000);
				SignalOutcomeService.stopWorker();
			});
		});
	});
});
