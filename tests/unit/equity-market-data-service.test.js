'use strict';

const EquityMarketDataService = require('../../src/services/storage/EquityMarketDataService');

describe('EquityMarketDataService', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		jest.clearAllMocks();
		EquityMarketDataService._resetPacerForTesting();
		EquityMarketDataService._resetCircuitBreakerForTesting();
		delete process.env.ENABLE_EQUITY_MARKET_DATA;
		delete process.env.EQUITY_MARKET_DATA_PROVIDER;
		delete process.env.TWELVE_DATA_API_KEY;
		delete process.env.TWELVE_DATA_BASE_URL;
		delete process.env.EQUITY_MARKET_DATA_TIMEOUT_MS;
		process.env.EQUITY_MARKET_DATA_RPM = '0';
		delete process.env.TWELVE_DATA_RPM;
		delete process.env.CIRCUIT_BREAKER_THRESHOLD;
		delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		EquityMarketDataService._resetPacerForTesting();
		EquityMarketDataService._resetCircuitBreakerForTesting();
		process.env.EQUITY_MARKET_DATA_RPM = '0';
		delete process.env.TWELVE_DATA_RPM;
		delete process.env.CIRCUIT_BREAKER_THRESHOLD;
		delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
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

	it('returns structured quote with price, change, percentChange and currency via getQuote', async () => {
		configure();
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				status: 'ok',
				symbol: 'NVDA',
				name: 'NVIDIA Corp',
				exchange: 'NASDAQ',
				currency: 'USD',
				close: '125.50',
				change: '2.85',
				percent_change: '2.32',
				is_market_open: true,
				datetime: '2026-08-24 16:00:00',
			}),
		});

		const quote = await EquityMarketDataService.getQuote({ symbol: 'NVDA', exchange: 'NASDAQ' });
		expect(quote).toEqual({
			symbol: 'NVDA',
			name: 'NVIDIA Corp',
			exchange: 'NASDAQ',
			currency: 'USD',
			price: 125.5,
			change: 2.85,
			percentChange: 2.32,
			isMarketOpen: true,
			datetime: '2026-08-24 16:00:00',
		});
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

	describe('Exchange support for NYSE, AMEX, NYSE ARCA, FX_IDC, and SPCFD', () => {
		it('includes BATS, NASDAQ, NYSE, AMEX, NYSE ARCA, FX_IDC, and SPCFD in SUPPORTED_EXCHANGES', () => {
			expect(EquityMarketDataService.SUPPORTED_EXCHANGES).toEqual(['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'FX_IDC', 'SPCFD']);
		});

		it('identifies NYSE, AMEX, NYSE ARCA, FX_IDC, and SPCFD as supported exchanges', () => {
			expect(EquityMarketDataService.isSupportedExchange('NYSE')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('AMEX')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('NYSE ARCA')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('NYSE_ARCA')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('ARCA')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('BATS')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('NASDAQ')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('NASDAQ_DLY')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('FX_IDC')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('FX')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('FOREX')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('SPCFD')).toBe(true);
			expect(EquityMarketDataService.isSupportedExchange('UNKNOWN')).toBe(false);
			expect(EquityMarketDataService.isSupportedExchange('BINANCE')).toBe(false);
			expect(EquityMarketDataService.isSupportedExchange('')).toBe(false);
			expect(EquityMarketDataService.isSupportedExchange(null)).toBe(false);
		});

		it('normalizes symbols correctly for forex and parenthetical timeframe suffixes', () => {
			expect(EquityMarketDataService.normalizeSymbol('USDCLP')).toBe('USD/CLP');
			expect(EquityMarketDataService.normalizeSymbol('USDCLP(D)')).toBe('USD/CLP');
			expect(EquityMarketDataService.normalizeSymbol('EURUSD')).toBe('EUR/USD');
			expect(EquityMarketDataService.normalizeSymbol('SPX(D)')).toBe('SPX');
			expect(EquityMarketDataService.normalizeSymbol('NDX(1h)')).toBe('NDX');
			expect(EquityMarketDataService.normalizeSymbol('AAPL')).toBe('AAPL');
		});

		it('resolves query exchange correctly', () => {
			expect(EquityMarketDataService.resolveQueryExchange('NASDAQ_DLY')).toBe('NASDAQ');
			expect(EquityMarketDataService.resolveQueryExchange('NYSE_ARCA')).toBe('NYSE ARCA');
			expect(EquityMarketDataService.resolveQueryExchange('FX_IDC')).toBeUndefined();
			expect(EquityMarketDataService.resolveQueryExchange('FX')).toBeUndefined();
			expect(EquityMarketDataService.resolveQueryExchange('SPCFD')).toBeUndefined();
			expect(EquityMarketDataService.resolveQueryExchange('UNKNOWN')).toBeUndefined();
			expect(EquityMarketDataService.resolveQueryExchange('NYSE')).toBe('NYSE');
		});

		it('fetches quotes for FX_IDC, SPCFD, and NASDAQ_DLY symbols with proper symbol normalization and no exchange parameter for FX/CFD', async () => {
			configure();
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '950.50' }),
			});

			const fxPrice = await EquityMarketDataService.getEntryPrice({ symbol: 'USDCLP(D)', exchange: 'FX_IDC' });
			expect(fxPrice).toBe(950.50);
			const fxUrl = new URL(global.fetch.mock.calls[0][0]);
			expect(fxUrl.searchParams.get('symbol')).toBe('USD/CLP');
			expect(fxUrl.searchParams.get('exchange')).toBeNull();

			const spcfdPrice = await EquityMarketDataService.getEntryPrice({ symbol: 'SPX(D)', exchange: 'SPCFD' });
			expect(spcfdPrice).toBe(950.50);
			const spcfdUrl = new URL(global.fetch.mock.calls[1][0]);
			expect(spcfdUrl.searchParams.get('symbol')).toBe('SPX');
			expect(spcfdUrl.searchParams.get('exchange')).toBeNull();

			const nasdaqDlyPrice = await EquityMarketDataService.getEntryPrice({ symbol: 'NDX(D)', exchange: 'NASDAQ_DLY' });
			expect(nasdaqDlyPrice).toBe(950.50);
			const nasdaqDlyUrl = new URL(global.fetch.mock.calls[2][0]);
			expect(nasdaqDlyUrl.searchParams.get('symbol')).toBe('NDX');
			expect(nasdaqDlyUrl.searchParams.get('exchange')).toBe('NASDAQ');
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

		it('correctly classifies transient and structural reasons', () => {
			expect(EquityMarketDataService.isTransientReason(EquityMarketDataService.REASONS.RATE_LIMITED)).toBe(true);
			expect(EquityMarketDataService.isTransientReason(EquityMarketDataService.REASONS.TIMEOUT)).toBe(true);
			expect(EquityMarketDataService.isTransientReason(EquityMarketDataService.REASONS.UNAVAILABLE)).toBe(true);
			expect(EquityMarketDataService.isTransientReason(EquityMarketDataService.REASONS.NO_DATA)).toBe(false);

			expect(EquityMarketDataService.isStructuralReason(EquityMarketDataService.REASONS.NOT_CONFIGURED)).toBe(true);
			expect(EquityMarketDataService.isStructuralReason(EquityMarketDataService.REASONS.MISCONFIGURED)).toBe(true);
			expect(EquityMarketDataService.isStructuralReason(EquityMarketDataService.REASONS.INVALID_RESPONSE)).toBe(true);
			expect(EquityMarketDataService.isStructuralReason(EquityMarketDataService.REASONS.NO_DATA)).toBe(true);
			expect(EquityMarketDataService.isStructuralReason('unparseable_symbol')).toBe(true);
			expect(EquityMarketDataService.isStructuralReason('unsupported_exchange')).toBe(true);
		});

		it('extracts Retry-After header on 429 responses into EquityMarketDataError', async () => {
			configure();
			EquityMarketDataService._resetPacerForTesting();

			const mockHeaders = new Map();
			mockHeaders.set('retry-after', '15');

			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				statusText: 'Too Many Requests',
				headers: {
					get: (name) => mockHeaders.get(name.toLowerCase()) || null,
				},
				json: async () => ({ code: 429, message: 'You have reached your API call rate limit' }),
			});

			try {
				await EquityMarketDataService.getQuote({ symbol: 'AAPL', exchange: 'NASDAQ' });
				throw new Error('Expected getQuote to throw');
			} catch (err) {
				expect(err).toBeInstanceOf(EquityMarketDataService.EquityMarketDataError);
				expect(err.reason).toBe(EquityMarketDataService.REASONS.RATE_LIMITED);
				expect(err.retryAfterSeconds).toBe(15);
				expect(err.status).toBe(429);
			}
		});

		it('paces outbound requests when RPM is configured', async () => {
			configure();
			process.env.EQUITY_MARKET_DATA_RPM = '60'; // 1 request per second
			EquityMarketDataService._resetPacerForTesting();

			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '150.00' }),
			});

			const startTime = Date.now();
			await EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' });
			await EquityMarketDataService.getEntryPrice({ symbol: 'MSFT', exchange: 'NASDAQ' });
			const elapsed = Date.now() - startTime;

			// Second request should have waited for at least ~900ms due to pacing
			expect(elapsed).toBeGreaterThanOrEqual(850);
			expect(global.fetch).toHaveBeenCalledTimes(2);

			EquityMarketDataService._resetPacerForTesting();
		});

		it('consumes Remote Config RPM override', () => {
			configure();
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			const RemoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
			RemoteConfigService._setRemoteOverridesForTesting({
				EQUITY_MARKET_DATA_RPM: 30,
			});

			expect(EquityMarketDataService.getStatus().rpm).toBe(30);
			RemoteConfigService._resetForTesting();
			delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		});

		it('serializes concurrent pacing reservations across simultaneous requests', async () => {
			configure();
			process.env.EQUITY_MARKET_DATA_RPM = '120'; // 500ms interval
			EquityMarketDataService._resetPacerForTesting();

			global.fetch = jest.fn().mockImplementation(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '100.00' }),
			}));

			const start = Date.now();
			const results = await Promise.all([
				EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' }),
				EquityMarketDataService.getEntryPrice({ symbol: 'MSFT', exchange: 'NASDAQ' }),
			]);
			const duration = Date.now() - start;

			expect(results).toEqual([100, 100]);
			expect(duration).toBeGreaterThanOrEqual(400);
			expect(global.fetch).toHaveBeenCalledTimes(2);

			EquityMarketDataService._resetPacerForTesting();
		});

		it('fails fast when pacing wait exceeds caller timeout budget', async () => {
			configure();
			process.env.EQUITY_MARKET_DATA_RPM = '6'; // 10,000ms interval
			EquityMarketDataService._resetPacerForTesting();

			global.fetch = jest.fn().mockImplementation(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '100.00' }),
			}));

			// First request occupies slot
			await EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' });

			// Second request with a tight timeout budget (e.g. 500ms) should fail with TIMEOUT
			await expect(
				EquityMarketDataService.getEntryPrice({ symbol: 'MSFT', exchange: 'NASDAQ', timeoutMs: 500 })
			).rejects.toMatchObject({
				reason: EquityMarketDataService.REASONS.TIMEOUT,
			});

			EquityMarketDataService._resetPacerForTesting();
		});
	});

	describe('Circuit Breaker', () => {
		it('initializes circuit breaker in closed state with 0 failures', () => {
			configure();
			const status = EquityMarketDataService.getStatus();
			expect(status.status).toBe('ready');
			expect(status.ready).toBe(true);
			expect(status.circuitBreaker).toEqual(expect.objectContaining({
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
			}));
		});

		it('trips circuit breaker after reaching failure threshold and fast-fails without fetch', async () => {
			configure();
			process.env.CIRCUIT_BREAKER_THRESHOLD = '3';
			global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

			// 3 consecutive failures
			for (let i = 0; i < 3; i++) {
				await expect(EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' }))
					.rejects.toMatchObject({ reason: EquityMarketDataService.REASONS.UNAVAILABLE });
			}
			expect(global.fetch).toHaveBeenCalledTimes(3);

			// Status should now be degraded and ready: false
			const status = EquityMarketDataService.getStatus();
			expect(status.status).toBe('degraded');
			expect(status.ready).toBe(false);
			expect(status.circuitBreaker.state).toBe('open');
			expect(status.circuitBreaker.consecutiveFailures).toBe(3);

			// 4th request must fast-fail with CIRCUIT_BREAKER_OPEN without invoking fetch
			global.fetch.mockClear();
			await expect(EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' }))
				.rejects.toMatchObject({
					reason: EquityMarketDataService.REASONS.CIRCUIT_BREAKER_OPEN,
					status: 503,
				});
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it('does not count NO_DATA (e.g. unknown symbol) as a circuit breaker failure', async () => {
			configure();
			process.env.CIRCUIT_BREAKER_THRESHOLD = '2';
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', values: [] }),
			});

			await expect(EquityMarketDataService.getHistoricalBars({
				symbol: 'NONEXISTENT',
				exchange: 'NASDAQ',
				interval: '1h',
				startTime: 1000,
				endTime: 2000,
			})).rejects.toMatchObject({ reason: EquityMarketDataService.REASONS.NO_DATA });

			const breakerStatus = EquityMarketDataService.getCircuitBreakerStatus();
			expect(breakerStatus.state).toBe('closed');
			expect(breakerStatus.consecutiveFailures).toBe(0);
		});

		it('transitions from open to half-open after cooldown and recovers to closed on successful probe', async () => {
			configure();
			process.env.CIRCUIT_BREAKER_THRESHOLD = '1';
			process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '1000';

			global.fetch = jest.fn().mockRejectedValue(new Error('Provider outage'));
			await expect(EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' }))
				.rejects.toMatchObject({ reason: EquityMarketDataService.REASONS.UNAVAILABLE });

			expect(EquityMarketDataService.getStatus().circuitBreaker.state).toBe('open');

			// Fast-forward cooldown
			const pastTime = Date.now() - 1500;
			EquityMarketDataService._getCircuitBreakerForTesting().openedAt = new Date(pastTime).toISOString();

			// Mock success for probe
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ status: 'ok', close: '155.00' }),
			});

			const price = await EquityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' });
			expect(price).toBe(155.00);

			const recoveredStatus = EquityMarketDataService.getStatus();
			expect(recoveredStatus.status).toBe('ready');
			expect(recoveredStatus.circuitBreaker.state).toBe('closed');
			expect(recoveredStatus.circuitBreaker.consecutiveFailures).toBe(0);
		});
	});
});
