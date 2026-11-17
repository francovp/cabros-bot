'use strict';

const {
	StrategyResearchRequestError,
	SUPPORTED_STRATEGIES,
	SUPPORTED_INTERVALS,
	parseCompareStrategiesRequest,
	parseWalkForwardRequest,
	parseBacktestRequest,
	normalizeResearchInterval,
	parseResearchSymbolIdentifier,
} = require('../../src/services/tradingview/strategyResearchRequest');

describe('strategyResearchRequest', () => {
	describe('parseResearchSymbolIdentifier', () => {
		it('parses EXCHANGE:SYMBOL format correctly', () => {
			const parsed = parseResearchSymbolIdentifier('BINANCE:BTCUSDT');
			expect(parsed).toEqual({
				raw: 'BINANCE:BTCUSDT',
				exchange: 'BINANCE',
				symbol: 'BTCUSDT',
			});
		});

		it('parses bare symbol with default exchange', () => {
			const parsed = parseResearchSymbolIdentifier('BTCUSDT', 'BINANCE');
			expect(parsed).toEqual({
				raw: 'BINANCE:BTCUSDT',
				exchange: 'BINANCE',
				symbol: 'BTCUSDT',
			});
		});

		it('throws on invalid or missing symbol', () => {
			expect(() => parseResearchSymbolIdentifier('')).toThrow(StrategyResearchRequestError);
			expect(() => parseResearchSymbolIdentifier(null)).toThrow(StrategyResearchRequestError);
			expect(() => parseResearchSymbolIdentifier(123)).toThrow(StrategyResearchRequestError);
		});
	});

	describe('normalizeResearchInterval', () => {
		it('accepts 1h and 1d intervals', () => {
			expect(normalizeResearchInterval('1h')).toBe('1h');
			expect(normalizeResearchInterval('1d')).toBe('1d');
			expect(normalizeResearchInterval('1H')).toBe('1h');
			expect(normalizeResearchInterval('1D')).toBe('1d');
		});

		it('maps 4h and 240 to 1h as required by TradingView MCP', () => {
			expect(normalizeResearchInterval('4h')).toBe('1h');
			expect(normalizeResearchInterval('4H')).toBe('1h');
			expect(normalizeResearchInterval('240')).toBe('1h');
		});

		it('defaults to 1h if omitted or empty', () => {
			expect(normalizeResearchInterval(undefined)).toBe('1h');
			expect(normalizeResearchInterval('')).toBe('1h');
		});

		it('throws on unsupported interval', () => {
			expect(() => normalizeResearchInterval('15m')).toThrow(StrategyResearchRequestError);
			expect(() => normalizeResearchInterval('invalid')).toThrow(StrategyResearchRequestError);
		});
	});

	describe('parseCompareStrategiesRequest', () => {
		it('parses valid query parameters', () => {
			const req = {
				query: {
					symbol: 'BINANCE:BTCUSDT',
					interval: '1h',
					period: '1y',
					initial_capital: '10000',
					commission_pct: '0.1',
					slippage_pct: '0.05',
				},
			};

			const parsed = parseCompareStrategiesRequest(req);
			expect(parsed.symbol).toBe('BTCUSDT');
			expect(parsed.exchange).toBe('BINANCE');
			expect(parsed.interval).toBe('1h');
			expect(parsed.period).toBe('1y');
			expect(parsed.initial_capital).toBe(10000);
			expect(parsed.commission_pct).toBe(0.1);
			expect(parsed.slippage_pct).toBe(0.05);
		});

		it('accepts separate symbol and exchange params', () => {
			const req = {
				query: {
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
				},
			};

			const parsed = parseCompareStrategiesRequest(req);
			expect(parsed.symbol).toBe('ETHUSDT');
			expect(parsed.exchange).toBe('BINANCE');
			expect(parsed.interval).toBe('1h');
			expect(parsed.period).toBe('1y');
		});

		it('throws if symbol is missing', () => {
			const req = { query: {} };
			expect(() => parseCompareStrategiesRequest(req)).toThrow(StrategyResearchRequestError);
		});

		it('rejects negative initial capital', () => {
			const req = {
				query: {
					symbol: 'BTCUSDT',
					initial_capital: '-500',
				},
			};
			expect(() => parseCompareStrategiesRequest(req)).toThrow(StrategyResearchRequestError);
		});
	});

	describe('parseWalkForwardRequest', () => {
		it('parses valid walk forward body', () => {
			const req = {
				body: {
					symbol: 'BINANCE:BTCUSDT',
					strategy: 'rsi',
					interval: '4h', // Should map to 1h
					period: '2y',
					n_splits: 5,
					train_ratio: 0.7,
					initial_capital: 10000,
					commission_pct: 0.075,
					slippage_pct: 0.01,
					include_trade_log: true,
				},
			};

			const parsed = parseWalkForwardRequest(req);
			expect(parsed.symbol).toBe('BTCUSDT');
			expect(parsed.exchange).toBe('BINANCE');
			expect(parsed.strategy).toBe('rsi');
			expect(parsed.interval).toBe('1h');
			expect(parsed.period).toBe('2y');
			expect(parsed.n_splits).toBe(5);
			expect(parsed.train_ratio).toBe(0.7);
			expect(parsed.include_trade_log).toBe(true);
		});

		it('throws on unsupported strategy enum', () => {
			const req = {
				body: {
					symbol: 'BTCUSDT',
					strategy: 'random_walk',
				},
			};
			expect(() => parseWalkForwardRequest(req)).toThrow(StrategyResearchRequestError);
		});

		it('validates n_splits bounds (2 to 10)', () => {
			expect(() => parseWalkForwardRequest({
				body: { symbol: 'BTCUSDT', strategy: 'rsi', n_splits: 1 },
			})).toThrow(StrategyResearchRequestError);

			expect(() => parseWalkForwardRequest({
				body: { symbol: 'BTCUSDT', strategy: 'rsi', n_splits: 15 },
			})).toThrow(StrategyResearchRequestError);
		});

		it('validates train_ratio bounds (0.5 to 0.9)', () => {
			expect(() => parseWalkForwardRequest({
				body: { symbol: 'BTCUSDT', strategy: 'macd', train_ratio: 0.3 },
			})).toThrow(StrategyResearchRequestError);

			expect(() => parseWalkForwardRequest({
				body: { symbol: 'BTCUSDT', strategy: 'macd', train_ratio: 0.95 },
			})).toThrow(StrategyResearchRequestError);
		});
	});

	describe('parseBacktestRequest', () => {
		it('parses valid backtest body', () => {
			const req = {
				body: {
					symbol: 'NASDAQ:AAPL',
					strategy: 'ema_cross',
					interval: '1d',
					period: '1y',
					initial_capital: 50000,
				},
			};

			const parsed = parseBacktestRequest(req);
			expect(parsed.symbol).toBe('AAPL');
			expect(parsed.exchange).toBe('NASDAQ');
			expect(parsed.strategy).toBe('ema_cross');
			expect(parsed.interval).toBe('1d');
			expect(parsed.period).toBe('1y');
			expect(parsed.initial_capital).toBe(50000);
		});

		it('throws if strategy is missing', () => {
			const req = {
				body: {
					symbol: 'BTCUSDT',
				},
			};
			expect(() => parseBacktestRequest(req)).toThrow(StrategyResearchRequestError);
		});
	});
});
