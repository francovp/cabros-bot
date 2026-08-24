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
const mockGetAvgPrice = jest.fn();
jest.mock('binance', () => {
	return {
		MainClient: jest.fn().mockImplementation(() => {
			return {
				getKlines: mockGetKlines,
				getAvgPrice: mockGetAvgPrice,
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
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_EQUITY_MARKET_DATA;
		delete process.env.EQUITY_MARKET_DATA_PROVIDER;
		delete process.env.TWELVE_DATA_API_KEY;
		delete process.env.TWELVE_DATA_BASE_URL;
		delete process.env.EQUITY_MARKET_DATA_TIMEOUT_MS;
	});

	afterEach(() => {
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_EQUITY_MARKET_DATA;
		delete process.env.EQUITY_MARKET_DATA_PROVIDER;
		delete process.env.TWELVE_DATA_API_KEY;
		delete process.env.TWELVE_DATA_BASE_URL;
		delete process.env.EQUITY_MARKET_DATA_TIMEOUT_MS;
	});

	describe('isEnabled()', () => {
		it('returns false when ENABLE_SIGNAL_OUTCOME_TRACKING is not set', () => {
			expect(SignalOutcomeService.isEnabled()).toBe(false);
		});

		it('returns false when ENABLE_SIGNAL_OUTCOME_TRACKING is "false"', () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'false';
			expect(SignalOutcomeService.isEnabled()).toBe(false);
		});

		it('returns false when only retired ENABLE_SHADOW_MODE_OUTCOME_TRACKING is "true"', () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			expect(SignalOutcomeService.isEnabled()).toBe(false);
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

		it('strips parenthetical timeframe suffixes from symbol', () => {
			expect(SignalOutcomeService.normalizeSymbolAndExchange('FX_IDC:USDCLP(D)')).toEqual({
				exchange: 'FX_IDC',
				symbol: 'USDCLP',
			});
			expect(SignalOutcomeService.normalizeSymbolAndExchange('SPCFD:SPX(D)')).toEqual({
				exchange: 'SPCFD',
				symbol: 'SPX',
			});
			expect(SignalOutcomeService.normalizeSymbolAndExchange('NASDAQ_DLY:NDX(D)')).toEqual({
				exchange: 'NASDAQ_DLY',
				symbol: 'NDX',
			});
			expect(SignalOutcomeService.normalizeSymbolAndExchange('BTCUSDT(1h)')).toEqual({
				exchange: 'BINANCE',
				symbol: 'BTCUSDT',
			});
		});
	});

	describe('recordSignal()', () => {
		it('returns null when feature is disabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'false';
			const res = await SignalOutcomeService.recordSignal({ symbol: 'BTCUSDT', price: 50000 });
			expect(res).toBeNull();
		});

		it('records a signal when ENABLE_SIGNAL_OUTCOME_TRACKING is enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'test-req-signal-tracking',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
			});

			expect(resId).not.toBeNull();
		});

		it('saves a normalised document when only ENABLE_SIGNAL_OUTCOME_TRACKING is enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			// Intentionally NOT setting ENABLE_FIRESTORE_ALERT_STORAGE or ENABLE_FIRESTORE_JOB_STORAGE
			// to verify the fix for issue #155.

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'test-req-signal-only',
				source: 'market-scanner',
				symbol: 'BINANCE:BTCUSDT',
				price: 50000,
				side: 'BUY',
				score: 0.85,
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.requestId).toBe('test-req-signal-only');
			expect(saved.source).toBe('market-scanner');
			expect(saved.price).toBe(50000);
			expect(saved.side).toBe('BUY');
		});

		it('saves a normalised document when enabled with alert storage', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
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

		it('resolves a configured equity entry price without using Binance', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
			process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
			process.env.TWELVE_DATA_API_KEY = 'test-twelve-data-key';
			const originalFetch = global.fetch;
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					status: 'ok',
					symbol: 'AAPL',
					exchange: 'NASDAQ',
					close: '150.25',
				}),
			});
			global.fetch = mockFetch;

			try {
				const resId = await SignalOutcomeService.recordSignal({
					symbol: 'NASDAQ:AAPL',
					price: null,
				});

				const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
				expect(saved.price).toBe(150.25);
				expect(saved.marketDataProvider).toBe('twelve-data');
				expect(saved.eligibilityState).toBe('supported_provider');
				expect(saved.outcomeEvaluated).toBe(false);
				expect(global.fetch).toHaveBeenCalledTimes(1);
			} finally {
				global.fetch = originalFetch;
			}
		});

		it('uses the configured provider for a classified bare stock without inventing an exchange', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
			process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
			process.env.TWELVE_DATA_API_KEY = 'test-twelve-data-key';
			const originalFetch = global.fetch;
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '150.25' }),
			});
			global.fetch = mockFetch;

			try {
				const resId = await SignalOutcomeService.recordSignal({
					symbol: 'AAPL',
					exchange: 'UNKNOWN',
					assetClass: 'stock',
					price: null,
				});

				const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
				expect(saved.exchange).toBe('UNKNOWN');
				expect(saved.assetClass).toBe('stock');
				expect(saved.marketDataProvider).toBe('twelve-data');
				expect(saved.eligibilityState).toBe('supported_provider');
				expect(new URL(mockFetch.mock.calls[0][0]).searchParams.has('exchange')).toBe(false);
			} finally {
				global.fetch = originalFetch;
			}
		});

		it('resolves configured equity entry prices for NYSE and AMEX signals', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
			process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
			process.env.TWELVE_DATA_API_KEY = 'test-twelve-data-key';
			const originalFetch = global.fetch;
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					status: 'ok',
					symbol: 'TSM',
					exchange: 'NYSE',
					close: '175.50',
				}),
			});
			global.fetch = mockFetch;

			try {
				const nyseId = await SignalOutcomeService.recordSignal({
					symbol: 'NYSE:TSM',
					price: null,
				});

				const nyseSaved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(nyseId);
				expect(nyseSaved.symbol).toBe('TSM');
				expect(nyseSaved.exchange).toBe('NYSE');
				expect(nyseSaved.price).toBe(175.50);
				expect(nyseSaved.marketDataProvider).toBe('twelve-data');
				expect(nyseSaved.eligibilityState).toBe('supported_provider');

				const amexId = await SignalOutcomeService.recordSignal({
					symbol: 'AMEX:SPY',
					price: null,
				});

				const amexSaved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(amexId);
				expect(amexSaved.symbol).toBe('SPY');
				expect(amexSaved.exchange).toBe('AMEX');
				expect(amexSaved.marketDataProvider).toBe('twelve-data');
				expect(amexSaved.eligibilityState).toBe('supported_provider');
			} finally {
				global.fetch = originalFetch;
			}
		});

		it('persists explicit priceSource over the BINANCE tradingview-mcp default', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			mockGetAvgPrice.mockResolvedValue({ price: '12345.67' });

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-explicit-binance-source',
				source: 'news-monitor',
				symbol: 'BINANCE:BTCUSDT',
				price: 64863.03,
				priceSource: 'binance',
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockGetAvgPrice).not.toHaveBeenCalled();

			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.price).toBe(64863.03);
			expect(saved.entryPriceSource).toBe('binance');
			expect(saved.eligibilityState).toBe('supported_provider');
		});

		it('reuses structured MCP entry price without calling Binance getAvgPrice', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			mockGetAvgPrice.mockResolvedValue({ price: '12345.67' });

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-mcp-price',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: 64863.03,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockGetAvgPrice).not.toHaveBeenCalled();

			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.price).toBe(64863.03);
			expect(saved.entryPriceSource).toBe('tradingview-mcp');
			expect(saved.eligibilityState).toBe('supported_provider');
			expect(saved.outcomeEvaluated).toBe(false);
		});

		it('falls back to Binance getAvgPrice when price is null, zero, negative, or invalid', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			mockGetAvgPrice.mockResolvedValue({ price: '68100.50' });

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-fallback-price',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockGetAvgPrice).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });

			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.price).toBe(68100.50);
			expect(saved.entryPriceSource).toBe('binance');
			expect(saved.eligibilityState).toBe('supported_provider');
		});

		it('fails open when Binance getAvgPrice throws due to region block', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			mockGetAvgPrice.mockRejectedValue(new Error('Binance 451: Service unavailable from restricted location'));

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-region-blocked',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.price).toBeNull();
			expect(saved.entryPriceSource).toBeNull();
			expect(saved.eligibilityState).toBe('pending_entry_price');
			expect(saved.outcomeEvaluated).toBe(false);
			expect(saved.outcomes['1h'].status).toBe('pending');
		});

		it('marks signal immediately unavailable when Binance getAvgPrice throws structural invalid symbol error', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			mockGetAvgPrice.mockRejectedValue(new Error('Binance 400: Invalid symbol'));

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-invalid-symbol',
				source: 'webhook-alert',
				symbol: 'BINANCE:INVALID',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.price).toBeNull();
			expect(saved.entryPriceSource).toBeNull();
			expect(saved.eligibilityState).toBe('missing_entry_price');
			expect(saved.outcomeEvaluated).toBe(true);
			expect(saved.outcomes['1h'].status).toBe('unavailable');
		});

		it('records and resolves entry price for FX_IDC, SPCFD, and NASDAQ_DLY signals when equity market data is enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
			process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
			process.env.TWELVE_DATA_API_KEY = 'test-twelve-key';

			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '950.25' }),
			});

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-fx-test',
				source: 'webhook-alert',
				symbol: 'FX_IDC:USDCLP(D)',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.exchange).toBe('FX_IDC');
			expect(saved.symbol).toBe('USDCLP');
			expect(saved.price).toBe(950.25);
			expect(saved.entryPriceSource).toBe('twelve-data');
			expect(saved.eligibilityState).toBe('supported_provider');
			expect(saved.outcomeEvaluated).toBe(false);
		});

		it('marks FX_IDC signals as twelve_data_not_configured when equity market data is not enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'false';

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-fx-disabled',
				source: 'webhook-alert',
				symbol: 'FX_IDC:USDCLP(D)',
				price: 950.25,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.exchange).toBe('FX_IDC');
			expect(saved.symbol).toBe('USDCLP');
			expect(saved.eligibilityState).toBe('twelve_data_not_configured');
			expect(saved.outcomeEvaluated).toBe(true);
		});

		it('sanitizes undefined properties to prevent Firestore serialization errors', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-sanitize-check',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: 65000,
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();

			const checkNoUndefined = (obj, path = '') => {
				for (const [key, value] of Object.entries(obj)) {
					const currentPath = path ? `${path}.${key}` : key;
					expect(value).not.toBeUndefined();
					if (value && typeof value === 'object' && typeof value.toDate !== 'function') {
						checkNoUndefined(value, currentPath);
					}
				}
			};

			checkNoUndefined(saved);
		});
	});

	describe('evaluatePendingOutcomes()', () => {
		it('evaluates pending outcomes using mocked klines', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
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

		it('evaluates BUY signal with TP hit first chronologically', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-tp-first-buy';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-tp-buy',
					source: 'market-scanner',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					stop: 48000,
					target: 55000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// Bar 1: hits target (high 56000 >= 55000)
			// Bar 2: subsequent drop (low 47000 <= 48000) after target hit
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '50000', '56000', '49500', '55500'],
				[receivedAtDate.getTime() + 1800000, '55500', '55500', '47000', '47500'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].firstHit).toBe('target');
			expect(updated.outcomes['1h'].targetHit).toBe(true);
			expect(updated.outcomes['1h'].stopHit).toBe(false);
			expect(updated.outcomes['1h'].price).toBe(55000);
			expect(updated.outcomes['1h'].return).toBe(10); // ((55000-50000)/50000)*100
			expect(updated.outcomes['1h'].rMultiple).toBe(2.5); // (55000-50000)/(50000-48000) = 5000/2000 = 2.5
			expect(updated.outcomes['1h'].firstHitTime).toBe(new Date(receivedAtDate.getTime()).toISOString());
		});

		it('evaluates BUY signal with SL hit first chronologically despite later price recovery', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-sl-first-buy';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-sl-buy',
					source: 'market-scanner',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					stop: 48000,
					target: 55000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// Bar 1: hits stop (low 47000 <= 48000)
			// Bar 2: bounces to target (high 56000 >= 55000)
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '50000', '51000', '47000', '47500'],
				[receivedAtDate.getTime() + 1800000, '47500', '56000', '47500', '55500'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].firstHit).toBe('stop');
			expect(updated.outcomes['1h'].stopHit).toBe(true);
			expect(updated.outcomes['1h'].targetHit).toBe(false);
			expect(updated.outcomes['1h'].price).toBe(48000);
			expect(updated.outcomes['1h'].return).toBe(-4); // ((48000-50000)/50000)*100
			expect(updated.outcomes['1h'].rMultiple).toBe(-1); // (48000-50000)/(50000-48000) = -2000/2000 = -1.0
			expect(updated.outcomes['1h'].firstHitTime).toBe(new Date(receivedAtDate.getTime()).toISOString());
		});

		it('evaluates SELL signal with TP hit first chronologically', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-tp-first-sell';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-tp-sell',
					source: 'market-scanner',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'SELL',
					price: 50000,
					stop: 52000,
					target: 45000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// Bar 1: drops to target (low 44000 <= 45000)
			// Bar 2: rallies to stop (high 53000 >= 52000) after TP hit
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '50000', '50500', '44000', '44500'],
				[receivedAtDate.getTime() + 1800000, '44500', '53000', '44000', '52500'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].firstHit).toBe('target');
			expect(updated.outcomes['1h'].targetHit).toBe(true);
			expect(updated.outcomes['1h'].stopHit).toBe(false);
			expect(updated.outcomes['1h'].price).toBe(45000);
			expect(updated.outcomes['1h'].return).toBe(10); // ((50000-45000)/50000)*100
			expect(updated.outcomes['1h'].rMultiple).toBe(2.5); // (50000-45000)/(52000-50000) = 5000/2000 = 2.5
			expect(updated.outcomes['1h'].firstHitTime).toBe(new Date(receivedAtDate.getTime()).toISOString());
		});

		it('evaluates SELL signal with SL hit first chronologically despite later price drop', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-sl-first-sell';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-sl-sell',
					source: 'market-scanner',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'SELL',
					price: 50000,
					stop: 52000,
					target: 45000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// Bar 1: rallies to stop (high 53000 >= 52000)
			// Bar 2: crashes to target (low 44000 <= 45000)
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '50000', '53000', '49500', '52500'],
				[receivedAtDate.getTime() + 1800000, '52500', '52500', '44000', '44500'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].firstHit).toBe('stop');
			expect(updated.outcomes['1h'].stopHit).toBe(true);
			expect(updated.outcomes['1h'].targetHit).toBe(false);
			expect(updated.outcomes['1h'].price).toBe(52000);
			expect(updated.outcomes['1h'].return).toBe(-4); // ((50000-52000)/50000)*100
			expect(updated.outcomes['1h'].rMultiple).toBe(-1); // (50000-52000)/(52000-50000) = -2000/2000 = -1.0
			expect(updated.outcomes['1h'].firstHitTime).toBe(new Date(receivedAtDate.getTime()).toISOString());
		});

		it('applies conservative stop-loss priority when both barriers are breached in the same bar', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-both-breached-buy';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-both-buy',
					source: 'market-scanner',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					stop: 48000,
					target: 55000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// Bar 1 has high 56000 (target breached) AND low 47000 (stop breached)
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '50000', '56000', '47000', '52000'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].firstHit).toBe('stop');
			expect(updated.outcomes['1h'].stopHit).toBe(true);
			expect(updated.outcomes['1h'].targetHit).toBe(false);
			expect(updated.outcomes['1h'].price).toBe(48000);
			expect(updated.outcomes['1h'].return).toBe(-4);
		});

		it('evaluates signal when neither stop nor target is reached', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-neither-hit';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-neither',
					source: 'market-scanner',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					stop: 45000,
					target: 60000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '50000', '52000', '49000', '51000'],
				[receivedAtDate.getTime() + 1800000, '51000', '53000', '50000', '52000'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].firstHit).toBeNull();
			expect(updated.outcomes['1h'].stopHit).toBe(false);
			expect(updated.outcomes['1h'].targetHit).toBe(false);
			expect(updated.outcomes['1h'].price).toBe(52000);
			expect(updated.outcomes['1h'].return).toBe(4); // ((52000-50000)/50000)*100
			expect(updated.outcomes['1h'].rMultiple).toBe(0.4); // (52000-50000)/(50000-45000) = 2000/5000 = 0.4
			expect(updated.outcomes['1h'].firstHitTime).toBeNull();
		});

		it('marks outcomes as unavailable for non-Binance symbols', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
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

		it('evaluates configured equity outcomes through the provider adapter', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
			process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
			process.env.TWELVE_DATA_API_KEY = 'test-twelve-data-key';

			const receivedAtDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
			const mockDocId = 'test-doc-equity';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-equity',
					source: 'expanded-analysis',
					symbol: 'TSM',
					exchange: 'BATS',
					timeframe: '1D',
					side: 'BUY',
					price: 100,
					marketDataProvider: 'twelve-data',
					outcomeEvaluated: false,
					outcomes: {
						'1D': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 24 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			const originalFetch = global.fetch;
			const mockFetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					status: 'ok',
					values: [{
						datetime: new Date(receivedAtDate.getTime() + 12 * 60 * 60 * 1000).toISOString(),
						open: '100',
						high: '110',
						low: '95',
						close: '105',
					}],
				}),
			});
			global.fetch = mockFetch;

			try {
				await SignalOutcomeService.evaluatePendingOutcomes();
			} finally {
				global.fetch = originalFetch;
			}

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated.outcomes['1D'].status).toBe('evaluated');
			expect(updated.outcomes['1D'].price).toBe(105);
			expect(updated.outcomes['1D'].return).toBe(5);
			expect(updated.outcomes['1D'].maxFavorableExcursion).toBe(10);
			expect(updated.outcomes['1D'].maxAdverseExcursion).toBe(-5);
			expect(mockGetKlines).not.toHaveBeenCalled();
			const [requestUrl] = mockFetch.mock.calls[0];
			expect(new URL(requestUrl).searchParams.get('interval')).toBe('1h');

			const metrics = await SignalOutcomeService.getMetricsSummary();
			expect(metrics.exchangeBreakdown.BATS.evaluated).toBe(1);
			expect(metrics.providerBreakdown['twelve-data'].evaluated).toBe(1);
		});

		it('retries transient market data failures and retains pending status with attempts incremented', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-transient-retry';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-transient',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			mockGetKlines.mockRejectedValue(new Error('Binance 503: Service Unavailable'));

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('pending');
			expect(updated.outcomes['1h'].attempts).toBe(1);
			expect(updated.outcomes['1h'].lastAttemptAt).toBeDefined();
			expect(updated.outcomes['1h'].lastError).toBe('binance_unavailable');
			expect(updated.outcomeEvaluated).toBe(false);
		});

		it('marks outcome unavailable when max retry attempts budget is exhausted', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-retry-exhausted';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-exhausted',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
							attempts: 2,
						},
					},
				}],
			]));

			mockGetKlines.mockRejectedValue(new Error('Binance 503: Service Unavailable'));

			await SignalOutcomeService.evaluatePendingOutcomes({ maxRetryAttempts: 3 });

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('unavailable');
			expect(updated.outcomes['1h'].attempts).toBe(3);
			expect(updated.outcomes['1h'].retryExhausted).toBe(true);
			expect(updated.outcomes['1h'].reason).toBe('binance_unavailable');
			expect(updated.outcomeEvaluated).toBe(true);
		});

		it('marks outcome unavailable immediately on structural errors without retrying', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-structural-error';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-structural',
					source: 'news-monitor',
					symbol: 'INVALID',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			mockGetKlines.mockRejectedValue(new Error('Binance 400: Invalid symbol'));

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('unavailable');
			expect(updated.outcomes['1h'].reason).toBe('binance_invalid_symbol');
			expect(updated.outcomeEvaluated).toBe(true);
		});

		it('backfills missing entry price during sweep for pending_entry_price signals', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-backfill-entry';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-backfill',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: null,
					eligibilityState: 'pending_entry_price',
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// First call for entry price (getKlines near signal time) or getAvgPrice
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '50000', '52000', '49000', '51000'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.price).toBe(50000);
			expect(updated.entryPriceSource).toBe('binance');
			expect(updated.eligibilityState).toBe('supported_provider');
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].price).toBe(51000);
			expect(updated.outcomes['1h'].return).toBe(2);
		});

		it('enforces sweep max duration budget on slow or hanging getKlines requests', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const outcomes = {
				'1h': {
					status: 'pending',
					targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
				},
			};

			const mockDocId = 'test-doc-slow-kline';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-slow',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes,
				}],
			]));

			// Mock getKlines to hang / take 500ms
			mockGetKlines.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));

			const startTime = Date.now();
			await SignalOutcomeService.evaluatePendingOutcomes({ maxDurationMs: 50 });
			const duration = Date.now() - startTime;

			// Should finish rapidly (bounded by 50ms budget), NOT waiting 500ms
			expect(duration).toBeLessThan(300);

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			// Outcome should remain pending (fail-open state preserved)
			expect(updated.outcomes['1h'].status).toBe('pending');
			expect(updated.outcomeEvaluated).toBe(false);
		});

		it('re-checks deadline before each window request and halts without starting further requests', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 5 * 60 * 60 * 1000);
			const outcomes = {
				'1h': {
					status: 'pending',
					targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
				},
				'4h': {
					status: 'pending',
					targetTime: new Date(receivedAtDate.getTime() + 4 * 60 * 60 * 1000).toISOString(),
				},
			};

			const mockDocId = 'test-doc-multi-win';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-multi-win',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes,
				}],
			]));

			// Mock getKlines to take 80ms for 1h window
			mockGetKlines.mockImplementation(() => new Promise((resolve) => setTimeout(() => {
				resolve([[receivedAtDate.getTime(), "50000", "52000", "49000", "51000"]]);
			}, 80)));

			await SignalOutcomeService.evaluatePendingOutcomes({ maxDurationMs: 50 });

			// Because maxDurationMs is 50ms, before or during 1h window processing, budget is exhausted
			// getKlines should not be called more than once (or 0 times if budget expired before call)
			expect(mockGetKlines.mock.calls.length).toBeLessThanOrEqual(1);

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated.outcomes['4h'].status).toBe('pending');
		});
	});

	describe('getMetricsSummary()', () => {
		it('returns "No measurements found" when snapshot is empty', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).toBe('No measurements found');
		});

		it('computes correct aggregate metrics and coverage metadata when evaluated outcomes exist', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
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
			expect(res.windows['1h'].targetHitRatePercent).toBe(0);
			expect(res.windows['1h'].stopHitRatePercent).toBe(0);
			expect(res.windows['1h'].averageReturnPercent).toBe(2);
			expect(res.windows['1h'].averageMfePercent).toBe(3);
			expect(res.windows['1h'].averageMaePercent).toBe(-1);
			expect(res.drawdownProxy.averageMaxAdverseExcursionPercent).toBe(-1);
			expect(res.exchangeBreakdown.BINANCE).toBeDefined();
			expect(res.exchangeBreakdown.BINANCE.received).toBe(1);
			expect(res.exchangeBreakdown.BINANCE.evaluated).toBe(1);
		});

		it('computes targetHitRatePercent, stopHitRatePercent, and expectancyR for evaluated barrier outcomes', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['doc-tp', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-1',
					source: 'market-scanner',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					stop: 48000,
					target: 54000,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 54000,
							return: 8.0,
							rMultiple: 2.0,
							firstHit: 'target',
							targetHit: true,
							stopHit: false,
							maxFavorableExcursion: 8.0,
							maxAdverseExcursion: -1.0,
						},
					},
				}],
				['doc-sl', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-2',
					source: 'market-scanner',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 3000,
					stop: 2900,
					target: 3300,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 2900,
							return: -3.3333,
							rMultiple: -1.0,
							firstHit: 'stop',
							targetHit: false,
							stopHit: true,
							maxFavorableExcursion: 1.0,
							maxAdverseExcursion: -3.3333,
						},
					},
				}],
			]));

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res.totalSignalsEvaluated).toBe(2);
			expect(res.windows['1h'].targetHitRatePercent).toBe(50);
			expect(res.windows['1h'].stopHitRatePercent).toBe(50);
			expect(res.windows['1h'].expectancyR).toBe(0.5); // (2.0 + (-1.0)) / 2 = 0.5
			expect(res.targetHitRatePercent).toBe(50);
			expect(res.stopHitRatePercent).toBe(50);
			expect(res.expectancyR).toBe(0.5);
		});

		it('reports non-Binance and missing-entry signals with explicit coverage metadata instead of "No measurements found"', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
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

		it('tracks entryPriceSourceBreakdown across MCP, Binance, Twelve Data, and missing sources', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['doc-mcp', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-mcp',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 65000,
					entryPriceSource: 'tradingview-mcp',
					eligibilityState: 'supported_provider',
					outcomeEvaluated: false,
					outcomes: {},
				}],
				['doc-binance', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-binance',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 3500,
					entryPriceSource: 'binance',
					eligibilityState: 'supported_provider',
					outcomeEvaluated: false,
					outcomes: {},
				}],
				['doc-twelve', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-twelve',
					symbol: 'AAPL',
					exchange: 'NASDAQ',
					side: 'BUY',
					price: 180,
					entryPriceSource: 'twelve-data',
					eligibilityState: 'supported_provider',
					outcomeEvaluated: false,
					outcomes: {},
				}],
				['doc-none', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-none',
					symbol: 'SOLUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: null,
					entryPriceSource: null,
					eligibilityState: 'missing_entry_price',
					outcomeEvaluated: true,
					outcomes: {},
				}],
			]));

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).not.toBe('No measurements found');
			expect(res.entryPriceSourceBreakdown).toEqual({
				'tradingview-mcp': 1,
				'binance': 1,
				'twelve-data': 1,
				'none': 1,
			});
		});

		it('reconciles observed 54-alert mix fixture with exact exchange breakdown', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
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

		it('identifies false positive candidates using absolute score for both bullish and bearish signals', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			const map = new Map([
				['sig-bullish-bad', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-bullish',
					source: 'alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					score: 0.85,
					price: 60000,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 58000,
							return: -3.33,
							maxAdverseExcursion: -4.0,
							maxFavorableExcursion: 0.5,
							targetHit: false,
							stopHit: true,
							rMultiple: -1.0,
							evaluationDurationMs: 120,
						},
					},
				}],
				['sig-bearish-bad', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-bearish',
					source: 'alert',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'SELL',
					score: -0.85,
					price: 3000,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 3150,
							return: -5.0,
							maxAdverseExcursion: -6.0,
							maxFavorableExcursion: 0.2,
							targetHit: false,
							stopHit: true,
							rMultiple: -1.0,
							evaluationDurationMs: 110,
						},
					},
				}],
			]);

			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, map);

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res).not.toBe('No measurements found');
			expect(res.falsePositiveCandidates).toHaveLength(2);
			expect(res.falsePositiveCandidates).toEqual(expect.arrayContaining([
				expect.objectContaining({ symbol: 'BTCUSDT', score: 0.85, side: 'BUY' }),
				expect.objectContaining({ symbol: 'ETHUSDT', score: -0.85, side: 'SELL' }),
			]));
		});
	});

	describe('worker lifecycle and scheduling', () => {
		afterEach(() => {
			SignalOutcomeService.stopWorker();
		});

		it('does not start worker when feature is disabled', () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'false';

			const started = SignalOutcomeService.startWorker();
			expect(started).toBe(false);

			const status = SignalOutcomeService.getWorkerStatus();
			expect(status.enabled).toBe(false);
			expect(status.running).toBe(false);
			expect(status.timerId).toBeNull();
		});

		it('starts worker, executes initial sweep and periodic ticks, and reports status', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'worker-doc-1';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-worker',
					source: 'alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), "50000", "52000", "49000", "51000"],
			]);

			const started = SignalOutcomeService.startWorker({ intervalMs: 60000 });
			expect(started).toBe(true);

			let status = SignalOutcomeService.getWorkerStatus();
			expect(status.enabled).toBe(true);
			expect(status.running).toBe(true);
			expect(status.intervalMs).toBe(60000);

			// Await the evaluation sweep explicitly
			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');

			status = SignalOutcomeService.getWorkerStatus();
			expect(status.lastRunEvaluatedCount).toBe(1);
			expect(status.lastRunScannedCount).toBe(1);
			expect(status.lastRunPendingCount).toBe(0);
			expect(status.lastRunErrorCount).toBe(0);

			// Clean stop
			SignalOutcomeService.stopWorker();
			status = SignalOutcomeService.getWorkerStatus();
			expect(status.running).toBe(false);
			expect(status.timerId).toBeNull();
		});

		it('prevents overlapping sweeps when an evaluation is in progress', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			// Trigger a sweep with a slow mocked Firestore call to keep isEvaluating true
			const slowDocRef = {
				ref: { update: jest.fn() },
				data: () => ({
					receivedAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 7200000)),
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomes: {
						'1h': { status: 'pending', targetTime: new Date(Date.now() - 3600000).toISOString() },
					},
				}),
			};

			let resolveGet;
			const slowPromise = new Promise((resolve) => { resolveGet = resolve; });

			const firestoreMock = {
				collection: () => ({
					where: () => ({
						limit: () => ({
							get: () => slowPromise,
						}),
					}),
				}),
			};

			const alertStorageService = require('../../src/services/storage/AlertStorageService');
			const origGetFirestore = alertStorageService.getFirestore;
			alertStorageService.getFirestore = () => firestoreMock;

			try {
				// Start first sweep
				const sweep1 = SignalOutcomeService.evaluatePendingOutcomes();

				// Second concurrent sweep should be skipped
				const sweep2 = await SignalOutcomeService.evaluatePendingOutcomes();
				expect(sweep2).toEqual({
					scannedCount: 0,
					evaluatedCount: 0,
					skipped: true,
					reason: 'already_evaluating',
				});

				// Complete first sweep
				resolveGet({ empty: true, docs: [] });
				await sweep1;
			} finally {
				alertStorageService.getFirestore = origGetFirestore;
			}
		});

		it('isolates errors during worker sweep without throwing', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const alertStorageService = require('../../src/services/storage/AlertStorageService');
			const origGetFirestore = alertStorageService.getFirestore;

			alertStorageService.getFirestore = () => {
				throw new Error('Firestore connection failure');
			};

			const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			try {
				const res = await SignalOutcomeService.evaluatePendingOutcomes();
				expect(res.error).toBe('Firestore connection failure');
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					'[SignalOutcomeService] Failed to evaluate pending outcomes:',
					'Firestore connection failure'
				);
			} finally {
				consoleWarnSpy.mockRestore();
				alertStorageService.getFirestore = origGetFirestore;
			}
		});

		it('aborts Binance request and halts sweep when sweep deadline is exceeded during getKlines', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'timeout-doc-1';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-timeout-1',
					source: 'alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// Simulate getKlines hanging indefinitely until aborted
			mockGetKlines.mockImplementation(() => new Promise((_, reject) => {
				const timer = setTimeout(() => {}, 10000);
				if (typeof timer.unref === 'function') timer.unref();
			}));

			const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			try {
				const sweepPromise = SignalOutcomeService.evaluatePendingOutcomes({ maxDurationMs: 50 });
				const res = await sweepPromise;

				expect(res.scannedCount).toBe(1);
				expect(res.evaluatedCount).toBe(0);
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					expect.stringContaining('[SignalOutcomeService] Error evaluating window 1h for BTCUSDT:'),
					expect.stringContaining('Signal outcome sweep deadline exceeded (50ms)')
				);
			} finally {
				consoleWarnSpy.mockRestore();
			}
		});
	});

	describe('listOutcomes()', () => {
		function buildQueryDoc(id, data) {
			return {
				id,
				data: () => data,
			};
		}

		it('returns null when feature is disabled', async () => {
			const res = await SignalOutcomeService.listOutcomes({ limit: 10 });
			expect(res).toBeNull();
		});

		it('throws STORAGE_UNAVAILABLE when Firestore is not available', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const origGetFirestore = AlertStorageService.getFirestore;
			AlertStorageService.getFirestore = () => null;

			try {
				await expect(SignalOutcomeService.listOutcomes({ limit: 10 })).rejects.toMatchObject({
					code: 'STORAGE_UNAVAILABLE',
				});
			} finally {
				AlertStorageService.getFirestore = origGetFirestore;
			}
		});

		it('throws INVALID_REQUEST when before cursor is malformed', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			await expect(SignalOutcomeService.listOutcomes({
				limit: 10,
				before: 'invalid-before-cursor',
			})).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
				message: SignalOutcomeService.INVALID_CURSOR_MESSAGE,
			});
		});

		it('lists outcomes with formatted fields and pagination metadata', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const receivedDate1 = new Date('2026-08-23T12:00:00.000Z');
			const receivedDate2 = new Date('2026-08-23T11:00:00.000Z');

			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('doc-1', {
						receivedAt: admin.firestore.Timestamp.fromDate(receivedDate1),
						requestId: 'req-1',
						source: 'news-monitor',
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						assetClass: 'crypto',
						timeframe: '1h',
						setupType: 'breakout',
						score: 0.9,
						side: 'BUY',
						price: 65000,
						entryPriceSource: 'tradingview-mcp',
						stop: 63000,
						target: 68000,
						marketDataProvider: 'binance',
						eligibilityState: 'supported_provider',
						eligibilityReason: null,
						outcomeEvaluated: true,
						outcomes: {
							'1h': {
								status: 'evaluated',
								reason: null,
								targetTime: '2026-08-23T13:00:00.000Z',
								price: 66000,
								return: 1.5385,
								maxFavorableExcursion: 2.0,
								maxAdverseExcursion: -0.2,
								firstHit: null,
								targetHit: false,
								stopHit: false,
								firstHitTime: null,
								rMultiple: 0.5,
							},
						},
						tokenUsage: {
							inputTokens: 100,
							outputTokens: 40,
							totalTokens: 140,
							totalCost: 0.00003,
						},
						processingTimeMs: 150,
					}),
					buildQueryDoc('doc-2', {
						receivedAt: admin.firestore.Timestamp.fromDate(receivedDate2),
						requestId: 'req-2',
						source: 'alert',
						symbol: 'ETHUSDT',
						exchange: 'BINANCE',
						side: 'SELL',
						price: 3500,
						outcomeEvaluated: false,
						outcomes: {
							'1h': { status: 'pending', targetTime: '2026-08-23T12:00:00.000Z' },
						},
					}),
				],
			});

			const res = await SignalOutcomeService.listOutcomes({ limit: 1 });

			expect(res.outcomes).toHaveLength(1);
			expect(res.outcomes[0]).toEqual({
				id: 'doc-1',
				receivedAt: '2026-08-23T12:00:00.000Z',
				requestId: 'req-1',
				source: 'news-monitor',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				assetClass: 'crypto',
				timeframe: '1h',
				setupType: 'breakout',
				score: 0.9,
				side: 'BUY',
				price: 65000,
				entryPriceSource: 'tradingview-mcp',
				stop: 63000,
				target: 68000,
				marketDataProvider: 'binance',
				eligibilityState: 'supported_provider',
				eligibilityReason: null,
				outcomeEvaluated: true,
				outcomes: {
					'1h': {
						status: 'evaluated',
						reason: null,
						targetTime: '2026-08-23T13:00:00.000Z',
						price: 66000,
						return: 1.5385,
						maxFavorableExcursion: 2.0,
						maxAdverseExcursion: -0.2,
						firstHit: null,
						targetHit: false,
						stopHit: false,
						firstHitTime: null,
						rMultiple: 0.5,
					},
				},
				sources: [],
				tokenUsage: {
					inputTokens: 100,
					outputTokens: 40,
					totalTokens: 140,
					totalCost: 0.00003,
				},
				processingTimeMs: 150,
			});
			expect(res.hasMore).toBe(true);
			expect(res.nextBefore).toBeTruthy();
		});

		it('filters outcomes by symbol, exchange, status, window, and time range', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('doc-match', {
						receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-23T12:00:00.000Z')),
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						outcomeEvaluated: true,
						outcomes: {
							'1h': { status: 'evaluated', return: 2.0 },
						},
					}),
					buildQueryDoc('doc-wrong-sym', {
						receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-23T12:00:00.000Z')),
						symbol: 'ETHUSDT',
						exchange: 'BINANCE',
						outcomeEvaluated: true,
						outcomes: {
							'1h': { status: 'evaluated', return: 1.0 },
						},
					}),
					buildQueryDoc('doc-wrong-status', {
						receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-23T12:00:00.000Z')),
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						outcomeEvaluated: false,
						outcomes: {
							'1h': { status: 'pending' },
						},
					}),
					buildQueryDoc('doc-wrong-time', {
						receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-20T12:00:00.000Z')),
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						outcomeEvaluated: true,
						outcomes: {
							'1h': { status: 'evaluated' },
						},
					}),
				],
			});

			const res = await SignalOutcomeService.listOutcomes({
				symbol: 'BINANCE:BTCUSDT',
				exchange: 'BINANCE',
				status: 'evaluated',
				window: '1h',
				from: '2026-08-23T00:00:00.000Z',
				to: '2026-08-23T23:59:59.000Z',
			});

			expect(res.outcomes).toHaveLength(1);
			expect(res.outcomes[0].id).toBe('doc-match');
			expect(res.hasMore).toBe(false);
		});

		it('throws STORAGE_UNAVAILABLE when Firestore query.get() rejects', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			mockGet.mockRejectedValueOnce(new Error('Connection terminated'));

			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			try {
				await expect(SignalOutcomeService.listOutcomes({ limit: 10 })).rejects.toMatchObject({
					code: 'STORAGE_UNAVAILABLE',
				});
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining('[SignalOutcomeService]'),
					expect.stringContaining('Connection terminated'),
				);
			} finally {
				warnSpy.mockRestore();
			}
		});
	});
});
