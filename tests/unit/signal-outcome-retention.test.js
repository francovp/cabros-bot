'use strict';

const admin = require('firebase-admin');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
const RemoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('SignalOutcomeService Retention and TTL', () => {
	let warnSpy;

	beforeEach(() => {
		jest.clearAllMocks();
		admin.__resetApps();
		admin.__resetCollectionState();
		AlertStorageService._resetForTesting();
		RemoteConfigService._resetForTesting();
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.SIGNAL_OUTCOME_RETENTION_DAYS;
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.SIGNAL_OUTCOME_RETENTION_DAYS;
	});

	describe('retention configuration and parsing', () => {
		it('defaults to 365 days when SIGNAL_OUTCOME_RETENTION_DAYS is not set', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const baseDate = new Date('2026-08-01T00:00:00.000Z');
			jest.useFakeTimers().setSystemTime(baseDate);

			const id = await SignalOutcomeService.recordSignal({
				requestId: 'req-retention-default',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
			});

			expect(id).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(id);
			expect(saved).toBeDefined();
			expect(saved.expiresAt).toBeDefined();
			expect(saved.expiresAt.toDate().toISOString()).toBe(
				new Date(baseDate.getTime() + (365 * DAY_MS)).toISOString(),
			);
			expect(warnSpy).not.toHaveBeenCalled();

			jest.useRealTimers();
		});

		it('uses configured valid SIGNAL_OUTCOME_RETENTION_DAYS', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.SIGNAL_OUTCOME_RETENTION_DAYS = '90';
			const baseDate = new Date('2026-08-01T00:00:00.000Z');
			jest.useFakeTimers().setSystemTime(baseDate);

			const id = await SignalOutcomeService.recordSignal({
				requestId: 'req-retention-90',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
			});

			expect(id).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(id);
			expect(saved.expiresAt.toDate().toISOString()).toBe(
				new Date(baseDate.getTime() + (90 * DAY_MS)).toISOString(),
			);

			jest.useRealTimers();
		});

		it('falls back to 365 days and logs a single warning when SIGNAL_OUTCOME_RETENTION_DAYS is invalid', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.SIGNAL_OUTCOME_RETENTION_DAYS = 'invalid-days';
			const baseDate = new Date('2026-08-01T00:00:00.000Z');
			jest.useFakeTimers().setSystemTime(baseDate);

			const id1 = await SignalOutcomeService.recordSignal({
				requestId: 'req-retention-invalid-1',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
			});
			const id2 = await SignalOutcomeService.recordSignal({
				requestId: 'req-retention-invalid-2',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
			});

			expect(id1).not.toBeNull();
			expect(id2).not.toBeNull();
			const saved1 = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(id1);
			expect(saved1.expiresAt.toDate().toISOString()).toBe(
				new Date(baseDate.getTime() + (365 * DAY_MS)).toISOString(),
			);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('Invalid SIGNAL_OUTCOME_RETENTION_DAYS configuration, using default'),
			);

			jest.useRealTimers();
		});

		it('falls back to 365 days for out-of-bounds numbers (< 1 or > 3650)', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const baseDate = new Date('2026-08-01T00:00:00.000Z');
			jest.useFakeTimers().setSystemTime(baseDate);

			for (const invalidValue of ['0', '-10', '3651', '10000', '1.5']) {
				process.env.SIGNAL_OUTCOME_RETENTION_DAYS = invalidValue;
				const id = await SignalOutcomeService.recordSignal({
					requestId: `req-retention-bound-${invalidValue}`,
					source: 'market-scanner',
					symbol: 'BINANCE:BTCUSDT',
					price: 50000,
				});
				const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(id);
				expect(saved.expiresAt.toDate().toISOString()).toBe(
					new Date(baseDate.getTime() + (365 * DAY_MS)).toISOString(),
				);
			}

			jest.useRealTimers();
		});
	});

	describe('query filtering for retention-expired documents', () => {
		it('excludes retention-expired documents with explicit expiresAt in listOutcomes', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const now = new Date('2026-08-01T12:00:00.000Z');
			jest.useFakeTimers().setSystemTime(now);

			const activeDoc = {
				requestId: 'active-req',
				source: 'market-scanner',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				price: 50000,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-01T10:00:00.000Z')),
				expiresAt: admin.firestore.Timestamp.fromDate(new Date('2027-08-01T10:00:00.000Z')),
				outcomeEvaluated: true,
				outcomes: {},
			};

			const expiredDoc = {
				requestId: 'expired-req',
				source: 'market-scanner',
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				price: 3000,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date('2025-01-01T10:00:00.000Z')),
				expiresAt: admin.firestore.Timestamp.fromDate(new Date('2026-01-01T10:00:00.000Z')), // past
				outcomeEvaluated: true,
				outcomes: {},
			};

			const firestore = AlertStorageService.getFirestore();
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('active-id').set(activeDoc);
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('expired-id').set(expiredDoc);

			const result = await SignalOutcomeService.listOutcomes({ limit: 10 });
			expect(result.outcomes).toHaveLength(1);
			expect(result.outcomes[0].requestId).toBe('active-req');

			jest.useRealTimers();
		});

		it('excludes legacy retention-expired documents missing expiresAt in listOutcomes', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.SIGNAL_OUTCOME_RETENTION_DAYS = '365';
			const now = new Date('2026-08-01T12:00:00.000Z');
			jest.useFakeTimers().setSystemTime(now);

			// Legacy doc without expiresAt, received 400 days ago (> 365 days retention)
			const legacyExpiredDoc = {
				requestId: 'legacy-expired-req',
				source: 'market-scanner',
				symbol: 'SOLUSDT',
				exchange: 'BINANCE',
				price: 150,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() - (400 * DAY_MS))),
				outcomeEvaluated: true,
				outcomes: {},
			};

			// Legacy doc without expiresAt, received 30 days ago (< 365 days retention)
			const legacyActiveDoc = {
				requestId: 'legacy-active-req',
				source: 'market-scanner',
				symbol: 'ADAUSDT',
				exchange: 'BINANCE',
				price: 0.5,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() - (30 * DAY_MS))),
				outcomeEvaluated: true,
				outcomes: {},
			};

			const firestore = AlertStorageService.getFirestore();
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('legacy-expired-id').set(legacyExpiredDoc);
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('legacy-active-id').set(legacyActiveDoc);

			const result = await SignalOutcomeService.listOutcomes({ limit: 10 });
			expect(result.outcomes).toHaveLength(1);
			expect(result.outcomes[0].requestId).toBe('legacy-active-req');

			jest.useRealTimers();
		});

		it('excludes retention-expired documents in summarizeOutcomes', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const now = new Date('2026-08-01T12:00:00.000Z');
			jest.useFakeTimers().setSystemTime(now);

			const activeDoc = {
				requestId: 'active-req',
				source: 'market-scanner',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				price: 50000,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-01T10:00:00.000Z')),
				expiresAt: admin.firestore.Timestamp.fromDate(new Date('2027-08-01T10:00:00.000Z')),
				outcomeEvaluated: true,
				eligibilityState: 'supported_provider',
				outcomes: {
					'1h': {
						status: 'evaluated',
						price: 51000,
						return: 2.0,
						targetTime: new Date('2026-08-01T11:00:00.000Z').toISOString(),
					},
				},
			};

			const expiredDoc = {
				requestId: 'expired-req',
				source: 'market-scanner',
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				price: 3000,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date('2025-01-01T10:00:00.000Z')),
				expiresAt: admin.firestore.Timestamp.fromDate(new Date('2026-01-01T10:00:00.000Z')),
				outcomeEvaluated: true,
				eligibilityState: 'supported_provider',
				outcomes: {
					'1h': {
						status: 'evaluated',
						price: 2900,
						return: -3.3,
						targetTime: new Date('2025-01-01T11:00:00.000Z').toISOString(),
					},
				},
			};

			const firestore = AlertStorageService.getFirestore();
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('active-id').set(activeDoc);
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('expired-id').set(expiredDoc);

			const summary = await SignalOutcomeService.summarizeOutcomes({});
			expect(summary.totalSignalsReceived).toBe(1);
			expect(summary.totalSignalsEvaluated).toBe(1);

			jest.useRealTimers();
		});

		it('advances evaluation sweep cursor past expired pending documents to prevent starvation', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT = '1';
			const now = new Date('2026-08-01T12:00:00.000Z');
			jest.useFakeTimers().setSystemTime(now);

			SignalOutcomeService._resetForTesting();

			// First doc: expired pending doc
			const expiredPendingDoc = {
				requestId: 'expired-pending',
				source: 'market-scanner',
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				price: 3000,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date('2025-01-01T10:00:00.000Z')),
				expiresAt: admin.firestore.Timestamp.fromDate(new Date('2026-01-01T10:00:00.000Z')),
				outcomeEvaluated: false,
				outcomes: {
					'1h': {
						status: 'pending',
						targetTime: new Date('2025-01-01T11:00:00.000Z').toISOString(),
					},
				},
			};

			// Second doc: active unparseable doc that resolves to unavailable when evaluated
			const activePendingDoc = {
				requestId: 'active-pending',
				source: 'market-scanner',
				symbol: 'UNPARSEABLE',
				exchange: 'UNKNOWN',
				price: null,
				side: 'BUY',
				receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-01T10:00:00.000Z')),
				expiresAt: admin.firestore.Timestamp.fromDate(new Date('2027-08-01T10:00:00.000Z')),
				outcomeEvaluated: false,
				outcomes: {
					'1h': {
						status: 'pending',
						targetTime: new Date('2026-08-01T11:00:00.000Z').toISOString(),
					},
				},
			};

			const firestore = AlertStorageService.getFirestore();
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('doc-1-expired').set(expiredPendingDoc);
			await firestore.collection(SignalOutcomeService.COLLECTION_NAME).doc('doc-2-active').set(activePendingDoc);

			// First sweep processes doc-1-expired, advances cursor, but does not evaluate it
			const sweep1 = await SignalOutcomeService.evaluatePendingOutcomes();
			expect(sweep1.scannedCount).toBe(1);
			expect(sweep1.evaluatedCount).toBe(0);

			// Second sweep starts after doc-1-expired, fetching doc-2-active and evaluating it
			const sweep2 = await SignalOutcomeService.evaluatePendingOutcomes();
			expect(sweep2.scannedCount).toBe(1);
			expect(sweep2.evaluatedCount).toBe(1);

			jest.useRealTimers();
		});
	});
});

