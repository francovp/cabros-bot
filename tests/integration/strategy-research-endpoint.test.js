'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { strategyResearchCache } = require('../../src/services/tradingview/strategyResearchCache');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callStrategyResearch: jest.fn(),
	},
}));

describe('Strategy Research Endpoints', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_STRATEGY_RESEARCH: 'true',
		};

		strategyResearchCache.clear();
		jest.clearAllMocks();
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = originalEnv;
		strategyResearchCache.clear();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('Feature flag gating', () => {
		it('returns 404 FEATURE_DISABLED when ENABLE_STRATEGY_RESEARCH is false', async () => {
			process.env.ENABLE_STRATEGY_RESEARCH = 'false';

			const res = await request(app)
				.get('/api/research/strategies?symbol=BTCUSDT')
				.set('x-api-key', 'test-key')
				.expect(404);

			expect(res.body.code).toBe('FEATURE_DISABLED');
		});
	});

	describe('Authentication', () => {
		it('returns 401 when API key is missing', async () => {
			await request(app)
				.get('/api/research/strategies?symbol=BTCUSDT')
				.expect(401);
		});
	});

	describe('GET /api/research/strategies', () => {
		it('executes strategy comparison, unwraps result, and caches the response', async () => {
			const mockMcpData = {
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				strategies: [
					{ strategy: 'rsi', win_rate: 0.62, profit_factor: 1.7 },
					{ strategy: 'macd', win_rate: 0.54, profit_factor: 1.2 },
				],
			};

			tradingViewMcpService.callStrategyResearch.mockResolvedValueOnce(mockMcpData);

			// First request: cache miss
			const res1 = await request(app)
				.get('/api/research/strategies?symbol=BINANCE:BTCUSDT&interval=1h&period=1y')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res1.body).toMatchObject({
				success: true,
				tool: 'compare_strategies',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				interval: '1h',
				period: '1y',
				cached: false,
				result: mockMcpData,
			});
			expect(tradingViewMcpService.callStrategyResearch).toHaveBeenCalledTimes(1);

			// Second request: cache hit (should NOT call upstream MCP again)
			const res2 = await request(app)
				.get('/api/research/strategies?symbol=BINANCE:BTCUSDT&interval=1h&period=1y')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res2.body.cached).toBe(true);
			expect(res2.body.result).toEqual(mockMcpData);
			expect(tradingViewMcpService.callStrategyResearch).toHaveBeenCalledTimes(1);
		});

		it('returns 400 when symbol is missing', async () => {
			const res = await request(app)
				.get('/api/research/strategies')
				.set('x-api-key', 'test-key')
				.expect(400);

			expect(res.body.code).toBe('MISSING_SYMBOL');
		});
	});

	describe('POST /api/research/walk-forward', () => {
		it('executes walk forward backtest and returns result', async () => {
			const mockMcpData = {
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				strategy: 'rsi',
				splits: 5,
				mean_win_rate: 0.58,
				consistency_score: 0.85,
			};

			tradingViewMcpService.callStrategyResearch.mockResolvedValueOnce(mockMcpData);

			const res = await request(app)
				.post('/api/research/walk-forward')
				.set('x-api-key', 'test-key')
				.send({
					symbol: 'BTCUSDT',
					strategy: 'rsi',
					interval: '4h', // Maps to 1h
					period: '2y',
					n_splits: 5,
				})
				.expect(200);

			expect(res.body).toMatchObject({
				success: true,
				tool: 'walk_forward_backtest_strategy',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				strategy: 'rsi',
				interval: '1h',
				period: '2y',
				cached: false,
				result: mockMcpData,
			});

			expect(tradingViewMcpService.callStrategyResearch).toHaveBeenCalledWith(
				'walk_forward_backtest_strategy',
				expect.objectContaining({
					symbol: 'BTCUSDT',
					strategy: 'rsi',
					interval: '1h',
					period: '2y',
					n_splits: 5,
				}),
				expect.any(Object)
			);
		});

		it('returns 400 on invalid strategy enum', async () => {
			const res = await request(app)
				.post('/api/research/walk-forward')
				.set('x-api-key', 'test-key')
				.send({
					symbol: 'BTCUSDT',
					strategy: 'invalid_strategy',
				})
				.expect(400);

			expect(res.body.code).toBe('UNSUPPORTED_STRATEGY');
		});
	});

	describe('POST /api/research/backtest', () => {
		it('executes single backtest successfully', async () => {
			const mockMcpData = {
				symbol: 'AAPL',
				exchange: 'NASDAQ',
				strategy: 'ema_cross',
				total_trades: 45,
				win_rate: 0.53,
				net_profit_pct: 22.4,
			};

			tradingViewMcpService.callStrategyResearch.mockResolvedValueOnce(mockMcpData);

			const res = await request(app)
				.post('/api/research/backtest')
				.set('x-api-key', 'test-key')
				.send({
					symbol: 'NASDAQ:AAPL',
					strategy: 'ema_cross',
					interval: '1d',
				})
				.expect(200);

			expect(res.body).toMatchObject({
				success: true,
				tool: 'backtest_strategy',
				symbol: 'AAPL',
				exchange: 'NASDAQ',
				strategy: 'ema_cross',
				interval: '1d',
				result: mockMcpData,
			});
		});
	});

	describe('Error handling', () => {
		it('returns 504 on upstream timeout', async () => {
			const timeoutError = new Error('request aborted due to timeout');
			timeoutError.name = 'AbortError';
			tradingViewMcpService.callStrategyResearch.mockRejectedValueOnce(timeoutError);

			const res = await request(app)
				.get('/api/research/strategies?symbol=BTCUSDT')
				.set('x-api-key', 'test-key')
				.expect(504);

			expect(res.body.code).toBe('STRATEGY_RESEARCH_TIMEOUT');
		});

		it('returns 429 when upstream rate limit is encountered', async () => {
			tradingViewMcpService.callStrategyResearch.mockRejectedValueOnce(
				new Error('Upstream HTTP 429 Too Many Requests: Rate limit exceeded')
			);

			const res = await request(app)
				.get('/api/research/strategies?symbol=BTCUSDT')
				.set('x-api-key', 'test-key')
				.expect(429);

			expect(res.body.code).toBe('UPSTREAM_RATE_LIMITED');
		});

		it('returns 502 when upstream fails with general error', async () => {
			tradingViewMcpService.callStrategyResearch.mockRejectedValueOnce(
				new Error('TradingView MCP internal service error')
			);

			const res = await request(app)
				.get('/api/research/strategies?symbol=BTCUSDT')
				.set('x-api-key', 'test-key')
				.expect(502);

			expect(res.body.code).toBe('STRATEGY_RESEARCH_FAILED');
		});
	});
});
