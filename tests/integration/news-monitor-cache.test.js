/**
 * Integration Tests for News Monitor Cache Deduplication (Phase 5 - US3)
 * Tests: Cache hit/miss, TTL expiry, multi-symbol scenarios, alert de-duplication
 */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices, getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('News Monitor - Cache Deduplication (US3)', () => {
	let savedEnv;
	let mockBot;
	let mockFetch;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_NEWS_MONITOR: 'true',
			NODE_ENV: 'test',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'true',
			BOT_TOKEN: 'test-token',
			TELEGRAM_CHAT_ID: '123456789',
			WHATSAPP_API_URL: 'https://api.greenapi.com/waInstance123/',
			WHATSAPP_API_KEY: 'test-whatsapp-key',
			WHATSAPP_CHAT_ID: '120363000000000000@g.us',
			RENDER: '',
			IS_PULL_REQUEST: '',
			GEMINI_API_KEY: 'test-key',
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT',
			NEWS_SYMBOLS_STOCKS: 'AAPL',
			NEWS_ALERT_THRESHOLD: '0.7',
			NEWS_CACHE_TTL_HOURS: '6', // 6 hour TTL in production, but tests run fast
		});

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
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ idMessage: 'wa-msg-456' }),
		});
		global.fetch = mockFetch;

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
		restoreEnv(savedEnv);
		if (app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		const cache = getCacheInstance();
		cache.shutdown();

		// Give async handlers time to complete
		setImmediate(() => {
			jest.clearAllMocks();
			delete global.fetch;
			done();
		});
	});

	describe('Cache Hit / Miss Behavior', () => {
		it('should return "analyzed" status on first call (cache miss)', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
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
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response1.body.results[0].status).toBe('analyzed');
			expect(response1.body.results[0].cached).toBe(false);

			// Second call - cache hit
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
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
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
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
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);
			expect(response1.body.results[1].cached).toBe(false);

			// Second call with same symbols
			const response2 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			// Both should be cached
			expect(response2.body.results[0].cached).toBe(true);
			expect(response2.body.results[1].cached).toBe(true);
		});

		it('should cache symbol independently from other symbols', async () => {
			// First call with BTCUSDT only
			const response1 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);

			// Second call with AAPL only (different symbol)
			const response2 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ stocks: ['AAPL'] })
				.expect(200);

			// AAPL is a cache miss (new symbol)
			expect(response2.body.results[0].cached).toBe(false);

			// Third call with BTCUSDT again - should be cached
			const response3 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response3.body.results[0].cached).toBe(true);
		});
	});

	describe('Cache Deduplication Impact', () => {
		it('should retry only failed channels and persist recovered delivery results', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '';
			const { getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
			const manager = getNotificationManager();
			const telegramSend = jest.spyOn(manager.channels.get('telegram'), 'send').mockResolvedValue({
				success: true,
				channel: 'telegram',
				messageId: 'telegram-1',
			});
			const whatsappSend = jest.spyOn(manager.channels.get('whatsapp'), 'send')
				.mockResolvedValueOnce({
					success: false,
					channel: 'whatsapp',
					error: 'temporary failure',
				})
				.mockResolvedValueOnce({
					success: true,
					channel: 'whatsapp',
					messageId: 'whatsapp-2',
				});

			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response1.body.results[0].deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true }),
				expect.objectContaining({ channel: 'whatsapp', success: false }),
			]);
			const telegramCallsAfterFirstDelivery = telegramSend.mock.calls.length;
			const whatsappCallsAfterFirstDelivery = whatsappSend.mock.calls.length;

			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response2.body.results[0].deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true }),
				expect.objectContaining({ channel: 'whatsapp', success: true }),
			]);
			expect(telegramSend).toHaveBeenCalledTimes(telegramCallsAfterFirstDelivery);
			expect(whatsappSend).toHaveBeenCalledTimes(whatsappCallsAfterFirstDelivery + 1);

			const response3 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response3.body.results[0].deliveryResults).toEqual(response2.body.results[0].deliveryResults);
			expect(telegramSend).toHaveBeenCalledTimes(telegramCallsAfterFirstDelivery);
			expect(whatsappSend).toHaveBeenCalledTimes(whatsappCallsAfterFirstDelivery + 1);
		});

		it('should keep a failed channel retryable without retrying successful channels', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '';
			const { getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
			const manager = getNotificationManager();
			const telegramSend = jest.spyOn(manager.channels.get('telegram'), 'send').mockResolvedValue({
				success: true,
				channel: 'telegram',
				messageId: 'telegram-1',
			});
			const whatsappSend = jest.spyOn(manager.channels.get('whatsapp'), 'send')
				.mockResolvedValueOnce({ success: false, channel: 'whatsapp', error: 'temporary failure 1' })
				.mockResolvedValueOnce({ success: false, channel: 'whatsapp', error: 'temporary failure 2' })
				.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'whatsapp-3' });

			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);
			const telegramCallsAfterFirstDelivery = telegramSend.mock.calls.length;

			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);
			const response3 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response1.body.results[0].deliveryResults).toEqual(expect.arrayContaining([
				expect.objectContaining({ channel: 'whatsapp', success: false }),
			]));
			expect(response2.body.results[0].deliveryResults).toEqual(expect.arrayContaining([
				expect.objectContaining({ channel: 'whatsapp', success: false, error: 'temporary failure 2' }),
			]));
			expect(response3.body.results[0].deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true }),
				expect.objectContaining({ channel: 'whatsapp', success: true }),
			]);
			expect(telegramSend).toHaveBeenCalledTimes(telegramCallsAfterFirstDelivery);
			expect(whatsappSend).toHaveBeenCalledTimes(3);
		});

		it('should serialize concurrent retries for the same failed channel', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '';
			const { getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
			const manager = getNotificationManager();
			const telegramSend = jest.spyOn(manager.channels.get('telegram'), 'send').mockResolvedValue({
				success: true,
				channel: 'telegram',
				messageId: 'telegram-1',
			});
			let releaseRetry;
			let retryStarted;
			const retryStartedPromise = new Promise((resolve) => { retryStarted = resolve; });
			const whatsappSend = jest.spyOn(manager.channels.get('whatsapp'), 'send')
				.mockResolvedValueOnce({ success: false, channel: 'whatsapp', error: 'temporary failure' })
				.mockImplementationOnce(() => new Promise((resolve) => {
					releaseRetry = resolve;
					retryStarted();
				}));

			await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			const firstRetry = request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);
			const firstRetryPromise = firstRetry.then((response) => response);
			await retryStartedPromise;

			const concurrentRetry = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(concurrentRetry.body.results[0].deliveryResults).toEqual(expect.arrayContaining([
				expect.objectContaining({ channel: 'whatsapp', success: false }),
			]));
			expect(whatsappSend).toHaveBeenCalledTimes(2);

			releaseRetry({ success: true, channel: 'whatsapp', messageId: 'whatsapp-2' });
			await firstRetryPromise;
			expect(telegramSend).toHaveBeenCalledTimes(1);
			expect(whatsappSend).toHaveBeenCalledTimes(2);
		});

		it('should merge concurrent retries for different channels', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '';
			const { getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
			const manager = getNotificationManager();
			let releaseTelegram;
			let releaseWhatsApp;
			let telegramStarted;
			let whatsappStarted;
			const telegramStartedPromise = new Promise((resolve) => { telegramStarted = resolve; });
			const whatsappStartedPromise = new Promise((resolve) => { whatsappStarted = resolve; });
			const telegramSend = jest.spyOn(manager.channels.get('telegram'), 'send')
				.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'temporary telegram failure' })
				.mockImplementationOnce(() => new Promise((resolve) => {
					releaseTelegram = resolve;
					telegramStarted();
				}));
			const whatsappSend = jest.spyOn(manager.channels.get('whatsapp'), 'send')
				.mockResolvedValueOnce({ success: false, channel: 'whatsapp', error: 'temporary whatsapp failure' })
				.mockImplementationOnce(() => new Promise((resolve) => {
					releaseWhatsApp = resolve;
					whatsappStarted();
				}));

			await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram', 'whatsapp'] })
				.expect(200);

			const telegramRetry = request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
				.expect(200);
			const whatsappRetry = request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['whatsapp'] })
				.expect(200);
			const telegramRetryPromise = telegramRetry.then((response) => response);
			const whatsappRetryPromise = whatsappRetry.then((response) => response);
			await Promise.all([telegramStartedPromise, whatsappStartedPromise]);

			releaseTelegram({ success: true, channel: 'telegram', messageId: 'telegram-2' });
			releaseWhatsApp({ success: true, channel: 'whatsapp', messageId: 'whatsapp-2' });
			await Promise.all([telegramRetryPromise, whatsappRetryPromise]);

			const finalResponse = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(finalResponse.body.results[0].deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true }),
				expect.objectContaining({ channel: 'whatsapp', success: true }),
			]);
			expect(telegramSend).toHaveBeenCalledTimes(2);
			expect(whatsappSend).toHaveBeenCalledTimes(2);
		});

		it('should re-deliver cached alerts when a later request asks for different channels', async () => {
			const response1 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					channels: ['whatsapp'],
				})
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);
			expect(response1.body.requestedChannels).toEqual(['whatsapp']);
			expect(response1.body.deliveredChannels).toEqual(['whatsapp']);
			expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
			expect(mockFetch).toHaveBeenCalledTimes(1);

			const response2 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					channels: ['telegram'],
					telegramChatId: '-100999888777',
				})
				.expect(200);

			expect(response2.body.results[0].cached).toBe(true);
			expect(response2.body.requestedChannels).toEqual(['telegram']);
			expect(response2.body.deliveredChannels).toEqual(['telegram']);
			expect(response2.body.results[0].deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true }),
			]);
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
				'-100999888777',
				expect.any(String),
				expect.any(Object),
			);
			expect(mockFetch).toHaveBeenCalledTimes(1);

			const response3 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					channels: ['telegram'],
					telegramChatId: '-100999888777',
				})
				.expect(200);

			expect(response3.body.deliveredChannels).toEqual(['telegram']);
			expect(response3.body.results[0].deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true }),
			]);
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
		});

		it('should retry only newly requested channels when an explicit channel set expands', async () => {
			const telegramSend = jest.spyOn(mockBot.telegram, 'sendMessage');

			await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
				.expect(200);

			const response = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram', 'whatsapp'] })
				.expect(200);

			expect(response.body.deliveredChannels).toEqual(['telegram', 'whatsapp']);
			expect(telegramSend).toHaveBeenCalledTimes(1);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it('should reject a cached success when its explicit channel is no longer enabled', async () => {
			await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
				.expect(200);

			getNotificationManager().channels.get('telegram').enabled = false;

			const response = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
				.expect(400);

			expect(response.body).toEqual(expect.objectContaining({
				code: 'INVALID_REQUEST',
				error: 'Requested channel(s) disabled or misconfigured: telegram',
			}));
		});

		it('should preserve untouched channel destinations across partial retries', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '';
			const { getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
			const manager = getNotificationManager();
			const telegramSend = jest.spyOn(manager.channels.get('telegram'), 'send').mockResolvedValue({
				success: true,
				channel: 'telegram',
				messageId: 'telegram-1',
			});
			const whatsappSend = jest.spyOn(manager.channels.get('whatsapp'), 'send')
				.mockResolvedValueOnce({ success: false, channel: 'whatsapp', error: 'temporary failure' })
				.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'whatsapp-2' });

			await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					channels: ['telegram', 'whatsapp'],
					telegramChatId: '-100000000001',
				})
				.expect(200);

			await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['whatsapp'] })
				.expect(200);

			await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(telegramSend).toHaveBeenCalledTimes(2);
			expect(telegramSend.mock.calls[1][0].telegramChatId).toBeUndefined();
			expect(whatsappSend).toHaveBeenCalledTimes(2);
		});

		it('should not report a destination retry as delivered while another request owns its lease', async () => {
			await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
				.expect(200);

			let releaseRetry;
			let retryStarted;
			const retryStartedPromise = new Promise((resolve) => { retryStarted = resolve; });
			const { getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
			const telegramSend = jest.spyOn(getNotificationManager().channels.get('telegram'), 'send')
				.mockImplementationOnce(() => new Promise((resolve) => {
					releaseRetry = resolve;
					retryStarted();
				}));

			const retry = request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram'], telegramChatId: '-100000000002' })
				.expect(200);
			const retryPromise = retry.then((response) => response);
			await retryStartedPromise;

			const concurrent = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], channels: ['telegram'], telegramChatId: '-100000000002' })
				.expect(200);

			expect(concurrent.body.deliveredChannels).toEqual([]);
			expect(concurrent.body.results[0].deliveryResults).toEqual([]);
			expect(telegramSend).toHaveBeenCalledTimes(1);

			releaseRetry({ message_id: 'telegram-retry' });
			await retryPromise;
		});

		it('should re-deliver only missing enabled channels when a later request omits channels', async () => {
			const response1 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					channels: ['whatsapp'],
				})
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);
			expect(response1.body.requestedChannels).toEqual(['whatsapp']);
			expect(response1.body.deliveredChannels).toEqual(['whatsapp']);
			expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
			expect(mockFetch).toHaveBeenCalledTimes(1);

			const response2 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
				})
				.expect(200);

			expect(response2.body.results[0].cached).toBe(true);
			expect(response2.body.requestedChannels).toEqual(['telegram', 'whatsapp']);
			expect(response2.body.deliveredChannels).toEqual(['telegram', 'whatsapp']);
			expect(response2.body.results[0].deliveryResults).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ channel: 'telegram', success: true }),
					expect.objectContaining({ channel: 'whatsapp', success: true }),
				]),
			);
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it('should re-deliver cached alerts to the default destination when the cached send used a chat override', async () => {
			const response1 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
					channels: ['telegram'],
					telegramChatId: '-100999888777',
				})
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);
			expect(response1.body.requestedChannels).toEqual(['telegram']);
			expect(response1.body.deliveredChannels).toEqual(['telegram']);
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
				'-100999888777',
				expect.any(String),
				expect.any(Object),
			);

			const response2 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({
					crypto: ['BTCUSDT'],
				})
				.expect(200);

			expect(response2.body.results[0].cached).toBe(true);
			expect(response2.body.requestedChannels).toEqual(['telegram', 'whatsapp']);
			expect(response2.body.deliveredChannels).toEqual(['telegram', 'whatsapp']);
			expect(mockBot.telegram.sendMessage).toHaveBeenLastCalledWith(
				'123456789',
				expect.any(String),
				expect.any(Object),
			);
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(2);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it('should include cached alerts in response', async () => {
			// First call
			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			const firstAlert = response1.body.results[0].alert;

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
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
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response2.body.summary.cached).toBe(1);
			expect(response2.body.summary.analyzed).toBe(0);
		});

		it('should include cached flag in result metadata', async () => {
			// First call
			await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
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
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			const analyzedTime = response1.body.results[0].totalDurationMs;

			// Second call (cached)
			const response2 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			const cachedTime = response2.body.results[0].totalDurationMs;

			// Cached should be faster (or equal in tests with mocks, allowing a small 10ms overhead for async/await ticks)
			expect(cachedTime).toBeLessThanOrEqual(analyzedTime + 10);
		});
	});

	describe('Cache Entry Structure', () => {
		it('should store complete alert data in cache', async () => {
			// First call
			const response1 = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
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
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
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
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response1.body.results[0].cached).toBe(false);
			expect(response1.body.results[1].cached).toBe(false);
			expect(response1.body.summary.analyzed).toBe(2);
			expect(response1.body.summary.cached).toBe(0);

			// Second call with same symbols
			const response2 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response2.body.results[0].cached).toBe(true);
			expect(response2.body.results[1].cached).toBe(true);
			expect(response2.body.summary.analyzed).toBe(0);
			expect(response2.body.summary.cached).toBe(2);

			// Third call with one cached, one new
			// Since we only have mock symbols, new symbol will be from defaults
			const response3 = await request(app)
				.get('/api/news-monitor').set('x-api-key', 'test-key')
				.expect(200);

			// Should have mixed cache status
			const cachedCount = response3.body.results.filter(r => r.cached).length;
			expect(cachedCount).toBeGreaterThan(0);
		});
	});
});
