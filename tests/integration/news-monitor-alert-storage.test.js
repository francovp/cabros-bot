'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('News Monitor - Alert Storage Integration', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;
	let saveAlertSpy;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_NEWS_MONITOR: 'true',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
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
		});

		jest.clearAllMocks();
		getCacheInstance().clear();
		require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor')
			.getNewsMonitor()
			.persistedOriginalKeys.clear();

		const gemini = require('../../src/services/grounding/gemini');
		gemini.analyzeNewsForSymbol.mockReset();
		gemini.analyzeNewsForSymbol.mockResolvedValue({
			event_category: 'price_surge',
			event_significance: 0.8,
			sentiment_score: 0.85,
			headline: 'Bitcoin surges past 100k',
			description: 'Strong bullish breakout',
			confidence: 0.9,
			sources: ['https://example.com/news1'],
		});

		const genaiClient = require('../../src/services/grounding/genaiClient');
		genaiClient.search = jest.fn().mockResolvedValue({
			results: [{ url: 'https://example.com/1', title: 'Source 1' }],
			searchResultText: '{"price": 105000, "change_24h": 5.2}',
			totalResults: 1,
			usage: { promptTokenCount: 50, candidatesTokenCount: 25, totalTokenCount: 75 },
		});

		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ success: true, idMessage: 'mock-wa-msg' }),
		});

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'tg-123' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));

		saveAlertSpy = jest.spyOn(alertStorageService, 'saveAlert').mockResolvedValue('mock-alert-doc-id');
	});

	afterEach(() => {
		if (saveAlertSpy) {
			saveAlertSpy.mockRestore();
		}
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('persists delivered news alert to AlertStorageService with source: news-monitor', async () => {
		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.analyzed).toBe(1);
		expect(res.body.summary.alerts_sent).toBe(1);

		expect(saveAlertSpy).toHaveBeenCalledTimes(1);
		expect(saveAlertSpy).toHaveBeenCalledWith(expect.objectContaining({
			source: 'news-monitor',
			symbol: 'BTCUSDT',
			eventCategory: 'price_surge',
			confidence: 0.9,
			sentimentScore: 0.85,
			dedupStatus: 'fresh',
			channels: expect.arrayContaining(['telegram', 'whatsapp']),
			deliveryResults: expect.arrayContaining([
				expect.objectContaining({ channel: 'telegram', success: true }),
			]),
		}));
	});

	it('skips persistence when dryRun is true', async () => {
		const res = await request(app)
			.post('/api/news-monitor?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.dryRun).toBe(true);
		expect(saveAlertSpy).not.toHaveBeenCalled();
	});

	it('fails open when alert storage persistence throws', async () => {
		saveAlertSpy.mockRejectedValueOnce(new Error('Firestore connection timeout'));

		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.alerts_sent).toBe(1);
		expect(saveAlertSpy).toHaveBeenCalledTimes(1);
	});

	it('persists delivered news alert on GET /api/news-monitor', async () => {
		const res = await request(app)
			.get('/api/news-monitor?crypto=BTCUSDT')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.alerts_sent).toBe(1);
		expect(saveAlertSpy).toHaveBeenCalledTimes(1);
		expect(saveAlertSpy).toHaveBeenCalledWith(expect.objectContaining({
			source: 'news-monitor',
			symbol: 'BTCUSDT',
		}));
	});

	it('does not persist alerts when no alert is generated', async () => {
		const gemini = require('../../src/services/grounding/gemini');
		gemini.analyzeNewsForSymbol.mockResolvedValueOnce({
			event_category: 'none',
			event_significance: 0.1,
			sentiment_score: 0.0,
			headline: 'Routine update',
			description: 'Nothing major',
			confidence: 0.2,
			sources: [],
		});

		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.alerts_sent).toBe(0);
		expect(saveAlertSpy).not.toHaveBeenCalled();
	});

	it('persists redelivered alerts when cached item is successfully sent to new channel', async () => {
		// First request delivers to telegram only
		await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
			.expect(200);

		expect(saveAlertSpy).toHaveBeenCalledTimes(1);
		expect(saveAlertSpy).toHaveBeenLastCalledWith(expect.objectContaining({
			dedupStatus: 'fresh',
			channels: ['telegram'],
		}));

		// Second request sends to whatsapp (which was not in previous delivery)
		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['whatsapp'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.cached).toBe(1);
		expect(saveAlertSpy).toHaveBeenCalledTimes(2);
		expect(saveAlertSpy).toHaveBeenLastCalledWith(expect.objectContaining({
			source: 'news-monitor',
			symbol: 'BTCUSDT',
			dedupStatus: 'cached',
			channels: ['whatsapp'],
		}));
	});

	it('does not persist cached alert when no redelivery is attempted or needed', async () => {
		// First request delivers to telegram
		await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
			.expect(200);

		expect(saveAlertSpy).toHaveBeenCalledTimes(1);

		// Second request sends to telegram again (already delivered)
		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.cached).toBe(1);
		// Should NOT call saveAlert a second time because no redelivery happened
		expect(saveAlertSpy).toHaveBeenCalledTimes(1);
	});

	it('does not persist analyzed alerts when every channel delivery fails', async () => {
		mockTelegramSendMessage.mockRejectedValue(new Error('telegram transport down'));

		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.alerts_sent).toBe(1);
		expect(res.body.deliveredChannels).toEqual([]);
		expect(saveAlertSpy).not.toHaveBeenCalled();
	});

	it('persists cached redeliveries with only current-attempt results and no token usage', async () => {
		await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
			.expect(200);

		expect(saveAlertSpy).toHaveBeenCalledTimes(1);
		const original = saveAlertSpy.mock.calls[0][0];
		expect(original.dedupStatus).toBe('fresh');
		expect(original.tokenUsage).not.toBeNull();

		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['whatsapp'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.cached).toBe(1);
		expect(res.body.results[0]).not.toHaveProperty('attemptedDeliveryResults');
		expect(saveAlertSpy).toHaveBeenCalledTimes(2);
		const redelivery = saveAlertSpy.mock.calls[1][0];
		expect(redelivery.source).toBe('news-monitor');
		expect(redelivery.symbol).toBe('BTCUSDT');
		expect(redelivery.dedupStatus).toBe('cached');
		expect(redelivery.tokenUsage).toBeNull();
		expect(redelivery.deliveryResults).toEqual([
			expect.objectContaining({ channel: 'whatsapp', success: true }),
		]);
	});

	it('preserves token usage on redelivery when the original write failed', async () => {
		saveAlertSpy.mockRejectedValueOnce(new Error('firestore unavailable'));

		await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['telegram'] })
			.expect(200);

		expect(saveAlertSpy).toHaveBeenCalledTimes(1);

		await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'], channels: ['whatsapp'] })
			.expect(200);

		expect(saveAlertSpy).toHaveBeenCalledTimes(2);
		const redelivery = saveAlertSpy.mock.calls[1][0];
		expect(redelivery.dedupStatus).toBe('cached');
		expect(redelivery.tokenUsage).not.toBeNull();
		expect(redelivery.tokenUsage.totalTokens).toBeGreaterThan(0);
	});

	it('does not persist when ENABLE_FIRESTORE_ALERT_STORAGE is false', async () => {
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';

		const res = await request(app)
			.post('/api/news-monitor')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.alerts_sent).toBe(1);
		expect(saveAlertSpy).not.toHaveBeenCalled();
	});
});

