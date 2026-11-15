const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const {
	initializeNotificationServices,
	resetNotificationManagerForTesting,
} = require('../../src/controllers/webhooks/handlers/alert/alert');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('News Monitor - Categories Parameter Integration Tests', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;
	let gemini;
	let genaiClient;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_NEWS_MONITOR: 'true',
			NODE_ENV: 'test',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-token',
			TELEGRAM_CHAT_ID: '123456789',
			RENDER: '',
			IS_PULL_REQUEST: '',
			GEMINI_API_KEY: 'test-key',
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT',
			NEWS_SYMBOLS_STOCKS: '',
			NEWS_ALERT_THRESHOLD: '0.7',
		});

		jest.clearAllMocks();
		resetNotificationManagerForTesting();
		getCacheInstance().clear();

		gemini = require('../../src/services/grounding/gemini');
		if (typeof gemini.analyzeNewsForSymbol?.mockResolvedValue === 'function') {
			gemini.analyzeNewsForSymbol.mockReset().mockResolvedValue({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.85,
				headline: 'Bitcoin surges on market news',
				confidence: 0.8,
				sources: ['https://example.com/news'],
			});
		} else {
			gemini.analyzeNewsForSymbol = jest.fn().mockResolvedValue({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.85,
				headline: 'Bitcoin surges on market news',
				confidence: 0.8,
				sources: ['https://example.com/news'],
			});
		}

		genaiClient = require('../../src/services/grounding/genaiClient');
		genaiClient.search = jest.fn().mockResolvedValue({
			results: [{ url: 'https://example.com/1', title: 'Source 1' }],
			searchResultText: 'Market context from search',
			totalResults: 1,
		});

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-message-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		getCacheInstance().clear();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('POST /api/news-monitor category filtering', () => {
		it('delivers alert when detected category is in requested categories', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					categories: ['price_surge', 'regulatory'],
				})
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results).toHaveLength(1);
			expect(res.body.results[0].symbol).toBe('BTCUSDT');
			expect(res.body.results[0].status).toBe('analyzed');
			expect(res.body.results[0].alert).not.toBeNull();
			expect(res.body.results[0].alert.eventCategory).toBe('price_surge');
			expect(res.body.summary.alerts_sent).toBe(1);
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		});

		it('suppresses alert when detected category is excluded by requested categories', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					categories: ['regulatory', 'public_figure'],
				})
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results).toHaveLength(1);
			expect(res.body.results[0].symbol).toBe('BTCUSDT');
			expect(res.body.results[0].status).toBe('analyzed');
			expect(res.body.results[0].alert).toBeNull();
			expect(res.body.summary.alerts_sent).toBe(0);
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('returns 400 INVALID_REQUEST on invalid category', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					categories: ['not_a_category'],
				})
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expect(res.body.error).toContain('Invalid category: "not_a_category"');
		});

		it('returns 400 INVALID_REQUEST on empty categories array', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					categories: [],
				})
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expect(res.body.error).toBe('Categories must not be empty');
		});

		it('processes all categories when categories is omitted (backward compatible)', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
				})
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results[0].alert).not.toBeNull();
			expect(res.body.results[0].alert.eventCategory).toBe('price_surge');
			expect(res.body.summary.alerts_sent).toBe(1);
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		});
	});

	describe('GET /api/news-monitor category filtering', () => {
		it('delivers alert when detected category matches query parameter', async () => {
			const res = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT&categories=price_surge')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results[0].alert).not.toBeNull();
			expect(res.body.results[0].alert.eventCategory).toBe('price_surge');
			expect(res.body.summary.alerts_sent).toBe(1);
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		});

		it('suppresses alert when detected category does not match query parameter', async () => {
			const res = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT&categories=regulatory')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results[0].alert).toBeNull();
			expect(res.body.summary.alerts_sent).toBe(0);
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('returns 400 INVALID_REQUEST when GET categories has invalid category', async () => {
			const res = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT&categories=none')
				.set('x-api-key', 'test-key')
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expect(res.body.error).toContain('Invalid category: "none"');
		});
	});
});
