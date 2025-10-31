const gemini = require('../../src/services/grounding/gemini');

jest.mock('../../src/services/grounding/gemini');

describe('Analyzer - Unit Tests', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		gemini.analyzeNewsForSymbol = jest.fn().mockResolvedValue({
			event_category: 'none',
			event_significance: 0.5,
			sentiment_score: 0.5,
			summary: 'Test analysis',
			sources: []
		});
	});

	afterEach(() => {
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

	it('analyzer should have buildAlert method', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		expect(typeof analyzer.buildAlert).toBe('function');
	});

	it('should build alert object with correct structure', () => {
		const { getAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const analyzer = getAnalyzer();
		const alert = analyzer.buildAlert('BTCUSDT', 'Test alert', {
			headline: 'Bitcoin Price Surge',
			event_category: 'price_surge',
			sentiment_score: 0.8,
			confidence: 0.75,
			event_significance: 0.9
		});

		expect(alert).toHaveProperty('symbol');
		expect(alert).toHaveProperty('text');
		expect(alert.symbol).toBe('BTCUSDT');
		expect(alert.text).toContain('Test alert');
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
