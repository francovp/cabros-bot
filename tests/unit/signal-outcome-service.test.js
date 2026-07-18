'use strict';

const admin = require('firebase-admin');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');

// Shorthand references to mock internals
const {
	__mockAdd: mockAdd,
	__mockCollection: mockCollection,
	__mockGet: mockGet,
	__mockDocGet: mockDocGet,
	__mockDocSet: mockDocSet,
	__mockDocUpdate: mockDocUpdate,
} = admin;

// Mock the binance client
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

describe('SignalOutcomeService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		admin.__resetApps();
		admin.__resetCollectionState();
		AlertStorageService._resetForTesting();
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
	});

	afterEach(() => {
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
	});

	describe('isEnabled()', () => {
		it('returns false when ENABLE_SHADOW_MODE_OUTCOME_TRACKING is not set', () => {
			expect(SignalOutcomeService.isEnabled()).toBe(false);
		});

		it('returns false when ENABLE_SHADOW_MODE_OUTCOME_TRACKING is "false"', () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'false';
			expect(SignalOutcomeService.isEnabled()).toBe(false);
		});

		it('returns true when ENABLE_SHADOW_MODE_OUTCOME_TRACKING is "true"', () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			expect(SignalOutcomeService.isEnabled()).toBe(true);
		});
	});

	describe('normalizeSide()', () => {
		it('normalizes various inputs to BUY or SELL', () => {
			expect(SignalOutcomeService.normalizeSide('buy')).toBe('BUY');
			expect(SignalOutcomeService.normalizeSide('compra')).toBe('BUY');
			expect(SignalOutcomeService.normalizeSide('bullish')).toBe('BUY');
			expect(SignalOutcomeService.normalizeSide('sell')).toBe('SELL');
			expect(SignalOutcomeService.normalizeSide('venta')).toBe('SELL');
			expect(SignalOutcomeService.normalizeSide('bearish')).toBe('SELL');
			expect(SignalOutcomeService.normalizeSide(null)).toBe('BUY');
		});
	});

	describe('normalizeSymbolAndExchange()', () => {
		it('splits exchange and symbol when colon present', () => {
			const res = SignalOutcomeService.normalizeSymbolAndExchange('BINANCE:BTCUSDT');
			expect(res.exchange).toBe('BINANCE');
			expect(res.symbol).toBe('BTCUSDT');
		});

		it('defaults exchange when colon is missing', () => {
			const res = SignalOutcomeService.normalizeSymbolAndExchange('BTCUSDT');
			expect(res.exchange).toBe('BINANCE');
			expect(res.symbol).toBe('BTCUSDT');
		});

		it('respects default exchange argument', () => {
			const res = SignalOutcomeService.normalizeSymbolAndExchange('BTCUSDT', 'COINBASE');
			expect(res.exchange).toBe('COINBASE');
			expect(res.symbol).toBe('BTCUSDT');
		});
	});

	describe('recordSignal()', () => {
		it('returns null when feature is disabled', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'false';
			const res = await SignalOutcomeService.recordSignal({ symbol: 'BTCUSDT', price: 50000 });
			expect(res).toBeNull();
		});

		it('saves a normalised document when only SHADOW_MODE_OUTCOME_TRACKING is enabled', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			// Intentionally NOT setting ENABLE_FIRESTORE_ALERT_STORAGE or ENABLE_FIRESTORE_JOB_STORAGE
			// to verify the fix for issue #155.

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'test-req-shadow-only',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
				side: 'BUY',
				score: 0.85,
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.requestId).toBe('test-req-shadow-only');
			expect(saved.source).toBe('market-scanner');
			expect(saved.price).toBe(50000);
			expect(saved.side).toBe('BUY');
		});

		it('saves a normalised document when enabled with both flags', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'test-req',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
				side: 'BUY',
				score: 0.85,
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.requestId).toBe('test-req');
			expect(saved.source).toBe('market-scanner');
			expect(saved.symbol).toBe('BTCUSDT');
			expect(saved.exchange).toBe('BINANCE');
			expect(saved.side).toBe('BUY');
			expect(saved.price).toBe(50000);
			expect(saved.score).toBe(0.85);
			expect(saved.outcomeEvaluated).toBe(false);
			expect(saved.outcomes['1h']).toBeDefined();
			expect(saved.outcomes['1h'].status).toBe('pending');
		});
	});

	describe('evaluatePendingOutcomes()', () => {
		it('evaluates pending outcomes using mocked klines', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			// Mock a timestamp in the past for receivedAt
			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
			const outcomes = {
				'1h': {
					status: 'pending',
					targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
					price: null,
					return: null,
				},
				'4h': {
					status: 'pending',
					// target time in the future, should remain pending
					targetTime: new Date(receivedAtDate.getTime() + 4 * 60 * 60 * 1000).toISOString(),
					price: null,
					return: null,
				},
			};

			const mockDocId = 'test-doc-1';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-1',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes,
				}],
			]));

			// Mock getKlines return value: open, high, low, close
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), "50000", "52000", "49000", "51000"],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].price).toBe(51000);
			expect(updated.outcomes['1h'].return).toBe(2); // ((51000-50000)/50000)*100
			expect(updated.outcomes['1h'].maxFavorableExcursion).toBe(4); // ((52000-50000)/50000)*100
			expect(updated.outcomes['1h'].maxAdverseExcursion).toBe(-2); // ((49000-50000)/50000)*100

			// 4h window should still be pending since targetTime is in the future
			expect(updated.outcomes['4h'].status).toBe('pending');
			expect(updated.outcomeEvaluated).toBe(false);
		});

		it('marks outcomes as unavailable for non-Binance symbols', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
			const outcomes = {
				'1h': {
					status: 'pending',
					targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
				},
			};

			const mockDocId = 'test-doc-2';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-2',
					source: 'expanded-analysis',
					symbol: 'AAPL',
					exchange: 'NASDAQ',
					side: 'BUY',
					price: 150,
					outcomeEvaluated: false,
					outcomes,
				}],
			]));

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('unavailable');
			expect(updated.outcomeEvaluated).toBe(true); // only 1 window and it's resolved/unavailable
		});
	});

	describe('getMetricsSummary()', () => {
		it('returns "No measurements found" when no evaluated outcomes exist', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).toBe('No measurements found');
		});

		it('computes correct aggregate metrics when evaluated outcomes exist', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const mockDocId = 'evaluated-doc-1';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(new Date()),
					requestId: 'req-3',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					score: 0.8,
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: new Date().toISOString(),
							price: 51000,
							return: 2.0,
							maxFavorableExcursion: 3.0,
							maxAdverseExcursion: -1.0,
						},
						'4h': {
							status: 'pending',
							targetTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).not.toBe('No measurements found');
			expect(res.totalSignalsEvaluated).toBe(1);
			expect(res.windows['1h']).toBeDefined();
			expect(res.windows['1h'].hitRatePercent).toBe(100);
			expect(res.windows['1h'].averageReturnPercent).toBe(2);
			expect(res.windows['1h'].averageMfePercent).toBe(3);
			expect(res.windows['1h'].averageMaePercent).toBe(-1);
			expect(res.drawdownProxy.averageMaxAdverseExcursionPercent).toBe(-1);
		});
	});
});
