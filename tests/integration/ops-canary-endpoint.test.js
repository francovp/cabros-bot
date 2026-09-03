/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices, getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');

describe('POST /api/ops/test-alert - Ops canary endpoint', () => {
	let savedEnv;
	let mockBot;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'true',
			ENABLE_DISCORD_ALERTS: 'true',
			ENABLE_CANARY_ENDPOINT: 'true',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			WHATSAPP_API_URL: 'https://api.greenapi.com/waInstance123/',
			WHATSAPP_API_KEY: 'test-whatsapp-key',
			WHATSAPP_CHAT_ID: '120363000000000000@g.us',
			DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
			ENABLE_GEMINI_GROUNDING: 'false',
		});

		jest.clearAllMocks();

		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'tg-msg-123' }),
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		// Mock global.fetch for WhatsApp GreenAPI + Discord webhook calls
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ idMessage: 'wa-msg-456' }),
		});

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		delete global.fetch;
		const manager = getNotificationManager();
		if (manager && typeof manager.resetForTesting === 'function') {
			manager.resetForTesting();
		}
	});

	it('returns 404 FEATURE_DISABLED when ENABLE_CANARY_ENDPOINT is not true', async () => {
		process.env.ENABLE_CANARY_ENDPOINT = 'false';
		const res = await request(app)
			.post('/api/ops/test-alert')
			.set('x-api-key', 'test-key')
			.send({ channels: ['telegram'] });

		expect(res.status).toBe(404);
		expect(res.body.code).toBe('FEATURE_DISABLED');
	});

	it('returns 401 when API key is missing', async () => {
		const res = await request(app)
			.post('/api/ops/test-alert')
			.send({ channels: ['telegram'] });

		expect(res.status).toBe(401);
	});

	it('returns 403 when API key is invalid', async () => {
		const res = await request(app)
			.post('/api/ops/test-alert')
			.set('x-api-key', 'wrong-key')
			.send({ channels: ['telegram'] });

		expect(res.status).toBe(403);
	});

	it('sends canary to telegram only and tags source as canary', async () => {
		const res = await request(app)
			.post('/api/ops/test-alert')
			.set('x-api-key', 'test-key')
			.send({ channels: ['telegram'], text: 'Smoke test' })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.source).toBe('canary');
		expect(res.body.results).toHaveLength(1);
		expect(res.body.results[0].channel).toBe('telegram');
		expect(res.body.results[0].success).toBe(true);
		expect(res.body.requestedChannels).toEqual(['telegram']);
		expect(res.body.successCount).toBe(1);
		expect(res.body.failureCount).toBe(0);
		expect(typeof res.body.requestId).toBe('string');
		expect(res.body.requestId.length).toBeGreaterThan(0);
		expect(typeof res.body.totalDurationMs).toBe('number');

		// Telegram service should have been called with the synthetic canary alert
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
		const sentArgs = mockBot.telegram.sendMessage.mock.calls[0];
		// MarkdownV2 formatter prefixes the source footer; the source is embedded in the alert object
		const messageArg = sentArgs.find((a) => typeof a === 'string' && a.length > 0);
		expect(messageArg).toBeDefined();
	});

	it('uses default canary text when text is omitted', async () => {
		const res = await request(app)
			.post('/api/ops/test-alert')
			.set('x-api-key', 'test-key')
			.send({ channels: ['telegram'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('returns mixed results when one channel fails', async () => {
		// Force telegram to fail
		mockBot.telegram.sendMessage.mockRejectedValueOnce(new Error('telegram-fail'));

		const res = await request(app)
			.post('/api/ops/test-alert')
			.set('x-api-key', 'test-key')
			.send({ channels: ['telegram', 'whatsapp'] })
			.expect(200);

		// success: false because at least one channel failed
		expect(res.body.success).toBe(false);
		expect(res.body.successCount).toBe(1);
		expect(res.body.failureCount).toBe(1);
		expect(Array.isArray(res.body.results)).toBe(true);
		expect(res.body.results).toHaveLength(2);
		const channels = res.body.results.map((r) => r.channel).sort();
		expect(channels).toEqual(['telegram', 'whatsapp']);
	});

	it('returns 400 INVALID_REQUEST for unknown channel', async () => {
		const res = await request(app)
			.post('/api/ops/test-alert')
			.set('x-api-key', 'test-key')
			.send({ channels: ['unknown'] });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 INVALID_REQUEST for empty channels array', async () => {
		const res = await request(app)
			.post('/api/ops/test-alert')
			.set('x-api-key', 'test-key')
			.send({ channels: [] });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});
});
