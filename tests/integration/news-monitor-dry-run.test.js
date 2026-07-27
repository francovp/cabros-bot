const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');
jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	recordSignal: jest.fn(),
}));

describe('News Monitor dry-run mode', () => {
	const originalEnv = process.env;
	let mockTelegramSendMessage;
	let mockBot;
	let mockFetch;
	let cache;
	let cacheSetSpy;
	let cacheClaimSpy;

	beforeEach(async () => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_NEWS_MONITOR: 'true',
			ENABLE_NEWS_MONITOR_TEST_MODE: 'true',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'true',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'true',
			ENABLE_DISCORD_ALERTS: 'true',
			BOT_TOKEN: 'test-token',
			TELEGRAM_CHAT_ID: '123456789',
			WHATSAPP_API_URL: 'https://api.greenapi.com/waInstance123/',
			WHATSAPP_API_KEY: 'test-whatsapp-key',
			WHATSAPP_CHAT_ID: '120363000000000000@g.us',
			DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
			NEWS_ALERT_THRESHOLD: '0.7',
			ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP: 'false',
		};

		jest.clearAllMocks();
		signalOutcomeService.isEnabled.mockReturnValue(true);
		signalOutcomeService.recordSignal.mockResolvedValue('outcome-id');

		const gemini = require('../../src/services/grounding/gemini');
		gemini.analyzeNewsForSymbol.mockResolvedValue({
			event_category: 'price_surge',
			event_significance: 0.8,
			sentiment_score: 0.9,
			headline: 'Bitcoin surges on positive news',
			confidence: 0.95,
			sources: ['https://example.com/news'],
		});

		const genaiClient = require('../../src/services/grounding/genaiClient');
		genaiClient.search.mockResolvedValue({
			results: [],
			searchResultText: '{"price":123.45,"change_24h":1.23,"context":"Mock market context"}',
			totalResults: 0,
		});

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-message-id' });
		mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ idMessage: 'mock-message-id', id: 'discord-message-id' }),
		});
		global.fetch = mockFetch;
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));

		cache = getCacheInstance();
		cache.clear();
		cacheSetSpy = jest.spyOn(cache, 'set');
		cacheClaimSpy = jest.spyOn(cache, 'claim');
	});

	afterEach(() => {
		cacheSetSpy?.mockRestore();
		cacheClaimSpy?.mockRestore();
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('GET returns generated alerts and intended channels without side effects', async () => {
		const response = await request(app)
			.get('/api/news-monitor?dryRun=true')
			.set('x-api-key', 'test-key')
			.query({ crypto: 'DRYBTC', channels: 'telegram,whatsapp,discord' })
			.expect(200);

		expect(response.body.dryRun).toBe(true);
		expect(response.body.requestedChannels).toEqual(['telegram', 'whatsapp', 'discord']);
		expect(response.body.deliveredChannels).toEqual([]);
		expect(response.body.results[0]).toEqual(expect.objectContaining({
			symbol: 'DRYBTC',
			status: 'analyzed',
			cached: false,
		}));
		expect(response.body.results[0].alert.headline).toBe('Bitcoin surges on positive news');
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		expect(mockFetch).not.toHaveBeenCalled();
		expect(cacheClaimSpy).not.toHaveBeenCalled();
		expect(cacheSetSpy).not.toHaveBeenCalled();
		expect(signalOutcomeService.recordSignal).not.toHaveBeenCalled();
	});

	it('POST returns generated alerts and intended channels without side effects', async () => {
		const response = await request(app)
			.post('/api/news-monitor?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({
				crypto: ['DRYETH'],
				channels: ['telegram', 'whatsapp', 'discord'],
			})
			.expect(200);

		expect(response.body.dryRun).toBe(true);
		expect(response.body.requestedChannels).toEqual(['telegram', 'whatsapp', 'discord']);
		expect(response.body.deliveredChannels).toEqual([]);
		expect(response.body.results[0]).toEqual(expect.objectContaining({
			symbol: 'DRYETH',
			status: 'analyzed',
			cached: false,
		}));
		expect(response.body.results[0].alert.headline).toBe('Bitcoin surges on positive news');
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		expect(mockFetch).not.toHaveBeenCalled();
		expect(cacheClaimSpy).not.toHaveBeenCalled();
		expect(cacheSetSpy).not.toHaveBeenCalled();
		expect(signalOutcomeService.recordSignal).not.toHaveBeenCalled();
	});
});
