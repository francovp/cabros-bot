const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('News Monitor - Basic Endpoint Integration', () => {
	const originalEnv = process.env;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		process.env = {
			...originalEnv,
			ENABLE_NEWS_MONITOR: 'true',
			NODE_ENV: 'test',
			ENABLE_TELEGRAM_BOT: 'true',
			BOT_TOKEN: 'test-token',
			TELEGRAM_CHAT_ID: '123456789',
			RENDER: '',
			IS_PULL_REQUEST: '',
			GOOGLE_API_KEY: 'test-key',
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT,ETHUSD',
			NEWS_SYMBOLS_STOCKS: 'AAPL,MSFT',
		};

		jest.clearAllMocks();

		// Mock Gemini for symbol analysis
		const gemini = require('../../src/services/grounding/gemini');
		gemini.analyzeNewsForSymbol = jest.fn().mockResolvedValue({
			event_category: 'price_surge',
			event_significance: 0.7,
			sentiment_score: 0.8,
			headline: 'Bitcoin surges on positive news',
			confidence: 0.74,
			sources: ['https://example.com/news']
		});

		// Mock genaiClient search method
		const genaiClient = require('../../src/services/grounding/genaiClient');
		genaiClient.search = jest.fn().mockResolvedValue({
			results: [
				{ url: 'https://example.com/1', title: 'Source 1' },
				{ url: 'https://example.com/2', title: 'Source 2' }
			],
			searchResultText: 'Market context from search',
			totalResults: 2
		});

		// Mock global fetch for WhatsApp API calls
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ success: true, idMessage: 'mock-wa-msg' }),
		});

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-message-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
			},
		};

		// Initialize notification services with mock bot
		await initializeNotificationServices(mockBot);

		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		jest.resetModules();
	});

	describe('GET /api/news-monitor', () => {
		it('should accept GET request with default symbols', async () => {
			const res = await request(app)
				.get('/api/news-monitor')
				.expect(200);

			expect(res.body).toHaveProperty('success');
			expect(res.body).toHaveProperty('results');
			expect(Array.isArray(res.body.results)).toBe(true);
		});

		it('should accept GET request with crypto symbols', async () => {
			const res = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT,ETHUSD')
				.expect(200);

			expect(res.body).toHaveProperty('success');
			expect(res.body.results).toBeDefined();
		});

		it('should accept GET request with stock symbols', async () => {
			const res = await request(app)
				.get('/api/news-monitor?stocks=AAPL,MSFT')
				.expect(200);

			expect(res.body).toHaveProperty('success');
		});

		it('should include totalDurationMs in response', async () => {
			const res = await request(app)
				.get('/api/news-monitor')
				.expect(200);

			expect(res.body).toHaveProperty('totalDurationMs');
			expect(typeof res.body.totalDurationMs).toBe('number');
		});

		it('should include summary in response', async () => {
			const res = await request(app)
				.get('/api/news-monitor')
				.expect(200);

			expect(res.body).toHaveProperty('summary');
			expect(res.body.summary).toHaveProperty('total');
			expect(res.body.summary).toHaveProperty('analyzed');
			expect(res.body.summary).toHaveProperty('cached');
			expect(res.body.summary).toHaveProperty('timeout');
			expect(res.body.summary).toHaveProperty('error');
		});
	});

	describe('POST /api/news-monitor', () => {
		it('should accept POST request with symbol arrays', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT', 'ETHUSD'],
					stocks: ['AAPL']
				})
				.expect(200);

			expect(res.body).toHaveProperty('success');
			expect(Array.isArray(res.body.results)).toBe(true);
		});

		it('should return results array with per-symbol status', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT'],
					stocks: []
				})
				.expect(200);

			expect(Array.isArray(res.body.results)).toBe(true);
			if (res.body.results.length > 0) {
				expect(res.body.results[0]).toHaveProperty('symbol');
				expect(res.body.results[0]).toHaveProperty('status');
				expect(['analyzed', 'cached', 'timeout', 'error']).toContain(res.body.results[0].status);
			}
		});

		it('should include alert field in result', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT'],
					stocks: []
				})
				.expect(200);

			if (res.body.results.length > 0) {
				expect(res.body.results[0]).toHaveProperty('alert');
			}
		});

		it('should include cached property in per-symbol results', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT'],
					stocks: []
				})
				.expect(200);

			if (res.body.results.length > 0) {
				expect(res.body.results[0]).toHaveProperty('cached');
				expect(typeof res.body.results[0].cached).toBe('boolean');
			}
		});

		it('should use default symbols when empty arrays provided', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: [],
					stocks: []
				})
				.expect(200);

			expect(res.body).toHaveProperty('success');
			expect(res.body.results.length).toBeGreaterThan(0);
		});

		it('should handle missing request body by using defaults', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.expect(200);

			expect(res.body).toHaveProperty('success');
		});
	});

	describe('Response Structure', () => {
		it('should return consistent requestId across requests', async () => {
			const res = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(res.body).toHaveProperty('requestId');
			expect(typeof res.body.requestId).toBe('string');
			expect(res.body.requestId.length).toBeGreaterThan(0);
		});

		it('should include analysis summary', async () => {
			const res = await request(app)
				.get('/api/news-monitor')
				.expect(200);

			const summary = res.body.summary;
			expect(typeof summary.total).toBe('number');
			expect(typeof summary.analyzed).toBe('number');
			expect(typeof summary.cached).toBe('number');
			expect(typeof summary.timeout).toBe('number');
			expect(typeof summary.error).toBe('number');
		});

		it('should return success: true on valid requests', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT'],
					stocks: []
				})
				.expect(200);

			expect(res.body.success).toBe(true);
		});
	});

	describe('Error Handling', () => {
		it('should handle endpoint when feature disabled', async () => {
			process.env.ENABLE_NEWS_MONITOR = 'false';
			const res = await request(app)
				.get('/api/news-monitor');

			expect([404, 403, 400]).toContain(res.status);

			process.env.ENABLE_NEWS_MONITOR = 'true';
		});

		it('should handle missing configuration gracefully', async () => {
			const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
			delete process.env.GOOGLE_API_KEY;

			const res = await request(app)
				.get('/api/news-monitor')
				.expect(200);

			expect(res.body).toHaveProperty('success');

			if (originalGoogleApiKey) {
				process.env.GOOGLE_API_KEY = originalGoogleApiKey;
			}
		});
	});

	describe('Symbol Handling', () => {
		it('should process crypto symbols separately', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT', 'ETHUSD'],
					stocks: []
				})
				.expect(200);

			const symbols = res.body.results.map(r => r.symbol);
			expect(symbols).toContain('BTCUSDT');
			expect(symbols).toContain('ETHUSD');
		});

		it('should process stock symbols separately', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: [],
					stocks: ['AAPL', 'MSFT']
				})
				.expect(200);

			const symbols = res.body.results.map(r => r.symbol);
			expect(symbols).toContain('AAPL');
			expect(symbols).toContain('MSFT');
		});

		it('should handle mixed crypto and stock symbols', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT'],
					stocks: ['AAPL']
				})
				.expect(200);

			expect(res.body.results.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('Query Parameters', () => {
		it('should parse crypto from query string', async () => {
			const res = await request(app)
				.get('/api/news-monitor?crypto=BTC,ETH')
				.expect(200);

			expect(res.body).toHaveProperty('success');
		});

		it('should parse stocks from query string', async () => {
			const res = await request(app)
				.get('/api/news-monitor?stocks=AAPL,MSFT')
				.expect(200);

			expect(res.body).toHaveProperty('success');
		});

		it('should handle both query parameters together', async () => {
			const res = await request(app)
				.get('/api/news-monitor?crypto=BTC&stocks=AAPL')
				.expect(200);

			expect(res.body).toHaveProperty('success');
		});
	});
});
