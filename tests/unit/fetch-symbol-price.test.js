'use strict';

jest.mock('binance', () => {
	const mockGetAvgPrice = jest.fn();
	const mockGet24hrChangeStatistics = jest.fn();
	const mockMainClient = jest.fn();
	mockMainClient.mockImplementation(() => ({
		getAvgPrice: mockGetAvgPrice,
		get24hrChangeStatistics: mockGet24hrChangeStatistics,
	}));
	return {
		MainClient: mockMainClient,
		mockMainClient,
		mockGetAvgPrice,
		mockGet24hrChangeStatistics,
	};
});

jest.mock('../../src/services/storage/EquityMarketDataService', () => ({
	getStatus: jest.fn(),
	isSupportedExchange: jest.fn(),
	normalizeExchange: jest.fn((e) => (e === 'BATS' ? 'BATS' : e)),
	getQuote: jest.fn(),
	REASONS: {
		DISABLED: 'equity_market_data_disabled',
		NOT_CONFIGURED: 'equity_market_data_not_configured',
		TIMEOUT: 'equity_market_data_timeout',
		RATE_LIMITED: 'equity_market_data_rate_limited',
		NO_DATA: 'equity_market_data_no_data',
		INVALID_RESPONSE: 'equity_market_data_invalid_response',
	},
}));

jest.mock('../../src/services/monitoring/SentryService', () => ({
	startInactiveSpan: jest.fn(() => ({ span: true })),
	endSpan: jest.fn(),
	captureRuntimeError: jest.fn(),
	captureExternalFailure: jest.fn(),
}));

const { mockMainClient, mockGetAvgPrice, mockGet24hrChangeStatistics } = require('binance');
const equityMarketDataService = require('../../src/services/storage/EquityMarketDataService');
const sentryService = require('../../src/services/monitoring/SentryService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
const {
	classifyPriceQuery,
	fetchSymbolPrice,
} = require('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol');
const { getPrice } = require('../../src/controllers/commands');

function buildContext(text) {
	return {
		message: { text },
		update: {
			message: {
				chat: { id: 987 },
			},
		},
		reply: jest.fn().mockResolvedValue(undefined),
	};
}

describe('fetchPriceCryptoSymbol and /precio command', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		equityMarketDataService.isSupportedExchange.mockImplementation((ex) =>
			['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'FX_IDC', 'SPCFD'].includes(ex)
		);
		equityMarketDataService.getStatus.mockReturnValue({
			enabled: true,
			configured: true,
			ready: true,
		});
	});

	describe('classifyPriceQuery', () => {
		it('returns invalid for empty or missing input', () => {
			expect(classifyPriceQuery('')).toEqual({ valid: false, error: 'missing_symbol' });
			expect(classifyPriceQuery(null)).toEqual({ valid: false, error: 'missing_symbol' });
			expect(classifyPriceQuery('   ')).toEqual({ valid: false, error: 'missing_symbol' });
		});

		it('classifies explicit Binance exchange prefixes as crypto', () => {
			expect(classifyPriceQuery('BINANCE:BTCUSDT')).toEqual({
				valid: true,
				assetClass: 'crypto',
				exchange: 'BINANCE',
				symbol: 'BTCUSDT',
			});
			expect(classifyPriceQuery('BYBIT:ETHUSDT')).toEqual({
				valid: true,
				assetClass: 'crypto',
				exchange: 'BINANCE',
				symbol: 'ETHUSDT',
			});
		});

		it('classifies explicit stock and forex exchanges as equity', () => {
			expect(classifyPriceQuery('NASDAQ:NVDA')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: 'NASDAQ',
				symbol: 'NVDA',
			});
			expect(classifyPriceQuery('NYSE:TSM')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: 'NYSE',
				symbol: 'TSM',
			});
			expect(classifyPriceQuery('BATS:AAPL')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: 'BATS',
				symbol: 'AAPL',
			});
			expect(classifyPriceQuery('FX_IDC:EURUSD')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: 'FX_IDC',
				symbol: 'EURUSD',
			});
		});

		it('classifies unsupported exchange prefixes as unsupported', () => {
			expect(classifyPriceQuery('UNKNOWN:XYZ')).toEqual({
				valid: true,
				assetClass: 'unsupported',
				exchange: 'UNKNOWN',
				symbol: 'XYZ',
				reason: 'Exchange UNKNOWN no soportado para consulta de precios.',
			});
		});

		it('classifies standard crypto pairs ending in USDT, USDC, BUSD, etc. as crypto', () => {
			expect(classifyPriceQuery('BTCUSDT')).toEqual({
				valid: true,
				assetClass: 'crypto',
				exchange: 'BINANCE',
				symbol: 'BTCUSDT',
			});
			expect(classifyPriceQuery('ETHUSDC')).toEqual({
				valid: true,
				assetClass: 'crypto',
				exchange: 'BINANCE',
				symbol: 'ETHUSDC',
			});
			expect(classifyPriceQuery('SOLBUSD')).toEqual({
				valid: true,
				assetClass: 'crypto',
				exchange: 'BINANCE',
				symbol: 'SOLBUSD',
			});
			expect(classifyPriceQuery('BTC/USDT')).toEqual({
				valid: true,
				assetClass: 'crypto',
				exchange: 'BINANCE',
				symbol: 'BTCUSDT',
			});
		});

		it('classifies stock tickers (NVDA, AAPL, SPY, TSLA) as equity', () => {
			expect(classifyPriceQuery('NVDA')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: null,
				symbol: 'NVDA',
			});
			expect(classifyPriceQuery('AAPL')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: null,
				symbol: 'AAPL',
			});
			expect(classifyPriceQuery('SPY')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: null,
				symbol: 'SPY',
			});
			expect(classifyPriceQuery('TSLA (1D)')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: null,
				symbol: 'TSLA',
			});
		});

		it('classifies forex pairs as equity', () => {
			expect(classifyPriceQuery('USDCLP')).toEqual({
				valid: true,
				assetClass: 'equity',
				exchange: 'FX_IDC',
				symbol: 'USDCLP',
			});
		});
	});

	describe('fetchSymbolPrice', () => {
		it('enriches crypto price with 24h ticker statistics', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65432.1 });
			mockGet24hrChangeStatistics.mockResolvedValueOnce({
				priceChangePercent: '2.4',
				highPrice: '66000',
				lowPrice: '64000',
				quoteVolume: '1234567890',
			});
			const context = buildContext('/precio BTCUSDT');

			const result = await fetchSymbolPrice(context);

			expect(result.message).toBe('Precio de BTCUSDT es 65432\n24h: ▲ +2.40% | Rango: 64000 – 66000\nVol: 1.2B USDT');
			expect(mockGet24hrChangeStatistics).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
		});

		it('uses the quote asset for non-USDT ticker volume', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 0.03 });
			mockGet24hrChangeStatistics.mockResolvedValueOnce({
				priceChangePercent: '-1.2',
				highPrice: '0.031',
				lowPrice: '0.029',
				quoteVolume: '12.5',
			});

			const result = await fetchSymbolPrice(buildContext('/precio ETHBTC'));

			expect(result.message).toContain('Vol: 12.5 BTC');
		});

		it('uses the current Remote Config timeout for each ticker request', async () => {
			const previousEnabled = process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			remoteConfigService._setRemoteOverridesForTesting({ BINANCE_FETCH_TIMEOUT_MS: 1234 });
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65432.1 });
			mockGet24hrChangeStatistics.mockResolvedValueOnce({
				priceChangePercent: '2.4',
				highPrice: '66000',
				lowPrice: '64000',
				quoteVolume: '1234567890',
			});

			await fetchSymbolPrice(buildContext('/precio BTCUSDT'));

			expect(mockMainClient).toHaveBeenCalledWith({ beautifyResponses: true }, { timeout: 1234 });
			remoteConfigService._resetForTesting();
			if (previousEnabled === undefined) delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			else process.env.ENABLE_FIREBASE_REMOTE_CONFIG = previousEnabled;
		});

		it('keeps the bare price when the 24h ticker fails', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65432.1 });
			mockGet24hrChangeStatistics.mockRejectedValueOnce(new Error('Binance unavailable'));
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await fetchSymbolPrice(buildContext('/precio BTCUSDT'));

			expect(result.message).toBe('Precio de BTCUSDT es 65432');
			expect(warn).toHaveBeenCalledWith('Unable to enrich Binance price with 24h ticker:', 'Binance unavailable');
			warn.mockRestore();
		});

		it('keeps the bare price when the 24h ticker payload is malformed', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65432.1 });
			mockGet24hrChangeStatistics.mockResolvedValueOnce({ priceChangePercent: '2.4' });
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await fetchSymbolPrice(buildContext('/precio BTCUSDT'));

			expect(result.message).toBe('Precio de BTCUSDT es 65432');
			expect(warn).toHaveBeenCalledWith('Unable to enrich Binance price with 24h ticker:', 'Invalid 24h ticker payload');
			warn.mockRestore();
		});

		it('fetches and formats crypto price from Binance', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65432.1 });
			const context = buildContext('/precio BTCUSDT');

			const result = await fetchSymbolPrice(context);
			expect(result).toEqual({
				symbol: 'BTCUSDT',
				price: 65432,
				assetClass: 'crypto',
				message: 'Precio de BTCUSDT es 65432',
			});
			expect(mockGetAvgPrice).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
		});

		it('preserves small decimal prices for crypto under 1', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 0.00001234 });
			const context = buildContext('/precio PEPEUSDT');

			const result = await fetchSymbolPrice(context);
			expect(result).toEqual({
				symbol: 'PEPEUSDT',
				price: 0.00001234,
				assetClass: 'crypto',
				message: 'Precio de PEPEUSDT es 0.00001234',
			});
		});

		it('returns clear Spanish error when Binance symbol is invalid', async () => {
			const err = new Error('Invalid symbol.');
			err.code = -1121;
			mockGetAvgPrice.mockRejectedValueOnce(err);
			const context = buildContext('/precio INVALIDUSDT');

			await expect(fetchSymbolPrice(context)).rejects.toMatchObject({
				userMessage: 'No se encontró el símbolo INVALIDUSDT en Binance.',
			});
		});

		it('fetches and formats equity price with 24h change from Twelve Data when enabled', async () => {
			equityMarketDataService.getQuote.mockResolvedValueOnce({
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
			const context = buildContext('/precio NVDA');

			const result = await fetchSymbolPrice(context);
			expect(result).toEqual({
				symbol: 'NVDA',
				name: 'NVIDIA Corp',
				exchange: 'NASDAQ',
				currency: 'USD',
				price: 125.5,
				change: 2.85,
				percentChange: 2.32,
				assetClass: 'equity',
				message: 'Precio de NVDA es 125.5 (+2.32%)',
			});
			expect(equityMarketDataService.getQuote).toHaveBeenCalledWith({
				symbol: 'NVDA',
				exchange: null,
				timeoutMs: undefined,
			});
		});

		it('returns clear not-enabled message when equity market data is disabled', async () => {
			equityMarketDataService.getStatus.mockReturnValue({
				enabled: false,
				configured: false,
				ready: false,
			});
			const context = buildContext('/precio NVDA');

			await expect(fetchSymbolPrice(context)).rejects.toMatchObject({
				userMessage: 'El servicio de datos de acciones no está habilitado.',
			});
		});

		it('returns clear unconfigured message when equity market data is unconfigured', async () => {
			equityMarketDataService.getStatus.mockReturnValue({
				enabled: true,
				configured: false,
				ready: false,
			});
			const context = buildContext('/precio NVDA');

			await expect(fetchSymbolPrice(context)).rejects.toMatchObject({
				userMessage: 'El proveedor de datos de acciones no está configurado.',
			});
		});

		it('captures Sentry failure and returns timeout message when Twelve Data times out', async () => {
			const err = new Error('Request timed out');
			err.reason = equityMarketDataService.REASONS.TIMEOUT;
			equityMarketDataService.getQuote.mockRejectedValueOnce(err);
			const context = buildContext('/precio NVDA');

			await expect(fetchSymbolPrice(context)).rejects.toMatchObject({
				userMessage: 'No se pudo obtener el precio de NVDA (tiempo de espera agotado).',
			});
			expect(sentryService.captureExternalFailure).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					feature: 'price-command',
					external: expect.objectContaining({
						provider: 'twelve-data',
						lastErrorCode: equityMarketDataService.REASONS.TIMEOUT,
					}),
				})
			);
		});

		it('captures Sentry failure and returns rate-limit message when Twelve Data is rate limited', async () => {
			const err = new Error('Rate limit exceeded');
			err.reason = equityMarketDataService.REASONS.RATE_LIMITED;
			equityMarketDataService.getQuote.mockRejectedValueOnce(err);
			const context = buildContext('/precio NVDA');

			await expect(fetchSymbolPrice(context)).rejects.toMatchObject({
				userMessage: 'No se pudo obtener el precio de NVDA (límite de peticiones alcanzado).',
			});
		});
	});

	describe('getPrice Telegram command end-to-end', () => {
		it('prompts the user when no symbol is provided', async () => {
			const context = buildContext('/precio');
			await getPrice(context);

			expect(context.reply).toHaveBeenCalledWith(
				'Por favor indica un símbolo. Ejemplo: /precio BTCUSDT o /precio NVDA'
			);
		});

		it('replies with crypto price for /precio BTCUSDT', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65000 });
			const context = buildContext('/precio BTCUSDT');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith('Precio de BTCUSDT es 65000');
		});

		it('replies with equity price and change for /precio NVDA when enabled', async () => {
			equityMarketDataService.getQuote.mockResolvedValueOnce({
				symbol: 'NVDA',
				price: 125.5,
				percentChange: 2.32,
			});
			const context = buildContext('/precio NVDA');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith('Precio de NVDA es 125.5 (+2.32%)');
		});

		it('replies with not-enabled message for /precio NVDA when disabled without logging Sentry runtime error', async () => {
			equityMarketDataService.getStatus.mockReturnValue({
				enabled: false,
				configured: false,
				ready: false,
			});
			const context = buildContext('/precio NVDA');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith('El servicio de datos de acciones no está habilitado.');
			expect(sentryService.captureRuntimeError).not.toHaveBeenCalled();
		});

		it('replies with unsupported exchange error for /precio UNKNOWN:AAPL', async () => {
			const context = buildContext('/precio UNKNOWN:AAPL');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith(
				'Exchange UNKNOWN no soportado para consulta de precios.'
			);
			expect(sentryService.captureRuntimeError).not.toHaveBeenCalled();
		});

		it('replies with graceful timeout message when Twelve Data times out', async () => {
			const err = new Error('Timeout');
			err.reason = equityMarketDataService.REASONS.TIMEOUT;
			equityMarketDataService.getQuote.mockRejectedValueOnce(err);
			const context = buildContext('/precio NVDA');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith(
				'No se pudo obtener el precio de NVDA (tiempo de espera agotado).'
			);
		});

		it('replies with error message for /precio BADSYMBOL when Binance rejects with invalid symbol', async () => {
			const err = new Error('Invalid symbol.');
			err.code = -1121;
			mockGetAvgPrice.mockRejectedValueOnce(err);
			const context = buildContext('/precio BADSYMBOL');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith(
				'No se encontró el símbolo BADSYMBOL en Binance.'
			);
			expect(sentryService.captureRuntimeError).not.toHaveBeenCalled();
		});

		it('replies with error message and captures runtime error when Binance throws network error', async () => {
			const err = new Error('Network error');
			mockGetAvgPrice.mockRejectedValueOnce(err);
			const context = buildContext('/precio BTCUSDT');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith(
				'No se pudo obtener el precio de BTCUSDT en Binance.'
			);
			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					error: expect.any(Error),
					extra: expect.objectContaining({
						command: 'getPrice',
						chatId: 987,
						symbol: 'BTCUSDT',
					}),
				})
			);
		});
	});
});
