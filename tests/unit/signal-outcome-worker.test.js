'use strict';

const admin = require('firebase-admin');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

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
		remoteConfigService._resetForTesting();
		SignalOutcomeService.stopWorker();
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
	});

	afterEach(() => {
		SignalOutcomeService.stopWorker();
		jest.useRealTimers();
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
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

		it('starts the scheduler only for the configured process role', () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';

			expect(SignalOutcomeService.startWorker()).toBe(false);
			expect(SignalOutcomeService.getWorkerStatus()).toMatchObject({
				role: 'worker',
				running: false,
			});

			expect(SignalOutcomeService.startWorker({ source: 'worker' })).toBe(true);
			expect(SignalOutcomeService.getWorkerStatus().running).toBe(true);
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

		it('resumes from the last processed document when a sweep is aborted by deadline', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const docsMap = new Map();
			for (let i = 1; i <= 5; i++) {
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
							targetTime: new Date(Date.now() - 1000).toISOString(),
						},
					},
				});
			}

			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				docsMap
			);

			let callCount = 0;
			mockGetKlines.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve([[1600000000000, '50000', '51000', '49500', '50500', '100']]);
				} else if (callCount === 2) {
					const err = new Error('Signal outcome sweep deadline exceeded (50ms)');
					err.name = 'AbortError';
					return Promise.reject(err);
				}
				return Promise.resolve([[1600000000000, '50000', '51000', '49500', '50500', '100']]);
			});

			const sweep1 = await SignalOutcomeService.evaluatePendingOutcomes({ limit: 4, maxDurationMs: 50 });
			expect(sweep1.scannedCount).toBe(2);

			mockGetKlines.mockResolvedValue([
				[1600000000000, '50000', '51000', '49500', '50500', '100'],
			]);
			const sweep2 = await SignalOutcomeService.evaluatePendingOutcomes({ limit: 4 });
			expect(sweep2.scannedCount).toBe(4);
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
			expect(status.lastRunErrorCount).toBe(1);

			consoleSpy.mockRestore();
		});

		it('drains an active sweep before a dedicated worker stops', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';

			const receivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([[
					'drain-doc',
					{
						receivedAt: admin.firestore.Timestamp.fromDate(receivedAt),
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						side: 'BUY',
						price: 50000,
						outcomeEvaluated: false,
						outcomes: {
							'1h': { status: 'pending', targetTime: new Date(Date.now() - 1000).toISOString() },
						},
					},
				]]),
			);

			let resolveKlines;
			mockGetKlines.mockImplementation(() => new Promise((resolve) => {
				resolveKlines = resolve;
			}));

			SignalOutcomeService.startWorker({ source: 'worker', intervalMs: 300000, unref: false });
			await jest.advanceTimersByTimeAsync(0);
			expect(SignalOutcomeService.getWorkerStatus().isEvaluating).toBe(true);

			const stopPromise = SignalOutcomeService.stopWorker({ drain: true });
			expect(SignalOutcomeService.getWorkerStatus()).toMatchObject({
				shutdownRequested: true,
				running: false,
			});

			resolveKlines([[1600000000000, '50000', '51000', '49500', '50500', '100']]);
			await stopPromise;
			expect(SignalOutcomeService.getWorkerStatus().isEvaluating).toBe(false);
			const callsAfterDrain = mockGetKlines.mock.calls.length;
			await jest.advanceTimersByTimeAsync(300000);
			expect(mockGetKlines).toHaveBeenCalledTimes(callsAfterDrain);
		});

		it('persists safe worker heartbeat counters for cross-process inspection', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';

			SignalOutcomeService.startWorker({ source: 'worker', intervalMs: 300000, unref: false });
			await jest.advanceTimersByTimeAsync(0);

			const heartbeat = global.__firebaseAdminMockState.collections
				.get('workerHeartbeats')
				.get('signal-outcome');
			expect(heartbeat).toMatchObject({
				worker: 'signal-outcome',
				role: 'worker',
				enabled: true,
				running: true,
				lastRunScannedCount: 0,
				lastRunPendingCount: 0,
				lastRunErrorCount: 0,
			});
		});

		it('does not overwrite the shared heartbeat from a disabled scheduler process', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'disabled';
			const existingHeartbeat = {
				worker: 'signal-outcome',
				role: 'worker',
				running: true,
				lastRunScannedCount: 4,
			};
			global.__firebaseAdminMockState.collections.set(
				'workerHeartbeats',
				new Map([['signal-outcome', existingHeartbeat]]),
			);

			expect(SignalOutcomeService.startWorker({ source: 'web' })).toBe(false);
			await SignalOutcomeService.stopWorker();

			expect(global.__firebaseAdminMockState.collections.get('workerHeartbeats').get('signal-outcome'))
				.toEqual(existingHeartbeat);
		});

		it('bounds dedicated-worker drain when an in-flight Firestore update stalls', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';
			process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS = '50';
			const receivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([[
					'drain-timeout-doc',
					{
						receivedAt: admin.firestore.Timestamp.fromDate(receivedAt),
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						side: 'BUY',
						price: 50000,
						outcomeEvaluated: false,
						outcomes: {
							'1h': { status: 'pending', targetTime: new Date(Date.now() - 1000).toISOString() },
						},
					},
				]]),
			);
			admin.__mockDocUpdate.mockImplementationOnce(() => new Promise(() => {}));
			mockGetKlines.mockResolvedValue([[1600000000000, '50000', '51000', '49500', '50500', '100']]);

			SignalOutcomeService.startWorker({ source: 'worker', intervalMs: 300000, unref: false });
			await jest.advanceTimersByTimeAsync(0);
			expect(SignalOutcomeService.getWorkerStatus().isEvaluating).toBe(true);

			const stopPromise = SignalOutcomeService.stopWorker({ drain: true });
			await jest.advanceTimersByTimeAsync(50);
			await stopPromise;

			expect(SignalOutcomeService.getWorkerStatus().isEvaluating).toBe(false);
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

			it('falls back when interval is fractional or outside Node timer bounds', () => {
				process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

				process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '1500.5';
				SignalOutcomeService.startWorker();
				let status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '2147483648';
				SignalOutcomeService.startWorker();
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				delete process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS;
				SignalOutcomeService.startWorker({ intervalMs: 1500.5 });
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				SignalOutcomeService.startWorker({ intervalMs: 2147483648 });
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(300000);
				SignalOutcomeService.stopWorker();

				SignalOutcomeService.startWorker({ intervalMs: 2147483647 });
				status = SignalOutcomeService.getWorkerStatus();
				expect(status.intervalMs).toBe(2147483647);
				SignalOutcomeService.stopWorker();
			});

			it('preserves valid environment cadences above one hour', () => {
				process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
				process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '86400000';

				SignalOutcomeService.startWorker();

				expect(SignalOutcomeService.getWorkerStatus().intervalMs).toBe(86400000);
				SignalOutcomeService.stopWorker();
			});

			it('falls back when the sweep duration exceeds Node timer bounds', () => {
				process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
				process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS = '2147483648';

				const status = SignalOutcomeService.getWorkerStatus();

				expect(status.maxDurationMs).toBe(30000);
			});
		});

		it('keeps the startup cadence environment-only when Remote Config publishes the same key', () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '60000';
			remoteConfigService._setRemoteOverridesForTesting({
				SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS: 120000,
			});

			SignalOutcomeService.startWorker();

			expect(SignalOutcomeService.getWorkerStatus().intervalMs).toBe(60000);
		});
	});
});
