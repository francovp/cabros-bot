const gemini = require('../../src/services/grounding/gemini');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient', () => ({
	search: jest.fn().mockResolvedValue({
		results: [
			{ url: 'https://example.com/1', title: 'Source 1' },
		],
		searchResultText: 'Market context',
		totalResults: 1,
	}),
	llmCall: jest.fn(),
}));

describe('Analyzer - Unit Tests', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		gemini.analyzeNewsForSymbol = jest.fn().mockResolvedValue({
			event_category: 'price_surge',
			event_significance: 0.8,
			sentiment_score: 0.8,
			headline: 'Bitcoin surges on positive news',
			confidence: 0.8,
			sources: ['https://example.com/news'],
		});
	});

	afterEach(() => {
		delete process.env.NEWS_GEMINI_CONCURRENCY;
		delete process.env.NEWS_GEMINI_QUOTA_MAX_RETRIES;
		delete process.env.NEWS_GEMINI_QUOTA_RETRY_BASE_MS;
		jest.resetModules();
	});

	it('should import analyzer module without errors', () => {
		expect(() => {
			require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		}).not.toThrow();
	});

	it('should export getAnalyzer and NewsAnalyzer', () => {
		const { getAnalyzer, NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		expect(typeof getAnalyzer).toBe('function');
		expect(typeof NewsAnalyzer).toBe('function');
	});

	it('should return singleton analyzer instance', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer1 = getAnalyzer();
		const analyzer2 = getAnalyzer();
		expect(analyzer1).toBe(analyzer2);
	});

	it('analyzer should have analyzeSymbols method', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		expect(typeof analyzer.analyzeSymbols).toBe('function');
	});

	it('should handle empty symbol array', async () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		const results = await analyzer.analyzeSymbols([]);
		expect(Array.isArray(results)).toBe(true);
		expect(results.length).toBe(0);
	});

	it('should obey configured Gemini concurrency when analyzing multiple symbols', async () => {
		process.env.NEWS_GEMINI_CONCURRENCY = '2';
		const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = new NewsAnalyzer();
		let active = 0;
		let maxActive = 0;
		const releaseQueue = [];

		analyzer.analyzeSymbol = jest.fn(async (symbol) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise(resolve => releaseQueue.push(resolve));
			active -= 1;
			return { symbol, status: 'analyzed', cached: false };
		});

		const run = analyzer.analyzeSymbols(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'], 'req-1');
		await Promise.resolve();
		await Promise.resolve();

		expect(analyzer.analyzeSymbol).toHaveBeenCalledTimes(2);
		expect(maxActive).toBeLessThanOrEqual(2);

		while (releaseQueue.length > 0) {
			releaseQueue.shift()();
			await Promise.resolve();
			await Promise.resolve();
		}

		const results = await run;
		expect(results).toHaveLength(4);
		expect(maxActive).toBeLessThanOrEqual(2);
	});

	it('should not give queued symbols a fresh timeout beyond the batch budget', async () => {
		process.env.NEWS_GEMINI_CONCURRENCY = '1';
		const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = new NewsAnalyzer();
		analyzer.timeout = 25;
		analyzer.analyzeSymbolInternal = jest.fn(() => new Promise(() => {}));

		const results = await analyzer.analyzeSymbols(['BTCUSDT', 'ETHUSDT'], 'req-batch-timeout');

		expect(analyzer.analyzeSymbolInternal).toHaveBeenCalledTimes(1);
		expect(results).toEqual([
			expect.objectContaining({ symbol: 'BTCUSDT', status: 'timeout' }),
			expect.objectContaining({ symbol: 'ETHUSDT', status: 'timeout' }),
		]);
	});

	it('should retry Gemini quota exhaustion within the symbol timeout budget', async () => {
		process.env.NEWS_GEMINI_QUOTA_MAX_RETRIES = '1';
		process.env.NEWS_GEMINI_QUOTA_RETRY_BASE_MS = '1';
		const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = new NewsAnalyzer();
		analyzer.timeout = 1000;
		const quotaError = new Error('429 RESOURCE_EXHAUSTED: quota exceeded. RetryDelay: 1ms');
		analyzer.analyzeSymbolInternal = jest.fn()
			.mockRejectedValueOnce(quotaError)
			.mockResolvedValueOnce({ status: 'analyzed', alert: null, cached: false });

		const result = await analyzer.analyzeSymbol('BTCUSDT', 'req-2');

		expect(analyzer.analyzeSymbolInternal).toHaveBeenCalledTimes(2);
		expect(result.status).toBe('analyzed');
		expect(result.error).toBeUndefined();
	});

	it('should honor quoted Gemini retryDelay values from RetryInfo JSON', async () => {
		process.env.NEWS_GEMINI_QUOTA_MAX_RETRIES = '1';
		process.env.NEWS_GEMINI_QUOTA_RETRY_BASE_MS = '1000';
		const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = new NewsAnalyzer();
		analyzer.timeout = 100;
		const quotaError = new Error('429 RESOURCE_EXHAUSTED: {"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"1ms"}]}}');
		analyzer.analyzeSymbolInternal = jest.fn()
			.mockRejectedValueOnce(quotaError)
			.mockResolvedValueOnce({ status: 'analyzed', alert: null, cached: false });

		const result = await analyzer.analyzeSymbol('BTCUSDT', 'req-json-retry');

		expect(analyzer.analyzeSymbolInternal).toHaveBeenCalledTimes(2);
		expect(result.status).toBe('analyzed');
		expect(result.error).toBeUndefined();
	});

	it('should return deterministic quota errors when retries are exhausted', async () => {
		process.env.NEWS_GEMINI_QUOTA_MAX_RETRIES = '1';
		process.env.NEWS_GEMINI_QUOTA_RETRY_BASE_MS = '1';
		const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = new NewsAnalyzer();
		const quotaError = new Error('429 RESOURCE_EXHAUSTED: quota exceeded. RetryDelay: 1ms');
		analyzer.analyzeSymbolInternal = jest.fn().mockRejectedValue(quotaError);

		const results = await analyzer.analyzeSymbols(['BTCUSDT'], 'req-3');

		expect(analyzer.analyzeSymbolInternal).toHaveBeenCalledTimes(2);
		expect(results[0]).toEqual(expect.objectContaining({
			symbol: 'BTCUSDT',
			status: 'error',
			error: expect.objectContaining({
				code: 'GEMINI_QUOTA_EXHAUSTED',
			}),
		}));
	});

	it('should retry when Gemini price search returns quota exhaustion', async () => {
		process.env.NEWS_GEMINI_QUOTA_MAX_RETRIES = '1';
		process.env.NEWS_GEMINI_QUOTA_RETRY_BASE_MS = '1';
		const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const activeGemini = require('../../src/services/grounding/gemini');
		const activeGenaiClient = require('../../src/services/grounding/genaiClient');
		const analyzer = new NewsAnalyzer();
		analyzer.timeout = 1000;
		const quotaError = new Error('429 RESOURCE_EXHAUSTED: {"error":{"details":[{"retryDelay":"1ms"}]}}');
		activeGemini.analyzeNewsForSymbol.mockResolvedValue({
			event_category: 'price_surge',
			event_significance: 0.8,
			sentiment_score: 0.8,
			headline: 'Bitcoin surges on positive news',
			confidence: 0.8,
			sources: ['https://example.com/news'],
		});
		activeGenaiClient.search
			.mockRejectedValueOnce(quotaError)
			.mockResolvedValueOnce({
				searchResultText: '{"price":"100","change_24h":"1.5","context":"ok","sources":[]}',
				results: [],
			});

		const result = await analyzer.analyzeSymbol('BTCUSDT', 'req-price-quota');

		expect(activeGenaiClient.search).toHaveBeenCalledTimes(2);
		expect(activeGemini.analyzeNewsForSymbol).toHaveBeenCalledTimes(1);
		expect(result.status).toBe('analyzed');
	});

	it('analyzer should have buildAlert method', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		expect(typeof analyzer.buildAlert).toBe('function');
	});

	it('should build alert object with correct structure', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		const geminiAnalysis = {
			headline: 'Bitcoin Price Surge',
			event_category: 'price_surge',
			sentiment_score: 0.8,
			confidence: 0.75,
			event_significance: 0.9,
			sources: ['https://example.com'],
		};
		const marketContext = {
			price: 42000,
			change24h: 5.2,
			source: 'binance',
			timestamp: Date.now(),
		};
		const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, marketContext);

		expect(alert).toHaveProperty('symbol');
		expect(alert).toHaveProperty('enriched');
		expect(alert.symbol).toBe('BTCUSDT');
		expect(alert.eventCategory).toBe('price_surge');
		expect(alert.confidence).toBe(0.75);
		expect(alert.enriched.originalText).toContain('BTCUSDT');
	});

	it('analyzer should have getMarketContext method', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		expect(typeof analyzer.getMarketContext).toBe('function');
	});

	it('should return market context object', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		const context = analyzer.getMarketContext('BTCUSDT');
		expect(typeof context).toBe('object');
	});
});
