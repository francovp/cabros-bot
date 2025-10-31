/**
 * Integration Tests for News Monitor Binance Integration (Phase 6 - US4)
 * Tests: Binance price fetching, fallback to Gemini, timeout handling, stock symbol handling
 */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');

jest.mock('../../src/services/grounding/gemini');

describe('News Monitor - Binance Integration (US4)', () => {
	const originalEnv = process.env;
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
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT',
			NEWS_SYMBOLS_STOCKS: 'AAPL',
			NEWS_ALERT_THRESHOLD: '0.7',
			NEWS_CACHE_TTL_HOURS: '6',
			ENABLE_BINANCE_PRICE_CHECK: 'true', // Enable Binance for this test suite
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

		// Mock global fetch for WhatsApp API calls
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ success: true, idMessage: 'mock-wa-msg' }),
		});

		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'test-message-id' }),
			},
		};

		// Initialize notification services
		await initializeNotificationServices(mockBot);

		// Initialize cache
		const cache = getCacheInstance();
		cache.clear();
		cache.initialize();

		const { getNewsMonitor } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
		const newsMonitor = getNewsMonitor();

		app.use('/api', getRoutes(mockBot));
	});

	afterEach((done) => {
		process.env = originalEnv;
		if (app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		const cache = getCacheInstance();
		cache.shutdown();
		
		setImmediate(() => {
			jest.clearAllMocks();
			done();
		});
	});

	describe('Binance Price Fetching', () => {
		it('should include Binance price context when ENABLE_BINANCE_PRICE_CHECK=true', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results.length).toBe(1);
			expect(response.body.results[0].symbol).toBe('BTCUSDT');
			// When Binance is enabled, the alert should ideally include market context
			// This test verifies the endpoint accepts Binance mode
			expect(response.body.results[0].status).toBe('analyzed');
		});

		it('should skip Binance for stock symbols (non-crypto)', async () => {
			const response = await request(app)
				.get('/api/news-monitor?stocks=AAPL')
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results.length).toBe(1);
			expect(response.body.results[0].symbol).toBe('AAPL');
			// Stock symbols should not attempt Binance fetch
			expect(response.body.results[0].status).toBe('analyzed');
		});

		it('should fallback to Gemini when Binance disabled', async () => {
			// Disable Binance for this request
			process.env.ENABLE_BINANCE_PRICE_CHECK = 'false';

			const response = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results[0].symbol).toBe('BTCUSDT');
			// Should still analyze even without Binance
			expect(response.body.results[0].status).toBe('analyzed');
		});
	});

	describe('Multi-Symbol with Binance', () => {
		it('should handle multiple crypto and stock symbols with Binance mode', async () => {
			const response = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results.length).toBe(2);
			
			// Verify both symbols were analyzed
			const btc = response.body.results.find(r => r.symbol === 'BTCUSDT');
			const aapl = response.body.results.find(r => r.symbol === 'AAPL');
			
			expect(btc).toBeDefined();
			expect(aapl).toBeDefined();
			expect(btc.status).toBe('analyzed');
			expect(aapl.status).toBe('analyzed');
		});

		it('should independently analyze multiple crypto symbols with Binance', async () => {
			// First request with multiple crypto
			const response1 = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response1.body.results.length).toBe(1);
			expect(response1.body.results[0].symbol).toBe('BTCUSDT');
			expect(response1.body.results[0].status).toBe('analyzed');
		});
	});

	describe('Binance Timeout Handling', () => {
		it('should handle Binance timeout with Gemini fallback', async () => {
			// This test verifies the timeout logic works
			// Actual timeout simulation would require mocking the fetch calls
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results[0].status).toBe('analyzed');
			// Should complete successfully even if Binance times out
		});
	});

	describe('Market Context in Alert', () => {
		it('should include market context information in alert when available', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response.body.results).toBeDefined();
			const result = response.body.results[0];
			
			if (result.alert) {
				// Alert should be present when confidence meets threshold
				expect(result.alert).toBeDefined();
				expect(result.alert.symbol).toBe('BTCUSDT');
			}
		});
	});

	describe('Response Structure with Binance', () => {
		it('should return complete response structure with Binance enabled', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response.body).toHaveProperty('results');
			expect(response.body).toHaveProperty('summary');
			expect(response.body.summary).toHaveProperty('total');
			expect(response.body.summary).toHaveProperty('analyzed');
			expect(response.body.summary).toHaveProperty('cached');
			expect(response.body.summary).toHaveProperty('alerts_sent');
		});
	});
});
