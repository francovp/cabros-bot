'use strict';

const EquityMarketDataService = require('../../src/services/storage/EquityMarketDataService');

describe('EquityMarketDataService', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		jest.clearAllMocks();
		delete process.env.ENABLE_EQUITY_MARKET_DATA;
		delete process.env.EQUITY_MARKET_DATA_PROVIDER;
		delete process.env.TWELVE_DATA_API_KEY;
		delete process.env.TWELVE_DATA_BASE_URL;
		delete process.env.EQUITY_MARKET_DATA_TIMEOUT_MS;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	function configure() {
		process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
		process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
		process.env.TWELVE_DATA_API_KEY = 'test-key';
	}

	it('fails closed and reports disabled when the provider is not configured', async () => {
		global.fetch = jest.fn();

		expect(EquityMarketDataService.getStatus()).toMatchObject({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		await expect(EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' }))
			.rejects.toMatchObject({ reason: EquityMarketDataService.REASONS.NOT_CONFIGURED });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('requests a quote with exchange-qualified parameters and header authentication', async () => {
		configure();
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ status: 'ok', close: '150.25' }),
		});

		await expect(EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' }))
			.resolves.toBe(150.25);

		const [requestUrl, requestOptions] = global.fetch.mock.calls[0];
		const parsedUrl = new URL(requestUrl);
		expect(parsedUrl.pathname).toBe('/quote');
		expect(parsedUrl.searchParams.get('symbol')).toBe('AAPL');
		expect(parsedUrl.searchParams.get('exchange')).toBe('NASDAQ');
		expect(parsedUrl.search).not.toContain('test-key');
		expect(requestOptions.headers.Authorization).toBe('apikey test-key');
	});

	it('maps and orders historical bars for the outcome evaluator', async () => {
		configure();
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				status: 'ok',
				values: [
					{ datetime: '2026-08-02 15:00:00', open: '102', high: '104', low: '101', close: '103' },
					{ datetime: '2026-08-02 14:00:00', open: '100', high: '103', low: '99', close: '102' },
				],
			}),
		});

		const startTime = Date.parse('2026-08-02T14:00:00Z');
		const bars = await EquityMarketDataService.getHistoricalBars({
			symbol: 'TSM',
			exchange: 'BATS',
			interval: '1h',
			startTime,
			endTime: Date.parse('2026-08-02T15:00:00Z'),
		});

		expect(bars).toEqual([
			[startTime, '100', '103', '99', '102'],
			[startTime + 60 * 60 * 1000, '102', '104', '101', '103'],
		]);
		const [requestUrl] = global.fetch.mock.calls[0];
		const parsedUrl = new URL(requestUrl);
		expect(parsedUrl.pathname).toBe('/time_series');
		expect(parsedUrl.searchParams.get('interval')).toBe('1h');
		expect(parsedUrl.searchParams.get('exchange')).toBe('BATS');
		expect(parsedUrl.searchParams.get('adjust')).toBe('none');
	});

	it('classifies provider rate limits without leaking the response', async () => {
		configure();
		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 429,
			json: async () => ({ status: 'error', code: 429, message: 'quota exceeded' }),
		});

		await expect(EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' }))
			.rejects.toMatchObject({ reason: EquityMarketDataService.REASONS.RATE_LIMITED });
	});

	it('aborts slow provider requests within the caller timeout budget', async () => {
		configure();
		global.fetch = jest.fn((requestUrl, requestOptions) => new Promise((resolve, reject) => {
			requestOptions.signal.addEventListener('abort', () => {
				const error = new Error('aborted');
				error.name = 'AbortError';
				reject(error);
			});
		}));

		await expect(EquityMarketDataService.getEntryPrice({
			symbol: 'AAPL',
			exchange: 'NASDAQ',
			timeoutMs: 5,
		})).rejects.toMatchObject({ reason: EquityMarketDataService.REASONS.TIMEOUT });
	});

	describe('Exchange support for NYSE, AMEX, and NYSE ARCA', () => {
		it('includes BATS, NASDAQ, NYSE, AMEX, and NYSE ARCA in SUPPORTED_EXCHANGES', () => {
			expect(EquityMarketDataService.SUPPORTED_EXCHANGES).toEqual(['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA']);
		});

		it('identifies NYSE, AMEX, and NYSE ARCA as supported exchanges', () => {
			expect(EquityMarketDataService.isSupportedExchange('NYSE')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('AMEX')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('NYSE ARCA')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('NYSE_ARCA')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('ARCA')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('BATS')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('NASDAQ')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('UNKNOWN')).toBe(false);
			expect(EquityMarketDataService.isSupportedExchange('BINANCE')).toBe(false);
			expect(EquityMarketDataService.isSupportedExchange('')).toBe(false);
			expect(EquityMarketDataService.isSupportedExchange(null)).toBe(false);
		});

		it('fetches quotes for NYSE and AMEX symbols with normalized exchange parameters', async () => {
			configure();
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '175.50' }),
			});

			const nysePrice = await EquityMarketDataService.getEntryPrice({ symbol: 'TSM', exchange: 'NYSE' });
			expect(nysePrice).toBe(175.50);
			expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get('exchange')).toBe('NYSE');

			const amexPrice = await EquityMarketDataService.getEntryPrice({ symbol: 'SPY', exchange: 'AMEX' });
			expect(amexPrice).toBe(175.50);
			expect(new URL(global.fetch.mock.calls[1][0]).searchParams.get('exchange')).toBe('AMEX');

			const arcaPrice = await EquityMarketDataService.getEntryPrice({ symbol: 'SPY', exchange: 'NYSE_ARCA' });
			expect(arcaPrice).toBe(175.50);
			expect(new URL(global.fetch.mock.calls[2][0]).searchParams.get('exchange')).toBe('NYSE ARCA');

			const arcaAliasPrice = await EquityMarketDataService.getEntryPrice({ symbol: 'SPY', exchange: 'ARCA' });
			expect(arcaAliasPrice).toBe(175.50);
			expect(new URL(global.fetch.mock.calls[3][0]).searchParams.get('exchange')).toBe('NYSE ARCA');
		});

		it('fetches historical bars for NYSE and AMEX symbols', async () => {
			configure();
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					status: 'ok',
					values: [
						{ datetime: '2026-08-02 15:00:00', open: '170', high: '176', low: '169', close: '175.5' },
					],
				}),
			});

			const startTime = Date.parse('2026-08-02T14:00:00Z');
			const bars = await EquityMarketDataService.getHistoricalBars({
				symbol: 'TSM',
				exchange: 'NYSE',
				interval: '1h',
				startTime,
				endTime: Date.parse('2026-08-02T16:00:00Z'),
			});

			expect(bars).toEqual([
				[Date.parse('2026-08-02T15:00:00Z'), '170', '176', '169', '175.5'],
			]);
			expect(new URL(global.fetch.mock.calls[0][0]).searchParams.get('exchange')).toBe('NYSE');
		});
	});
});
