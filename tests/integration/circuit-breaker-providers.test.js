const request = require('supertest');
const express = require('express');
const { getRoutes } = require('../../src/routes');
const groundingService = require('../../src/services/grounding/grounding');
const equityMarketDataService = require('../../src/services/storage/EquityMarketDataService');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const genaiClient = require('../../src/services/grounding/genaiClient');
const { generateEnrichedAlert } = require('../../src/services/grounding/gemini');

jest.mock('../../src/services/grounding/genaiClient');
jest.mock('../../src/services/grounding/gemini');

describe('Circuit Breakers for External API Providers', () => {
	let app;
	let originalFetch;

	beforeEach(() => {
		originalFetch = global.fetch;
		groundingService._resetForTesting();
		equityMarketDataService._resetCircuitBreakerForTesting();
		tradingViewMcpService._resetForTesting();
		tradingViewMcpService.runtimeStatus = {
			status: 'ready',
			lastCheckedAt: new Date().toISOString(),
			lastSuccessAt: new Date().toISOString(),
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 1,
			failureCount: 0,
		};

		process.env.WEBHOOK_API_KEY = 'test-key';
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		process.env.GEMINI_MODEL_NAME = 'gemini-2.5-flash';
		process.env.MODEL_PROVIDER = 'gemini';
		process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
		process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
		process.env.TWELVE_DATA_API_KEY = 'test-twelve-data-key';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
		process.env.TRADINGVIEW_MCP_URL = 'https://mcp.test';
		process.env.CIRCUIT_BREAKER_THRESHOLD = '2';
		process.env.TRADINGVIEW_MCP_BREAKER_FAILURE_THRESHOLD = '2';
		process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '1000';
		process.env.TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS = '1000';

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => null));
	});

	afterEach(() => {
		global.fetch = originalFetch;
		groundingService._resetForTesting();
		equityMarketDataService._resetCircuitBreakerForTesting();
		tradingViewMcpService._resetForTesting();
		delete process.env.CIRCUIT_BREAKER_THRESHOLD;
		delete process.env.TRADINGVIEW_MCP_BREAKER_FAILURE_THRESHOLD;
		delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
		delete process.env.TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS;
		delete process.env.EQUITY_MARKET_DATA_PROVIDER;
	});

	describe('Twelve Data Provider', () => {
		it('trips breaker after consecutive failures, fast-fails requests, and degrades /api/status', async () => {
			let fetchCallCount = 0;
			global.fetch = jest.fn().mockImplementation(() => {
				fetchCallCount += 1;
				return Promise.reject(new Error('Twelve Data gateway timeout'));
			});

			// Initial status should be ready
			let res = await request(app).get('/api/status').set('x-api-key', 'test-key');
			expect(res.status).toBe(200);
			expect(res.body.dependencies.equityMarketData.status).toBe('ready');
			expect(res.body.dependencies.equityMarketData.ready).toBe(true);
			expect(res.body.dependencies.equityMarketData.circuitBreaker.state).toBe('closed');

			// Trigger 2 failures to trip the threshold
			await expect(equityMarketDataService.getQuote({ symbol: 'AAPL', exchange: 'NASDAQ' })).rejects.toThrow(equityMarketDataService.REASONS.UNAVAILABLE);
			await expect(equityMarketDataService.getQuote({ symbol: 'AAPL', exchange: 'NASDAQ' })).rejects.toThrow(equityMarketDataService.REASONS.UNAVAILABLE);

			expect(fetchCallCount).toBe(2);

			// Breaker is now open
			const breakerStatus = equityMarketDataService.getCircuitBreakerStatus();
			expect(breakerStatus.state).toBe('open');

			// Fast-fails subsequent call without making a network request
			await expect(equityMarketDataService.getQuote({ symbol: 'AAPL', exchange: 'NASDAQ' })).rejects.toMatchObject({
				status: 503,
				reason: equityMarketDataService.REASONS.CIRCUIT_BREAKER_OPEN,
			});
			expect(fetchCallCount).toBe(2); // no extra fetch call

			// Status endpoint now reflects degraded state
			res = await request(app).get('/api/status').set('x-api-key', 'test-key');
			expect(res.body.dependencies.equityMarketData.status).toBe('degraded');
			expect(res.body.dependencies.equityMarketData.ready).toBe(false);
			expect(res.body.dependencies.equityMarketData.circuitBreaker.state).toBe('open');

			// After cooldown, recovers on successful call
			const cb = equityMarketDataService._getCircuitBreakerForTesting();
			cb.openedAt = new Date(Date.now() - 10000).toISOString();

			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ symbol: 'AAPL', exchange: 'NASDAQ', close: '230.50', datetime: '2026-09-03 16:00:00' }),
			});

			const quote = await equityMarketDataService.getQuote({ symbol: 'AAPL', exchange: 'NASDAQ' });
			expect(quote.price).toBe(230.5);
			expect(equityMarketDataService.getCircuitBreakerStatus().state).toBe('closed');

			res = await request(app).get('/api/status').set('x-api-key', 'test-key');
			expect(res.body.dependencies.equityMarketData.status).toBe('ready');
			expect(res.body.dependencies.equityMarketData.ready).toBe(true);
		});
	});

	describe('Gemini Provider', () => {
		it('trips breaker after consecutive failures, fast-fails grounding, falls back on query derivation, and degrades /api/status', async () => {
			genaiClient.search.mockRejectedValue(new Error('Resource exhausted / quota exceeded'));

			// Initial status should be ready
			let res = await request(app).get('/api/status').set('x-api-key', 'test-key');
			expect(res.status).toBe(200);
			expect(res.body.dependencies.gemini.status).toBe('ready');
			expect(res.body.dependencies.gemini.ready).toBe(true);
			expect(res.body.dependencies.gemini.circuitBreaker.state).toBe('closed');

			// Trigger 2 failures to trip the threshold
			await expect(groundingService.groundAlert({ text: 'Signal 1' })).rejects.toThrow();
			await expect(groundingService.groundAlert({ text: 'Signal 2' })).rejects.toThrow();

			expect(groundingService.getCircuitBreakerStatus().state).toBe('open');

			// /api/status reflects degraded dependency
			res = await request(app).get('/api/status').set('x-api-key', 'test-key');
			expect(res.body.dependencies.gemini.status).toBe('degraded');
			expect(res.body.dependencies.gemini.ready).toBe(false);
			expect(res.body.dependencies.gemini.circuitBreaker.state).toBe('open');

			// groundAlert fast-fails with 503 circuit_breaker_open
			genaiClient.search.mockClear();
			generateEnrichedAlert.mockClear();
			await expect(groundingService.groundAlert({ text: 'Signal 3' })).rejects.toMatchObject({
				category: 'circuit_breaker_open',
			});
			expect(genaiClient.search).not.toHaveBeenCalled();

			// deriveSearchQuery falls back without LLM call
			genaiClient.llmCallv2.mockClear();
			const query = await groundingService.deriveSearchQuery('Quick alert message');
			expect(query).toBe('Quick alert message');
			expect(genaiClient.llmCallv2).not.toHaveBeenCalled();

			// Recovery after cooldown
			const cb = groundingService._getCircuitBreakerForTesting();
			cb.openedAt = new Date(Date.now() - 10000).toISOString();

			genaiClient.search.mockResolvedValueOnce({
				results: [{ title: 'Title', snippet: 'Snippet', url: 'https://test.com', sourceDomain: 'test.com' }],
				totalResults: 1,
			});
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'BULLISH',
				sentiment_score: 0.8,
				insights: ['Recovered'],
				sources: [],
			});

			await groundingService.groundAlert({ text: 'Probe alert' });
			expect(groundingService.getCircuitBreakerStatus().state).toBe('closed');

			res = await request(app).get('/api/status').set('x-api-key', 'test-key');
			expect(res.body.dependencies.gemini.status).toBe('ready');
			expect(res.body.dependencies.gemini.ready).toBe(true);
		});
	});

	describe('TradingView MCP Provider', () => {
		it('trips breaker after consecutive failures, fast-fails MCP calls, and degrades /api/status', async () => {
			let mcpCallCount = 0;
			const originalCallTool = tradingViewMcpService._callTool;
			tradingViewMcpService._callTool = jest.fn().mockImplementation(() => {
				mcpCallCount += 1;
				return Promise.reject(new Error('MCP server 503 unavailable'));
			});

			try {
				// Initial status is ready
				let res = await request(app).get('/api/status').set('x-api-key', 'test-key');
				expect(res.status).toBe(200);
				expect(res.body.dependencies.tradingViewMcp.status).toBe('ready');
				expect(res.body.dependencies.tradingViewMcp.circuitBreaker.state).toBe('closed');

				// Trigger 2 failures to trip the breaker
				await expect(tradingViewMcpService.callCoinAnalysis({ exchange: 'BINANCE', symbol: 'BTCUSDT' })).rejects.toThrow();
				await expect(tradingViewMcpService.callCoinAnalysis({ exchange: 'BINANCE', symbol: 'BTCUSDT' })).rejects.toThrow();

				expect(mcpCallCount).toBe(2);
				expect(tradingViewMcpService.getCircuitBreakerStatus().state).toBe('open');

				// Fast-fails without invoking _callTool
				await expect(tradingViewMcpService.callCoinAnalysis({ exchange: 'BINANCE', symbol: 'BTCUSDT' })).rejects.toThrow('TradingView MCP circuit breaker is OPEN');
				expect(mcpCallCount).toBe(2);

				// /api/status reflects degraded state
				res = await request(app).get('/api/status').set('x-api-key', 'test-key');
				expect(res.body.dependencies.tradingViewMcp.status).toBe('degraded');
				expect(res.body.dependencies.tradingViewMcp.ready).toBe(false);
				expect(res.body.dependencies.tradingViewMcp.circuitBreaker.state).toBe('open');

				// Probe recovery
				tradingViewMcpService.breakerOpenedAt = new Date(Date.now() - 10000).toISOString();
				tradingViewMcpService._callTool = jest.fn().mockResolvedValue({
					structuredContent: { analysis: 'Bullish momentum' },
				});

				const result = await tradingViewMcpService.callCoinAnalysis({ exchange: 'BINANCE', symbol: 'BTCUSDT' });
				expect(result.structuredContent.analysis).toBe('Bullish momentum');
				expect(tradingViewMcpService.getCircuitBreakerStatus().state).toBe('closed');

				res = await request(app).get('/api/status').set('x-api-key', 'test-key');
				expect(res.body.dependencies.tradingViewMcp.status).toBe('ready');
				expect(res.body.dependencies.tradingViewMcp.ready).toBe(true);
			} finally {
				tradingViewMcpService._callTool = originalCallTool;
			}
		});
	});
});
