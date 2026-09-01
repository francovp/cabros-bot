'use strict';

const admin = require('firebase-admin');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
const EquityMarketDataService = require('../../src/services/storage/EquityMarketDataService');

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

// Mock geminiPriceService
const mockFetchGeminiPrice = jest.fn();
const mockIsGeminiGroundingEnabled = jest.fn(() => true);
jest.mock('../../src/services/grounding/geminiPriceService', () => ({
	fetchGeminiPrice: (...args) => mockFetchGeminiPrice(...args),
	extractPriceJson: jest.fn(),
	isGeminiQuotaError: jest.fn(() => false),
	isGeminiGroundingEnabled: () => mockIsGeminiGroundingEnabled(),
}));

// Mock TradingView MCP service for outcome entry-price fallback
const mockCallCoinAnalysis = jest.fn();
const mockIsBreakerOpen = jest.fn(() => false);
jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	callCoinAnalysis: (...args) => mockCallCoinAnalysis(...args),
	isBreakerOpen: () => mockIsBreakerOpen(),
	isEnabled: jest.fn(() => true),
	getStatus: jest.fn(() => ({ ready: true })),
}));

describe('SignalOutcomeService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFetchGeminiPrice.mockResolvedValue(null);
		mockCallCoinAnalysis.mockResolvedValue(null);
		mockIsBreakerOpen.mockReturnValue(false);
		admin.__resetApps();
		admin.__resetCollectionState();
		AlertStorageService._resetForTesting();
		EquityMarketDataService._resetPacerForTesting();
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_EQUITY_MARKET_DATA;
		delete process.env.EQUITY_MARKET_DATA_PROVIDER;
		delete process.env.TWELVE_DATA_API_KEY;
		delete process.env.TWELVE_DATA_BASE_URL;
		delete process.env.EQUITY_MARKET_DATA_TIMEOUT_MS;
		process.env.EQUITY_MARKET_DATA_RPM = '0';
		delete process.env.TWELVE_DATA_RPM;
		delete process.env.ENABLE_MCP_OUTCOME_PRICES;
	});

	afterEach(() => {
		EquityMarketDataService._resetPacerForTesting();
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_EQUITY_MARKET_DATA;
		delete process.env.EQUITY_MARKET_DATA_PROVIDER;
		delete process.env.TWELVE_DATA_API_KEY;
		delete process.env.TWELVE_DATA_BASE_URL;
		delete process.env.EQUITY_MARKET_DATA_TIMEOUT_MS;
		process.env.EQUITY_MARKET_DATA_RPM = '0';
		delete process.env.TWELVE_DATA_RPM;
		delete process.env.ENABLE_MCP_OUTCOME_PRICES;
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

		it('classifies Binance 451 entry fallback as binance_region_blocked reason', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const err = new Error('Service unavailable from restricted location');
			err.code = 451;
			mockGetAvgPrice.mockRejectedValue(err);

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-region-blocked-reason',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.eligibilityState).toBe('pending_entry_price');
			expect(saved.eligibilityReason).toBe('binance_region_blocked');
		});

		it('forwards BINANCE_DATA_BASE_URL to MainClient when set to a valid URL', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.BINANCE_DATA_BASE_URL = 'https://data-api.binance.vision';
			const { MainClient } = require('binance');
			const previousCalls = MainClient.mock.calls.length;
			mockGetAvgPrice.mockResolvedValue({ price: '68000.00' });

			try {
				await SignalOutcomeService.recordSignal({
					requestId: 'req-custom-base-url',
					source: 'webhook-alert',
					symbol: 'BINANCE:BTCUSDT',
					price: null,
					side: 'BUY',
				});

				const latestCall = MainClient.mock.calls[MainClient.mock.calls.length - 1];
				const latestOptions = latestCall[0];
				expect(latestOptions.baseUrl).toBe('https://data-api.binance.vision');
				expect(MainClient.mock.calls.length).toBeGreaterThan(previousCalls);
			} finally {
				delete process.env.BINANCE_DATA_BASE_URL;
			}
		});

		it('falls back to default Binance base URL when BINANCE_DATA_BASE_URL is malformed', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.BINANCE_DATA_BASE_URL = 'not-a-url';
			const { MainClient } = require('binance');
			mockGetAvgPrice.mockResolvedValue({ price: '68000.00' });

			try {
				await SignalOutcomeService.recordSignal({
					requestId: 'req-malformed-base-url',
					source: 'webhook-alert',
					symbol: 'BINANCE:BTCUSDT',
					price: null,
					side: 'BUY',
				});

				const latestCall = MainClient.mock.calls[MainClient.mock.calls.length - 1];
				expect(latestCall[0].baseUrl).toBe('https://api.binance.com');
			} finally {
				delete process.env.BINANCE_DATA_BASE_URL;
			}
		});

		it('resolves entry price from tertiary Gemini source when Binance is region-blocked', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			mockGetAvgPrice.mockRejectedValue(new Error('Binance 451: Service unavailable from restricted location'));
			mockFetchGeminiPrice.mockResolvedValue({
				price: 68250.75,
				change24h: 1.2,
				source: 'gemini-grounding',
			});

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-tertiary-gemini',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockFetchGeminiPrice).toHaveBeenCalledWith('BTCUSDT', expect.objectContaining({
				timeoutMs: 5000,
			}));

			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.price).toBe(68250.75);
			expect(saved.entryPriceSource).toBe('gemini-grounding');
			expect(saved.eligibilityState).toBe('supported_provider');
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
			expect(mockFetchGeminiPrice).not.toHaveBeenCalled();
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

		it('marks FX_IDC signals as twelve_data_not_configured when equity market data is not enabled and no price is provided', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'false';
			delete process.env.ENABLE_MCP_OUTCOME_PRICES;

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-fx-disabled',
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
			expect(saved.eligibilityState).toBe('twelve_data_not_configured');
			expect(saved.outcomeEvaluated).toBe(true);
		});

		it('falls back to TradingView MCP for FX_IDC entries when MCP outcome prices are enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'false';
			process.env.ENABLE_MCP_OUTCOME_PRICES = 'true';

			mockCallCoinAnalysis.mockResolvedValueOnce({
				price_data: { current_price: 951.42, change_percent: 0.5 },
			});

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-mcp-fx-idc',
				source: 'webhook-alert',
				symbol: 'FX_IDC:USDCLP(D)',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockCallCoinAnalysis).toHaveBeenCalledWith(expect.objectContaining({
				symbol: 'USDCLP',
				exchange: 'FX_IDC',
			}));

			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.exchange).toBe('FX_IDC');
			expect(saved.symbol).toBe('USDCLP');
			expect(saved.price).toBe(951.42);
			expect(saved.entryPriceSource).toBe('tradingview_mcp');
			expect(saved.eligibilityState).toBe('supported_provider');
			expect(saved.outcomeEvaluated).toBe(false);
		});

		it('falls back to TradingView MCP for NASDAQ_DLY entries when MCP outcome prices are enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'false';
			process.env.ENABLE_MCP_OUTCOME_PRICES = 'true';

			mockCallCoinAnalysis.mockResolvedValueOnce({
				price_data: { close: '18234.50' },
			});

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-mcp-nasdaq-dly',
				source: 'webhook-alert',
				symbol: 'NASDAQ_DLY:NDX(D)',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.exchange).toBe('NASDAQ_DLY');
			expect(saved.symbol).toBe('NDX');
			expect(saved.price).toBe(18234.50);
			expect(saved.entryPriceSource).toBe('tradingview_mcp');
			expect(saved.eligibilityState).toBe('supported_provider');
		});

		it('marks FX_IDC signals as twelve_data_not_configured when MCP returns no price and equity provider is disabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'false';
			process.env.ENABLE_MCP_OUTCOME_PRICES = 'true';

			mockCallCoinAnalysis.mockResolvedValueOnce({ price_data: {} });

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-mcp-fx-no-price',
				source: 'webhook-alert',
				symbol: 'FX_IDC:USDCLP(D)',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockCallCoinAnalysis).toHaveBeenCalled();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved).toBeDefined();
			expect(saved.entryPriceSource).toBeNull();
			expect(saved.eligibilityState).toBe('twelve_data_not_configured');
			expect(saved.outcomeEvaluated).toBe(true);
		});

		it('marks BINANCE signals as pending_entry_price when MCP fallback fails after Binance and Gemini', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_MCP_OUTCOME_PRICES = 'true';

			mockGetAvgPrice.mockRejectedValueOnce(new Error('Binance unavailable'));
			mockFetchGeminiPrice.mockResolvedValueOnce(null);
			mockCallCoinAnalysis.mockRejectedValueOnce(new Error('MCP unavailable'));

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-binance-all-fail',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved.entryPriceSource).toBeNull();
			expect(saved.eligibilityState).toBe('pending_entry_price');
			expect(['binance_unavailable', 'mcp_price_failed']).toContain(saved.eligibilityReason);
		});

		it('skips MCP fallback when the MCP circuit breaker is open', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'false';
			process.env.ENABLE_MCP_OUTCOME_PRICES = 'true';
			mockIsBreakerOpen.mockReturnValueOnce(true);

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-mcp-breaker-open',
				source: 'webhook-alert',
				symbol: 'FX_IDC:USDCLP(D)',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockCallCoinAnalysis).not.toHaveBeenCalled();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved.entryPriceSource).toBeNull();
		});

		it('does not consult MCP fallback when ENABLE_MCP_OUTCOME_PRICES is disabled (default)', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_EQUITY_MARKET_DATA = 'false';

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-mcp-disabled',
				source: 'webhook-alert',
				symbol: 'FX_IDC:USDCLP(D)',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockCallCoinAnalysis).not.toHaveBeenCalled();
		});

		it('adds TradingView MCP as a third source after Binance + Gemini for BINANCE signals', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_MCP_OUTCOME_PRICES = 'true';

			mockGetAvgPrice.mockRejectedValueOnce(new Error('Binance unavailable'));
			mockCallCoinAnalysis.mockResolvedValueOnce({
				price_data: { current_price: '67000.10' },
			});

			const resId = await SignalOutcomeService.recordSignal({
				requestId: 'req-mcp-binance-third',
				source: 'webhook-alert',
				symbol: 'BINANCE:BTCUSDT',
				price: null,
				side: 'BUY',
			});

			expect(resId).not.toBeNull();
			expect(mockCallCoinAnalysis).toHaveBeenCalled();
			const saved = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(resId);
			expect(saved.price).toBe(67000.10);
			expect(saved.entryPriceSource).toBe('tradingview_mcp');
			expect(saved.eligibilityState).toBe('supported_provider');
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

		it('does not trigger false barrier hits on candle crossing entry price when stop and target are null (incomplete market-scanner setup)', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-null-risk-scanner';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-scanner-null-risk',
					source: 'market-scanner',
					symbol: 'SOLUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 100,
					stop: null,
					target: null,
					outcomeEvaluated: false,
					outcomes: {
						'1h': {
							status: 'pending',
							targetTime: new Date(receivedAtDate.getTime() + 1 * 60 * 60 * 1000).toISOString(),
						},
					},
				}],
			]));

			// Candle goes both below entry (98) and above entry (102)
			mockGetKlines.mockResolvedValue([
				[receivedAtDate.getTime(), '100', '102', '98', '101'],
			]);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].status).toBe('evaluated');
			expect(updated.outcomes['1h'].firstHit).toBeNull();
			expect(updated.outcomes['1h'].stopHit).toBe(false);
			expect(updated.outcomes['1h'].targetHit).toBe(false);
			expect(updated.outcomes['1h'].price).toBe(101);
			expect(updated.outcomes['1h'].return).toBe(1);
			expect(updated.outcomes['1h'].rMultiple).toBeUndefined();
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

		it('classifies Binance sweep getKlines 451 as market_data_region_blocked and keeps outcome pending', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const receivedAtDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const mockDocId = 'test-region-block-sweep';
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				[mockDocId, {
					receivedAt: admin.firestore.Timestamp.fromDate(receivedAtDate),
					requestId: 'req-region-block-sweep',
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

			const err = new Error('Service unavailable from restricted location');
			err.code = 451;
			mockGetKlines.mockRejectedValue(err);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const updated = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME).get(mockDocId);
			expect(updated).toBeDefined();
			expect(updated.outcomes['1h'].reason).toBe('market_data_region_blocked');
			// region-blocked is treated as transient — outcome stays pending, not unavailable
			expect(updated.outcomes['1h'].status).toBe('pending');

			const status = SignalOutcomeService.getWorkerStatus();
			expect(status.lastRunRegionBlockedCount).toBeGreaterThanOrEqual(1);
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

		it('excludes barrierless outcomes from target and stop hit-rate denominators in mixed populations', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['doc-barrier-target', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-tp',
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
				['doc-stop-only', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-sl',
					source: 'expanded-analysis',
					symbol: 'SOLUSDT',
					exchange: 'BINANCE',
					side: 'SELL',
					price: 200,
					stop: 210,
					target: null,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 190,
							return: -5.0,
							firstHit: null,
							targetHit: false,
							stopHit: false, // stop never crossed within window; no firstHit recorded
							maxFavorableExcursion: 2.0,
							maxAdverseExcursion: -5.0,
						},
					},
				}],
				['doc-barrierless', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-bare',
					source: 'news-monitor',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 3000,
					stop: null,
					target: null,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 3060,
							return: 2.0,
							firstHit: null,
							targetHit: false,
							stopHit: false,
							maxFavorableExcursion: 3.0,
							maxAdverseExcursion: -1.0,
						},
					},
				}],
			]));

			const res = await SignalOutcomeService.getMetricsSummary();
			expect(res.totalSignalsEvaluated).toBe(3);
			// Window-level: only barrier-configured outcomes are denominator-eligible
			expect(res.windows['1h'].totalSignals).toBe(3);
			expect(res.windows['1h'].hitRatePercent).toBe(66.67); // return > 0 for 2 of 3 (barrierless doc also has return 2.0)
			expect(res.windows['1h'].targetEligibleWindows).toBe(1);
			expect(res.windows['1h'].stopEligibleWindows).toBe(2);
			expect(res.windows['1h'].targetHitRatePercent).toBe(100); // 1/1 eligible
		 expect(res.windows['1h'].stopHitRatePercent).toBe(0); // 0/2 eligible
			expect(res.windows['1h'].expectancyR).toBe(2.0); // rCount stays 1 (only doc with rMultiple)
			// Overall: eligible denominators exclude barrierless windows
			expect(res.targetHitRatePercent).toBe(100); // 1/1 target-eligible
			expect(res.stopHitRatePercent).toBe(0); // 0/2 stop-eligible
			expect(res.expectancyR).toBe(2.0);
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

		it('splits window stats by side and setup type with same metric shape as parent window', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['buy-tp', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-buy-tp',
					source: 'alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					setupType: 'trend_continuation',
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
				['buy-sl', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-buy-sl',
					source: 'alert',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					setupType: 'trend_continuation',
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
				['sell-tp', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-sell-tp',
					source: 'alert',
					symbol: 'SOLUSDT',
					exchange: 'BINANCE',
					side: 'SELL',
					setupType: 'reversal',
					price: 200,
					stop: 210,
					target: 180,
					eligibilityState: 'supported_provider',
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetTime: now.toISOString(),
							price: 180,
							return: 10.0,
							rMultiple: 2.0,
							firstHit: 'target',
							targetHit: true,
							stopHit: false,
							maxFavorableExcursion: 10.0,
							maxAdverseExcursion: -0.5,
						},
					},
				}],
			]));

			const res = await SignalOutcomeService.getMetricsSummary();

			const win = res.windows['1h'];
			expect(win).toBeDefined();
			expect(win.totalSignals).toBe(3);

			// bySide: BUY has 2 evaluated, SELL has 1 evaluated
			expect(win.bySide).toBeDefined();
			expect(win.bySide.BUY).toBeDefined();
			expect(win.bySide.SELL).toBeDefined();
			expect(win.bySide.BUY.totalSignals).toBe(2);
			expect(win.bySide.SELL.totalSignals).toBe(1);
			expect(win.bySide.BUY.hitRatePercent).toBe(50); // 1 of 2 BUY hit target
			expect(win.bySide.SELL.hitRatePercent).toBe(100); // 1 of 1 SELL hit target
			expect(win.bySide.BUY.expectancyR).toBe(0.5); // (2.0 + (-1.0)) / 2
			expect(win.bySide.SELL.expectancyR).toBe(2.0);
			expect(win.bySide.BUY.targetHitRatePercent).toBe(50);
			expect(win.bySide.SELL.targetHitRatePercent).toBe(100);

			// bySetupType: trend_continuation has 2 evaluated, reversal has 1
			expect(win.bySetupType).toBeDefined();
			expect(win.bySetupType.trend_continuation).toBeDefined();
			expect(win.bySetupType.reversal).toBeDefined();
			expect(win.bySetupType.trend_continuation.totalSignals).toBe(2);
			expect(win.bySetupType.reversal.totalSignals).toBe(1);
			expect(win.bySetupType.trend_continuation.hitRatePercent).toBe(50);
			expect(win.bySetupType.reversal.hitRatePercent).toBe(100);

			// Existing top-level windowStats shape unchanged (still has the parent metrics)
			expect(win.hitRatePercent).toBeDefined();
			expect(win.expectancyR).toBeDefined();
			expect(win.averageReturnPercent).toBeDefined();
			expect(win.averageMfePercent).toBeDefined();
			expect(win.averageMaePercent).toBeDefined();
			expect(win.maxAdverseExcursionPercent).toBeDefined();
		});

		it('omits empty bySide and bySetupType buckets when only one side or one setupType has signals', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['only-buy', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-only-buy',
					source: 'alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					setupType: 'breakout',
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
			]));

			const res = await SignalOutcomeService.getMetricsSummary();
			const win = res.windows['1h'];
			expect(win).toBeDefined();
			// BUY side present, SELL side omitted
			expect(win.bySide.BUY).toBeDefined();
			expect(win.bySide.SELL).toBeUndefined();
			// breakout setup present (only one)
			expect(win.bySetupType.breakout).toBeDefined();
		});

		it('omits bySide and bySetupType when no signals have setupType metadata', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['no-setup', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-no-setup',
					source: 'alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					// no setupType
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
			]));

			const res = await SignalOutcomeService.getMetricsSummary();
			const win = res.windows['1h'];
			expect(win).toBeDefined();
			expect(win.bySide).toBeDefined();
			expect(win.bySide.BUY).toBeDefined();
			// No setupType anywhere → bySetupType omitted
			expect(win.bySetupType).toBeUndefined();
		});
	});

	describe('summarizeOutcomes()', () => {
		it('throws STORAGE_UNAVAILABLE when Firestore is unavailable', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const origGetFirestore = AlertStorageService.getFirestore;
			AlertStorageService.getFirestore = () => null;

			try {
				await expect(SignalOutcomeService.summarizeOutcomes())
					.rejects.toMatchObject({
						code: 'STORAGE_UNAVAILABLE',
					});
			} finally {
				AlertStorageService.getFirestore = origGetFirestore;
			}
		});

		it('returns typed empty summary object when snapshot is empty', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const res = await SignalOutcomeService.summarizeOutcomes();
			expect(res).toEqual({
				available: false,
				totalSignalsReceived: 0,
				totalSignalsEligible: 0,
				totalSignalsEvaluated: 0,
				totalSignalsPending: 0,
				totalSignalsUnavailable: 0,
				coveragePercent: 0,
				isCoverageComplete: true,
				targetHitRatePercent: 0,
				stopHitRatePercent: 0,
				expectancyR: null,
				populationNote: 'No outcome measurements found for the requested criteria.',
				exchangeBreakdown: {},
				providerBreakdown: {},
				entryPriceSourceBreakdown: {},
				eligibilityBreakdown: {},
				windows: {},
				drawdownProxy: {
					averageMaxAdverseExcursionPercent: 0,
					absoluteMaxAdverseExcursionPercent: 0,
				},
				falsePositiveCandidatesCount: 0,
				falsePositiveCandidates: [],
				latencyCostMetadata: {
					averageProcessingTimeMs: null,
					tokenUsage: {
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
					},
				},
			});
		});

		it('returns typed empty summary object when filters match no documents', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, new Map([
				['doc-1', {
					receivedAt: admin.firestore.Timestamp.fromDate(new Date()),
					requestId: 'req-1',
					source: 'alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'evaluated', return: 2.0, maxFavorableExcursion: 2.0, maxAdverseExcursion: -0.5 },
					},
				}],
			]));

			const res = await SignalOutcomeService.summarizeOutcomes({ symbol: 'SOLUSDT' });
			expect(res.available).toBe(false);
			expect(res.totalSignalsReceived).toBe(0);
		});

		it('filters outcomes by symbol, exchange, status, window, and date range', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const now = new Date();
			const map = new Map([
				['doc-btc', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-btc',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 50000,
					target: 52000,
					stop: 49000,
					score: 0.8,
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							return: 2.5,
							targetHit: true,
							stopHit: false,
							rMultiple: 2.0,
							maxFavorableExcursion: 4.0,
							maxAdverseExcursion: -0.5,
						},
					},
					tokenUsage: { inputTokens: 200, outputTokens: 100, totalCost: 0.0001 },
					processingTimeMs: 250,
				}],
				['doc-eth', {
					receivedAt: admin.firestore.Timestamp.fromDate(now),
					requestId: 'req-eth',
					source: 'news-monitor',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'SELL',
					price: 3000,
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							return: -1.5,
							targetHit: false,
							stopHit: true,
							rMultiple: -1.0,
							maxFavorableExcursion: 0.2,
							maxAdverseExcursion: -2.0,
						},
					},
				}],
			]);

			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, map);

			// Filter by symbol
			const btcRes = await SignalOutcomeService.summarizeOutcomes({ symbol: 'BINANCE:BTCUSDT' });
			expect(btcRes.available).toBe(true);
			expect(btcRes.totalSignalsReceived).toBe(1);
			expect(btcRes.totalSignalsEvaluated).toBe(1);
			expect(btcRes.windows['1h'].hitRatePercent).toBe(100);
			expect(btcRes.windows['1h'].targetHitRatePercent).toBe(100);
			expect(btcRes.windows['1h'].expectancyR).toBe(2);
			expect(btcRes.latencyCostMetadata.averageProcessingTimeMs).toBe(250);
			expect(btcRes.latencyCostMetadata.tokenUsage.totalCost).toBe(0.0001);

			// Summary over all
			const allRes = await SignalOutcomeService.summarizeOutcomes();
			expect(allRes.available).toBe(true);
			expect(allRes.totalSignalsReceived).toBe(2);
			expect(allRes.totalSignalsEvaluated).toBe(2);
			expect(allRes.windows['1h'].totalSignals).toBe(2);
			expect(allRes.windows['1h'].hitRatePercent).toBe(50);
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

		it('throws AbortError and stops scanning when signal is aborted', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const ac = new AbortController();
			ac.abort();

			await expect(SignalOutcomeService.listOutcomes({
				limit: 10,
				signal: ac.signal,
			})).rejects.toMatchObject({
				name: 'AbortError',
				code: 'ABORTED',
			});
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('caps the Firestore scan when maxScanDocs is reached', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('doc-1', {
						receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-23T12:00:00.000Z')),
						symbol: 'OTHER',
						exchange: 'BINANCE',
						outcomeEvaluated: true,
						outcomes: {},
					}),
					buildQueryDoc('doc-2', {
						receivedAt: admin.firestore.Timestamp.fromDate(new Date('2026-08-23T11:00:00.000Z')),
						symbol: 'OTHER',
						exchange: 'BINANCE',
						outcomeEvaluated: true,
						outcomes: {},
					}),
				],
			});

			const res = await SignalOutcomeService.listOutcomes({
				symbol: 'TARGET',
				limit: 5,
				maxScanDocs: 2,
			});

			expect(res.outcomes).toHaveLength(0);
			expect(mockGet).toHaveBeenCalledTimes(1);
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
