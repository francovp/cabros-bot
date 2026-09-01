'use strict';

jest.mock('binance', () => {
	const mockGetAvgPrice = jest.fn();
	return {
		MainClient: jest.fn().mockImplementation(() => ({
			getAvgPrice: mockGetAvgPrice,
		})),
		mockGetAvgPrice,
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

const { mockGetAvgPrice } = require('binance');
const equityMarketDataService = require('../../src/services/storage/EquityMarketDataService');
const sentryService = require('../../src/services/monitoring/SentryService');
const {
	parseSymbolList,
	fetchSymbolsPrices,
	MAX_BATCH_SYMBOLS,
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

describe('/precio batch symbol support (issue #626)', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		equityMarketDataService.isSupportedExchange.mockImplementation((ex) =>
			['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'FX_IDC', 'SPCFD'].includes(ex),
		);
		equityMarketDataService.getStatus.mockReturnValue({
			enabled: true,
			configured: true,
			ready: true,
		});
	});

	describe('parseSymbolList', () => {
		it('returns empty array for null/empty/whitespace input', () => {
			expect(parseSymbolList(null)).toEqual([]);
			expect(parseSymbolList('')).toEqual([]);
			expect(parseSymbolList('   ')).toEqual([]);
		});

		it('returns single symbol as one-element array', () => {
			expect(parseSymbolList('BTCUSDT')).toEqual(['BTCUSDT']);
			expect(parseSymbolList('  ETHUSDT  ')).toEqual(['ETHUSDT']);
		});

		it('splits comma-separated symbols into multiple entries', () => {
			expect(parseSymbolList('BTCUSDT,ETHUSDT,NVDA')).toEqual([
				'BTCUSDT',
				'ETHUSDT',
				'NVDA',
			]);
		});

		it('splits space-separated symbols into multiple entries', () => {
			expect(parseSymbolList('BTCUSDT ETHUSDT NVDA')).toEqual([
				'BTCUSDT',
				'ETHUSDT',
				'NVDA',
			]);
		});

		it('handles mixed comma and space delimiters', () => {
			expect(parseSymbolList('BTCUSDT, ETHUSDT NVDA,AAPL')).toEqual([
				'BTCUSDT',
				'ETHUSDT',
				'NVDA',
				'AAPL',
			]);
		});

		it('preserves exchange-prefixed symbols', () => {
			expect(parseSymbolList('BINANCE:BTCUSDT,NASDAQ:NVDA')).toEqual([
				'BINANCE:BTCUSDT',
				'NASDAQ:NVDA',
			]);
		});

		it('removes duplicates while preserving first occurrence', () => {
			expect(parseSymbolList('BTCUSDT,ETHUSDT,BTCUSDT')).toEqual([
				'BTCUSDT',
				'ETHUSDT',
			]);
		});
	});

	describe('fetchSymbolsPrices (batch)', () => {
		it('fetches multiple crypto prices in parallel', async () => {
			mockGetAvgPrice.mockImplementation(({ symbol }) => {
				if (symbol === 'BTCUSDT') return Promise.resolve({ price: 65000 });
				if (symbol === 'ETHUSDT') return Promise.resolve({ price: 3500 });
				return Promise.reject(new Error('Unknown symbol'));
			});

			const results = await fetchSymbolsPrices(['BTCUSDT', 'ETHUSDT']);

			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({
				symbol: 'BTCUSDT',
				price: 65000,
				assetClass: 'crypto',
				success: true,
			});
			expect(results[1]).toMatchObject({
				symbol: 'ETHUSDT',
				price: 3500,
				assetClass: 'crypto',
				success: true,
			});
			expect(mockGetAvgPrice).toHaveBeenCalledTimes(2);
		});

		it('serializes equity lookups through the shared provider pacer', async () => {
			let activeLookups = 0;
			let maxActiveLookups = 0;
			equityMarketDataService.getQuote.mockImplementation(async ({ symbol }) => {
				activeLookups += 1;
				maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
				await new Promise((resolve) => setImmediate(resolve));
				activeLookups -= 1;
				return { symbol, exchange: 'NASDAQ', price: 125.5, percentChange: 1.2 };
			});

			await fetchSymbolsPrices(['NVDA', 'AAPL']);

			expect(maxActiveLookups).toBe(1);
		});

		it('returns failed entries without rejecting for partial failures', async () => {
			mockGetAvgPrice.mockImplementation(({ symbol }) => {
				if (symbol === 'BTCUSDT') return Promise.resolve({ price: 65000 });
				const err = new Error('Invalid symbol.');
				err.code = -1121;
				return Promise.reject(err);
			});

			const results = await fetchSymbolsPrices(['BTCUSDT', 'BADUSDT']);

			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ symbol: 'BTCUSDT', success: true });
			expect(results[1]).toMatchObject({
				symbol: 'BADUSDT',
				success: false,
			});
		});

		it('captures non-user-friendly batch failures in Sentry', async () => {
			mockGetAvgPrice.mockRejectedValue(new Error('Binance unavailable'));

			await fetchSymbolsPrices(['BTCUSDT']);

			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
				channel: 'telegram',
				extra: expect.objectContaining({
					command: 'getPrice',
					symbol: 'BTCUSDT',
				}),
			}));
		});

		it('throws when batch exceeds MAX_BATCH_SYMBOLS', async () => {
			const symbols = Array.from({ length: MAX_BATCH_SYMBOLS + 1 }, (_, i) => `SYM${i}USDT`);
			await expect(fetchSymbolsPrices(symbols)).rejects.toMatchObject({
				userMessage: expect.stringContaining('ximo'),
			});
			expect(mockGetAvgPrice).not.toHaveBeenCalled();
		});

		it('returns single-element array when only one symbol is provided', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65000 });
			const results = await fetchSymbolsPrices(['BTCUSDT']);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				symbol: 'BTCUSDT',
				price: 65000,
				assetClass: 'crypto',
				success: true,
			});
		});

		it('handles mixed crypto and equity symbols in a single batch', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65000 });
			equityMarketDataService.getQuote.mockResolvedValueOnce({
				symbol: 'NVDA',
				exchange: 'NASDAQ',
				price: 125.5,
				percentChange: 2.32,
			});

			const results = await fetchSymbolsPrices(['BTCUSDT', 'NVDA']);

			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ symbol: 'BTCUSDT', assetClass: 'crypto', success: true });
			expect(results[1]).toMatchObject({ symbol: 'NVDA', assetClass: 'equity', success: true });
		});
	});

	describe('getPrice Telegram command end-to-end (batch)', () => {
		it('replies with consolidated price list for comma-separated symbols', async () => {
			mockGetAvgPrice.mockImplementation(({ symbol }) => {
				if (symbol === 'BTCUSDT') return Promise.resolve({ price: 65000 });
				if (symbol === 'ETHUSDT') return Promise.resolve({ price: 3500 });
				return Promise.reject(new Error('Unknown symbol'));
			});
			const context = buildContext('/precio BTCUSDT,ETHUSDT');

			await getPrice(context);

			expect(context.reply).toHaveBeenCalledTimes(1);
			const replyText = context.reply.mock.calls[0][0];
			expect(replyText).toContain('Precios');
			expect(replyText).toContain('BTCUSDT');
			expect(replyText).toContain('ETHUSDT');
		});

		it('includes every whitespace-separated symbol in the batch', async () => {
			mockGetAvgPrice.mockImplementation(({ symbol }) =>
				Promise.resolve({ price: symbol === 'BTCUSDT' ? 65000 : 3500 }));
			const context = buildContext('/precio BTCUSDT ETHUSDT');

			await getPrice(context);

			expect(context.reply.mock.calls[0][0]).toContain('ETHUSDT');
			expect(mockGetAvgPrice).toHaveBeenCalledTimes(2);
		});

		it('rejects batches over the cap with a helpful error', async () => {
			const symbols = Array.from({ length: MAX_BATCH_SYMBOLS + 1 }, (_, i) => `S${i}USDT`).join(',');
			const context = buildContext(`/precio ${symbols}`);

			await getPrice(context);

			expect(context.reply).toHaveBeenCalledWith(
				expect.stringContaining('ximo'),
			);
			expect(mockGetAvgPrice).not.toHaveBeenCalled();
		});

		it('preserves single-symbol behavior byte-for-byte', async () => {
			mockGetAvgPrice.mockResolvedValueOnce({ price: 65000 });
			const context = buildContext('/precio BTCUSDT');

			await getPrice(context);
			expect(context.reply).toHaveBeenCalledWith('Precio de BTCUSDT es 65000');
		});

		it('reports invalid symbols inline without blocking valid ones', async () => {
			mockGetAvgPrice.mockImplementation(({ symbol }) => {
				if (symbol === 'BTCUSDT') return Promise.resolve({ price: 65000 });
				const err = new Error('Invalid symbol.');
				err.code = -1121;
				return Promise.reject(err);
			});
			const context = buildContext('/precio BTCUSDT,BADUSDT');

			await getPrice(context);
			const replyText = context.reply.mock.calls[0][0];
			expect(replyText).toContain('BTCUSDT');
			expect(replyText).toContain('BADUSDT');
		});
	});
});
