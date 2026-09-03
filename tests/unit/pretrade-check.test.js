'use strict';

const {
	parseSymbol,
	computeHitRate,
	summarizeHitRate,
	composePretradeCheck,
	formatPretradeCheckMessage,
} = require('../../src/controllers/pretradeCheck/pretradeCheck');

jest.mock('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol', () => ({
	classifyPriceQuery: jest.fn(),
	fetchCryptoPrice: jest.fn(),
	fetchEquityPrice: jest.fn(),
}));

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	listOutcomes: jest.fn(),
}));

const fetchPrice = require('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

describe('pretradeCheck helpers', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		fetchPrice.classifyPriceQuery.mockImplementation((value) => {
			if (!value) return { valid: false };
			return { valid: true, assetClass: 'crypto', exchange: 'BINANCE', symbol: value.toUpperCase() };
		});
	});

	describe('parseSymbol', () => {
		it('returns null for missing input', () => {
			expect(parseSymbol()).toBeNull();
			expect(parseSymbol('')).toBeNull();
			expect(parseSymbol('   ')).toBeNull();
		});

		it('returns null when classifyPriceQuery marks invalid', () => {
			fetchPrice.classifyPriceQuery.mockReturnValueOnce({ valid: false });
			expect(parseSymbol('bad')).toBeNull();
		});

		it('returns parsed symbol/exchange/assetClass when valid', () => {
			fetchPrice.classifyPriceQuery.mockReturnValueOnce({ valid: true, assetClass: 'equity', exchange: 'NASDAQ', symbol: 'NVDA' });
			const result = parseSymbol('NASDAQ:NVDA');
			expect(result).toEqual({ raw: 'NASDAQ:NVDA', symbol: 'NVDA', exchange: 'NASDAQ', assetClass: 'equity' });
		});
	});

	describe('computeHitRate', () => {
		it('returns zeros for empty array', () => {
			expect(computeHitRate([])).toEqual({ total: 0, evaluated: 0, wins: 0 });
		});

		it('ignores non-evaluated outcomes', () => {
			const result = computeHitRate([
				{ outcomes: { '1h': { status: 'pending', return: 5 } } },
				{ outcomes: { '1h': { status: 'evaluated', return: 1 } } },
			]);
			expect(result.total).toBe(1);
			expect(result.wins).toBe(1);
		});

		it('counts only positive returns as wins', () => {
			const result = computeHitRate([
				{ outcomes: { '1h': { status: 'evaluated', return: 2 }, '4h': { status: 'evaluated', return: -1 } } },
				{ outcomes: { '1h': { status: 'evaluated', return: 0.5 } } },
			]);
			expect(result.total).toBe(3);
			expect(result.wins).toBe(2);
		});

		it('treats NaN returns as non-wins', () => {
			const result = computeHitRate([
				{ outcomes: { '1h': { status: 'evaluated', return: NaN } } },
				{ outcomes: { '1h': { status: 'evaluated', return: 1 } } },
			]);
			expect(result.total).toBe(2);
			expect(result.wins).toBe(1);
		});
	});

	describe('summarizeHitRate', () => {
		it('returns unavailable when there are no evaluated windows', () => {
			expect(summarizeHitRate({ total: 0, evaluated: 0, wins: 0 })).toEqual({ available: false });
		});

		it('returns percent when there is data', () => {
			expect(summarizeHitRate({ total: 4, evaluated: 4, wins: 3 })).toEqual({
				available: true,
				evaluatedWindows: 4,
				winWindows: 3,
				hitRatePercent: 75,
			});
		});

		it('rounds to two decimals', () => {
			expect(summarizeHitRate({ total: 3, evaluated: 3, wins: 1 }).hitRatePercent).toBe(33.33);
		});
	});

	describe('composePretradeCheck', () => {
		it('returns a structured payload with price and hitRate', async () => {
			fetchPrice.fetchCryptoPrice.mockResolvedValueOnce({ symbol: 'BTCUSDT', price: 50000 });
			signalOutcomeService.isEnabled.mockReturnValueOnce(true);
			signalOutcomeService.listOutcomes.mockResolvedValueOnce({
				outcomes: [{ outcomes: { '1h': { status: 'evaluated', return: 1 } } }],
				hasMore: false,
			});

			const payload = await composePretradeCheck({
				parsedSymbol: { raw: 'BTCUSDT', symbol: 'BTCUSDT', exchange: 'BINANCE', assetClass: 'crypto' },
				limit: 100,
				requestId: 'req-1',
			});
			expect(payload.symbol).toBe('BTCUSDT');
			expect(payload.normalized.symbol).toBe('BTCUSDT');
			expect(payload.price.available).toBe(true);
			expect(payload.price.price).toBe(50000);
			expect(payload.hitRate.available).toBe(true);
			expect(payload.hitRate.hitRatePercent).toBe(100);
			expect(payload.requestId).toBe('req-1');
			expect(typeof payload.durationMs).toBe('number');
		});

		it('returns disabled reason for hitRate when tracking is off', async () => {
			fetchPrice.fetchCryptoPrice.mockResolvedValueOnce({ symbol: 'BTCUSDT', price: 50000 });
			signalOutcomeService.isEnabled.mockReturnValueOnce(false);
			const payload = await composePretradeCheck({
				parsedSymbol: { raw: 'BTCUSDT', symbol: 'BTCUSDT', exchange: 'BINANCE', assetClass: 'crypto' },
				limit: 100,
				requestId: null,
			});
			expect(payload.hitRate.available).toBe(false);
			expect(payload.hitRate.reason).toMatch(/disabled/i);
		});
	});

	describe('formatPretradeCheckMessage', () => {
		it('renders a MarkdownV2 message with price and hit-rate sections', () => {
			const message = formatPretradeCheckMessage({
				symbol: 'BTCUSDT',
				price: { available: true, price: 50000, percentChange: 1.25, assetClass: 'crypto' },
				hitRate: { available: true, hitRatePercent: 75, winWindows: 3, evaluatedWindows: 4, windowDays: 7 },
				durationMs: 42,
			});
			expect(message).toContain('BTCUSDT');
			expect(message).toContain('$50000');
			expect(message).toContain('75%');
			expect(message).toContain('42ms');
			expect(message).toContain('Pre-trade');
		});

		it('renders a graceful section when hit-rate is unavailable', () => {
			const message = formatPretradeCheckMessage({
				symbol: 'NVDA',
				price: { available: false, reason: 'Equity service disabled' },
				hitRate: { available: false, reason: 'Tracking disabled' },
				durationMs: 7,
			});
			expect(message).toContain('Equity service disabled');
			expect(message).toContain('Tracking disabled');
		});
	});
});
