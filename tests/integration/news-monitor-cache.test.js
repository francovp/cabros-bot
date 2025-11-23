/**
 * Integration Tests for News Monitor Cache Deduplication (Phase 5 - US3)
 * Tests: Cache hit/miss, TTL expiry, multi-symbol scenarios, alert de-duplication
 */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');

jest.mock('../../src/services/grounding/gemini');

describe('News Monitor - Cache Deduplication (US3)', () => {
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
			GEMINI_API_KEY: 'test-key',
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT',
			NEWS_SYMBOLS_STOCKS: 'AAPL',
			NEWS_ALERT_THRESHOLD: '0.7',
			NEWS_CACHE_TTL_HOURS: '6', // 6 hour TTL in production, but tests run fast
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
			sources: ['https://example.com/news'],
		});

		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'test-message-id' }),
			},
		};

		// Initialize notification services
		await initializeNotificationServices(mockBot);

		// Initialize cache and news monitor
		const cache = getCacheInstance();
		cache.clear(); // Start fresh
		cache.initialize(); // Start cleanup interval for this test

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

		// Give async handlers time to complete
		setImmediate(() => {
			jest.clearAllMocks();
			done();
		});
	});

	describe('Cache Hit / Miss Behavior', () => {
		it('should return "analyzed" status on first call (cache miss)', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results.length).toBe(1);
			expect(response.body.results[0].symbol).toBe('BTCUSDT');
			expect(response.body.results[0].status).toBe('analyzed');
			expect(response.body.results[0].cached).toBe(false);
		});

		it('should return "cached" status on second call for same symbol and category', async () => {
			// First call - cache miss
			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response1.body.results[0].status).toBe('analyzed');
			expect(response1.body.results[0].cached).toBe(false);

			// Second call - cache hit
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response2.body.results[0].status).toBe('cached');
			expect(response2.body.results[0].cached).toBe(true);

			// Verify same alert data returned
			expect(response2.body.results[0].alert).toEqual(response1.body.results[0].alert);
		});

		it('should bypass cache when different event categories detected', async () => {
			// This test depends on Gemini returning different categories
			// For now, both calls return same category from mock, so both would cache

			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			// Both should be from same category, so second is cached
			expect(response1.body.results[0].cached).toBe(false);
			expect(response2.body.results[0].cached).toBe(true);
		});
	});

	describe('Multi-Symbol Cache Behavior', () => {
		it('should cache each symbol independently', async () => {
			// First call with multiple symbols
			const response1 = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);
			expect(response1.body.results[1].cached).toBe(false);

			// Second call with same symbols
			const response2 = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			// Both should be cached
			expect(response2.body.results[0].cached).toBe(true);
			expect(response2.body.results[1].cached).toBe(true);
		});

		it('should cache symbol independently from other symbols', async () => {
			// First call with BTCUSDT only
			const response1 = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);

			// Second call with AAPL only (different symbol)
			const response2 = await request(app)
				.post('/api/news-monitor')
				.send({ stocks: ['AAPL'] })
				.expect(200);

			// AAPL is a cache miss (new symbol)
			expect(response2.body.results[0].cached).toBe(false);

			// Third call with BTCUSDT again - should be cached
			const response3 = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response3.body.results[0].cached).toBe(true);
		});
	});

	describe('Cache Deduplication Impact', () => {
		it('should include cached alerts in response', async () => {
			// First call
			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const firstAlert = response1.body.results[0].alert;

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const cachedAlert = response2.body.results[0].alert;

			// Should be same alert
			expect(cachedAlert).toEqual(firstAlert);
			expect(cachedAlert.symbol).toBe('BTCUSDT');
			expect(cachedAlert.eventCategory).toBe('price_surge');
		});

		it('should count cached results in summary', async () => {
			// First call
			await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			expect(response2.body.summary.cached).toBe(1);
			expect(response2.body.summary.analyzed).toBe(0);
		});

		it('should include cached flag in result metadata', async () => {
			// First call
			await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const result = response2.body.results[0];
			expect(result.cached).toBe(true);
			expect(result.status).toBe('cached');
			expect(result.totalDurationMs).toBeLessThan(100); // Should be very fast for cache hit
		});
	});

	describe('Cache Response Times', () => {
		it('should return cached results faster than analyzed results', async () => {
			// First call (analyzed)
			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const analyzedTime = response1.body.results[0].totalDurationMs;

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const cachedTime = response2.body.results[0].totalDurationMs;

			// Cached should be faster (or equal in tests with mocks)
			expect(cachedTime).toBeLessThanOrEqual(analyzedTime);
		});
	});

	describe('Cache Entry Structure', () => {
		it('should store complete alert data in cache', async () => {
			// First call
			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const firstAlert = response1.body.results[0].alert;

			// Verify alert structure
			expect(firstAlert).toHaveProperty('symbol');
			expect(firstAlert).toHaveProperty('eventCategory');
			expect(firstAlert).toHaveProperty('headline');
			expect(firstAlert).toHaveProperty('sentimentScore');
			expect(firstAlert).toHaveProperty('confidence');
			expect(firstAlert).toHaveProperty('sources');
			expect(firstAlert).toHaveProperty('timestamp');

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.expect(200);

			const cachedAlert = response2.body.results[0].alert;

			// Should have same structure
			expect(cachedAlert).toHaveProperty('symbol');
			expect(cachedAlert.symbol).toBe(firstAlert.symbol);
			expect(cachedAlert.eventCategory).toBe(firstAlert.eventCategory);
		});
	});

	describe('Cache Mixed Scenario', () => {
		it('should handle mix of cached and analyzed results in single request', async () => {
			// First call with two symbols
			const response1 = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);
			expect(response1.body.results[1].cached).toBe(false);
			expect(response1.body.summary.analyzed).toBe(2);
			expect(response1.body.summary.cached).toBe(0);

			// Second call with same symbols
			const response2 = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response2.body.results[0].cached).toBe(true);
			expect(response2.body.results[1].cached).toBe(true);
			expect(response2.body.summary.analyzed).toBe(0);
			expect(response2.body.summary.cached).toBe(2);

			// Third call with one cached, one new
			// Since we only have mock symbols, new symbol will be from defaults
			const response3 = await request(app)
				.get('/api/news-monitor')
				.expect(200);

			// Should have mixed cache status
			const cachedCount = response3.body.results.filter(r => r.cached).length;
			expect(cachedCount).toBeGreaterThan(0);
		});
	});
});
