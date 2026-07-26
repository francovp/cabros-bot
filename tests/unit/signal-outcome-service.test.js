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
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
	});

	afterEach(() => {
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
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

		it('returns true when ENABLE_SIGNAL_OUTCOME_TRACKING is "true"', () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
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

		it('records a signal when only ENABLE_SIGNAL_OUTCOME_TRACKING is enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'test-req-signal-tracking',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
			});

			expect(resId).not.toBeNull();
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
		it('returns "No measurements found" when snapshot is empty', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).toBe('No measurements found');
		});

		it('computes correct aggregate metrics and coverage metadata when evaluated outcomes exist', async () => {
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
			expect(res.totalSignalsReceived).toBe(1);
			expect(res.totalSignalsEligible).toBe(1);
			expect(res.totalSignalsEvaluated).toBe(1);
			expect(res.windows['1h']).toBeDefined();
			expect(res.windows['1h'].hitRatePercent).toBe(100);
			expect(res.windows['1h'].averageReturnPercent).toBe(2);
			expect(res.windows['1h'].averageMfePercent).toBe(3);
			expect(res.windows['1h'].averageMaePercent).toBe(-1);
			expect(res.drawdownProxy.averageMaxAdverseExcursionPercent).toBe(-1);
			expect(res.exchangeBreakdown.BINANCE).toBeDefined();
			expect(res.exchangeBreakdown.BINANCE.received).toBe(1);
			expect(res.exchangeBreakdown.BINANCE.evaluated).toBe(1);
		});

		it('reports non-Binance and missing-entry signals with explicit coverage metadata instead of "No measurements found"', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['doc-bats', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-bats',
					source: 'alert',
					symbol: 'AAPL',
					exchange: 'BATS',
					side: 'BUY',
					price: 150,
					eligibilityState: 'unsupported_exchange',
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'unavailable', reason: 'unsupported_exchange' },
					},
				}],
				['doc-spcfd', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-spcfd',
					source: 'alert',
					symbol: 'SPX',
					exchange: 'SPCFD',
					side: 'BUY',
					price: 4500,
					eligibilityState: 'unsupported_exchange',
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'unavailable', reason: 'unsupported_exchange' },
					},
				}],
				['doc-noprice', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-noprice',
					source: 'alert',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: null,
					eligibilityState: 'missing_entry_price',
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'unavailable', reason: 'missing_entry_price' },
					},
				}],
			]));

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).not.toBe('No measurements found');
			expect(res.totalSignalsReceived).toBe(3);
			expect(res.totalSignalsEvaluated).toBe(0);
			expect(res.totalSignalsUnavailable).toBe(3);
			expect(res.coveragePercent).toBe(0);
			expect(res.exchangeBreakdown.BATS.received).toBe(1);
			expect(res.exchangeBreakdown.SPCFD.received).toBe(1);
			expect(res.exchangeBreakdown.BINANCE.received).toBe(1);
			expect(res.eligibilityBreakdown.unsupported_exchange).toBe(2);
			expect(res.eligibilityBreakdown.missing_entry_price).toBe(1);
		});

		it('reconciles observed 54-alert mix fixture with exact exchange breakdown', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			const map = new Map();

			// 18 Binance signals
			for (let i = 1; i <= 18; i++) {
				map.set(`binance-${i}`, {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: `req-binance-${i}`,
					source: 'alert',
					symbol: `CRYPTO${i}USDT`,
					exchange: 'BINANCE',
					side: 'BUY',
					price: 100 + i,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 105 + i,
							return: 5.0,
							maxFavorableExcursion: 6.0,
							maxAdverseExcursion: -1.0,
						},
					},
				});
			}

			// 33 BATS signals
			for (let i = 1; i <= 33; i++) {
				map.set(`bats-${i}`, {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: `req-bats-${i}`,
					source: 'alert',
					symbol: `STOCK${i}`,
					exchange: 'BATS',
					side: 'BUY',
					price: 50 + i,
					eligibilityState: 'unsupported_exchange',
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'unavailable', reason: 'unsupported_exchange' },
					},
				});
			}

			// 1 SPCFD signal
			map.set('spcfd-1', {
				receivedAt: admin.firestore.Timestamp.fromDate(now),
				requestId: 'req-spcfd-1',
				source: 'alert',
				symbol: 'SPX',
				exchange: 'SPCFD',
				side: 'BUY',
				price: 5000,
				eligibilityState: 'unsupported_exchange',
				outcomeEvaluated: true,
				outcomes: {
					'1h': { status: 'unavailable', reason: 'unsupported_exchange' },
				},
			});

			// 2 UNKNOWN / unparseable signals
			for (let i = 1; i <= 2; i++) {
				map.set(`unknown-${i}`, {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: `req-unknown-${i}`,
					source: 'alert',
					symbol: 'UNKNOWN',
					exchange: 'UNKNOWN',
					side: 'BUY',
					price: null,
					eligibilityState: 'unparseable_symbol',
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'unavailable', reason: 'unparseable_symbol' },
					},
				});
			}

			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, map);

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).not.toBe('No measurements found');
			expect(res.totalSignalsReceived).toBe(54);
			expect(res.totalSignalsEligible).toBe(18);
			expect(res.totalSignalsEvaluated).toBe(18);
			expect(res.totalSignalsUnavailable).toBe(36);
			expect(res.coveragePercent).toBe(33.33);

			expect(res.exchangeBreakdown.BINANCE.received).toBe(18);
			expect(res.exchangeBreakdown.BINANCE.eligible).toBe(18);
			expect(res.exchangeBreakdown.BINANCE.evaluated).toBe(18);

			expect(res.exchangeBreakdown.BATS.received).toBe(33);
			expect(res.exchangeBreakdown.BATS.eligible).toBe(0);
			expect(res.exchangeBreakdown.BATS.unavailable).toBe(33);

			expect(res.exchangeBreakdown.SPCFD.received).toBe(1);
			expect(res.exchangeBreakdown.SPCFD.eligible).toBe(0);

			expect(res.exchangeBreakdown.UNKNOWN.received).toBe(2);
			expect(res.exchangeBreakdown.UNKNOWN.eligible).toBe(0);

			expect(res.eligibilityBreakdown.supported_provider).toBe(18);
			expect(res.eligibilityBreakdown.unsupported_exchange).toBe(34); // 33 BATS + 1 SPCFD
			expect(res.eligibilityBreakdown.unparseable_symbol).toBe(2);
		});
	});
});
