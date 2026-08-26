/* global jest, describe, it, expect, beforeEach */

const {
	calculateFallbackRiskLevels,
	fetchQuotePriceForSignal,
	deriveFallbackTradePlan,
	TIMEFRAME_RISK_MAP,
	formatDerivedLevel,
} = require('../../src/services/tradingview/fallbackTradePlan');

describe('FallbackTradePlan', () => {
	describe('formatDerivedLevel', () => {
		it('formats prices >= 100 with 2 decimal places', () => {
			expect(formatDerivedLevel(65432.1234)).toBe(65432.12);
		});

		it('formats prices between 1 and 100 with up to 4 decimal places', () => {
			expect(formatDerivedLevel(12.34567)).toBe(12.3457);
		});

		it('formats sub-dollar prices with 6 significant digits', () => {
			expect(formatDerivedLevel(0.0001234567)).toBe(0.000123457);
		});

		it('handles non-positive or non-finite values safely', () => {
			expect(formatDerivedLevel(0)).toBe(0);
			expect(formatDerivedLevel(-5)).toBe(-5);
			expect(formatDerivedLevel(NaN)).toBeNaN();
		});
	});

	describe('calculateFallbackRiskLevels', () => {
		it('returns null for non-positive or non-finite prices', () => {
			expect(calculateFallbackRiskLevels(0, '1h', 'BUY')).toBeNull();
			expect(calculateFallbackRiskLevels(-10, '1h', 'BUY')).toBeNull();
			expect(calculateFallbackRiskLevels(NaN, '1h', 'BUY')).toBeNull();
			expect(calculateFallbackRiskLevels(null, '1h', 'BUY')).toBeNull();
		});

		it('computes 5m/15m intraday risk levels for BUY signal', () => {
			const result = calculateFallbackRiskLevels(100, '5m', 'BUY');
			expect(result).toEqual({
				current_price: 100,
				invalidation_level: 98.5, // 100 * (1 - 0.015)
				target_level: 103, // 100 * (1 + 0.030)
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
			});
		});

		it('computes 5m/15m intraday risk levels for SELL signal', () => {
			const result = calculateFallbackRiskLevels(100, '15m', 'SELL');
			expect(result).toEqual({
				current_price: 100,
				invalidation_level: 101.5, // 100 * (1 + 0.015)
				target_level: 97, // 100 * (1 - 0.030)
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
			});
		});

		it('computes 1h/4h swing risk levels for BUY signal', () => {
			const result = calculateFallbackRiskLevels(60000, '4h', 'BUY');
			expect(result).toEqual({
				current_price: 60000,
				invalidation_level: 58500, // 60000 * (1 - 0.025)
				target_level: 63000, // 60000 * (1 + 0.050)
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
			});
		});

		it('computes 1D/1W macro risk levels for BUY signal', () => {
			const result = calculateFallbackRiskLevels(1000, '1D', 'BUY');
			expect(result).toEqual({
				current_price: 1000,
				invalidation_level: 950, // 1000 * (1 - 0.050)
				target_level: 1100, // 1000 * (1 + 0.100)
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
			});
		});

		it('falls back to default 2.5%/5% risk for unknown timeframes', () => {
			const result = calculateFallbackRiskLevels(200, 'UNKNOWN', 'BUY');
			expect(result.invalidation_level).toBe(195);
			expect(result.target_level).toBe(210);
			expect(result.risk_reward_ratio).toBe(2);
		});
	});

	describe('fetchQuotePriceForSignal', () => {
		it('fetches crypto price from mock Binance client', async () => {
			const mockBinanceClient = {
				getAvgPrice: jest.fn().mockResolvedValue({ price: 65432.1 }),
			};

			const parsedSignal = {
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				assetClass: 'crypto',
			};

			const price = await fetchQuotePriceForSignal(parsedSignal, {
				binanceClient: mockBinanceClient,
			});

			expect(price).toBe(65432.1);
			expect(mockBinanceClient.getAvgPrice).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
		});

		it('returns null on Binance client error without throwing', async () => {
			const mockBinanceClient = {
				getAvgPrice: jest.fn().mockRejectedValue(new Error('Network failure')),
			};

			const parsedSignal = {
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				assetClass: 'crypto',
			};

			const price = await fetchQuotePriceForSignal(parsedSignal, {
				binanceClient: mockBinanceClient,
			});

			expect(price).toBeNull();
		});

		it('fetches equity price from mock Twelve Data service', async () => {
			const mockEquityService = {
				getStatus: jest.fn().mockReturnValue({ configured: true, enabled: true }),
				getQuote: jest.fn().mockResolvedValue({ symbol: 'AAPL', price: 230.5 }),
			};

			const parsedSignal = {
				symbol: 'AAPL',
				exchange: 'NASDAQ',
				assetClass: 'stock',
			};

			const price = await fetchQuotePriceForSignal(parsedSignal, {
				equityMarketDataService: mockEquityService,
			});

			expect(price).toBe(230.5);
			expect(mockEquityService.getQuote).toHaveBeenCalledWith(expect.objectContaining({
				symbol: 'AAPL',
				exchange: 'NASDAQ',
			}));
		});

		it('returns null if equity service is unconfigured or disabled', async () => {
			const mockEquityService = {
				getStatus: jest.fn().mockReturnValue({ configured: false, enabled: false }),
				getQuote: jest.fn(),
			};

			const parsedSignal = {
				symbol: 'AAPL',
				exchange: 'NASDAQ',
				assetClass: 'stock',
			};

			const price = await fetchQuotePriceForSignal(parsedSignal, {
				equityMarketDataService: mockEquityService,
			});

			expect(price).toBeNull();
			expect(mockEquityService.getQuote).not.toHaveBeenCalled();
		});
	});

	describe('deriveFallbackTradePlan', () => {
		it('returns null for non-signal or invalid text', async () => {
			const result = await deriveFallbackTradePlan('Just a market update without signals');
			expect(result).toBeNull();
		});

		it('derives trade plan using supplied currentPrice without external fetch', async () => {
			const result = await deriveFallbackTradePlan('BINANCE:BTCUSDT(240) pasó a señal de COMPRA', {
				currentPrice: 70000,
			});

			expect(result).toEqual({
				current_price: 70000,
				invalidation_level: 68250,
				target_level: 73500,
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
				price_data: { current_price: 70000 },
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '4h',
				side: 'BUY',
			});
		});

		it('derives trade plan using live quote fetch for crypto', async () => {
			const mockBinanceClient = {
				getAvgPrice: jest.fn().mockResolvedValue({ price: 2500 }),
			};

			const result = await deriveFallbackTradePlan('ETHUSDT(60) pasó a señal de VENTA', {
				binanceClient: mockBinanceClient,
			});

			expect(result).toEqual({
				current_price: 2500,
				invalidation_level: 2562.5, // 2500 * (1 + 0.025)
				target_level: 2375, // 2500 * (1 - 0.050)
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
				price_data: { current_price: 2500 },
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				side: 'SELL',
			});
		});
	});
});
