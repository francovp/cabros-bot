'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const NotificationManager = require('../../src/services/notification/NotificationManager');
const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const TelegramService = require('../../src/services/notification/TelegramService');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');

describe('WhatsApp Webhook Error Handling & Resiliency (GH-337 / CB-136)', () => {
	const API_KEY = 'test-api-key';
	let originalEnv;

	beforeAll(() => {
		originalEnv = { ...process.env };
		process.env.WEBHOOK_API_KEY = API_KEY;
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57';
		process.env.TELEGRAM_CHAT_ID = '123456789';
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.green-api.com/waInstance123/SendMessage/';
		process.env.WHATSAPP_API_KEY = 'secret-token-12345';
		process.env.WHATSAPP_CHAT_ID = '123456789@g.us';
	});

	afterAll(() => {
		process.env = originalEnv;
	});

	let router;
	beforeEach(async () => {
		const mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 111 }),
				getMe: jest.fn().mockResolvedValue({ id: 1, username: 'testbot' }),
			},
		};
		await initializeNotificationServices(mockBot);
		router = getRoutes(() => mockBot);
		app.use('/api', router);
	});

	it('should return stable JSON and per-channel result when WhatsApp provider returns HTTP 500 with HTML body', async () => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: jest.fn().mockResolvedValue('<html><body>500 Internal Server Error secret_token_value</body></html>'),
		});

		await initializeNotificationServices(null);

		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', API_KEY)
			.send({
				message: 'Test alert message',
				channels: ['whatsapp'],
			});

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('success', true);
		expect(res.body).toHaveProperty('results');
		expect(Array.isArray(res.body.results)).toBe(true);

		const waResult = res.body.results.find((r) => r.channel === 'whatsapp');
		expect(waResult).toBeDefined();
		expect(waResult.success).toBe(false);
		expect(waResult.category).toBe('PROVIDER_ERROR');
		expect(waResult.error).not.toContain('secret_token_value');
		expect(waResult.error).not.toContain('<html>');
	});

	it('should handle non-JSON responses from GreenAPI without throwing unhandled 500s', async () => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON at position 0')),
		});

		await initializeNotificationServices(null);

		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', API_KEY)
			.send({
				message: 'Test non-json response',
				channels: ['whatsapp'],
			});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		const waResult = res.body.results.find((r) => r.channel === 'whatsapp');
		expect(waResult.success).toBe(false);
		expect(waResult.category).toBe('INVALID_RESPONSE');
		expect(waResult.error).toContain('non-JSON');
	});

	it('should handle ambiguous GreenAPI responses missing idMessage cleanly', async () => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ status: 'pending' }), // missing idMessage
		});

		await initializeNotificationServices(null);

		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', API_KEY)
			.send({
				message: 'Test ambiguous response',
				channels: ['whatsapp'],
			});

		expect(res.status).toBe(200);
		const waResult = res.body.results.find((r) => r.channel === 'whatsapp');
		expect(waResult.success).toBe(false);
		expect(waResult.ambiguous).toBe(true);
		expect(waResult.category).toBe('AMBIGUOUS_OUTCOME');
	});

	it('should allow multi-channel delivery where Telegram succeeds even if WhatsApp fails', async () => {
		const mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 777 }),
				getMe: jest.fn().mockResolvedValue({ id: 1, username: 'testbot' }),
			},
		};
		await initializeNotificationServices(mockBot);

		global.fetch = jest.fn().mockRejectedValue(new Error('Network error connecting to GreenAPI'));

		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', API_KEY)
			.send({
				message: 'Dual channel test',
				channels: ['telegram', 'whatsapp'],
			});

		expect(res.status).toBe(200);
		expect(res.body.results).toHaveLength(2);
		const tgResult = res.body.results.find((r) => r.channel === 'telegram');
		const waResult = res.body.results.find((r) => r.channel === 'whatsapp');
		expect(tgResult.success).toBe(true);
		expect(waResult.success).toBe(false);
	});

	it('should replay cached response on idempotency retry when first attempt had an ambiguous channel failure', async () => {
		const fetchMock = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ status: 'unknown' }),
		});
		global.fetch = fetchMock;

		await initializeNotificationServices(null);

		const key = `idem-test-${Date.now()}`;

		const res1 = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', API_KEY)
			.set('x-idempotency-key', key)
			.send({
				message: 'Idempotency test',
				channels: ['whatsapp'],
			});

		expect(res1.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(3); // 3 retry attempts for initial request

		// Replay request with same key
		const res2 = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', API_KEY)
			.set('x-idempotency-key', key)
			.send({
				message: 'Idempotency test',
				channels: ['whatsapp'],
			});

		expect(res2.status).toBe(200);
		expect(res2.header['idempotency-replay']).toBe('true');
		expect(res2.body.idempotencyReplayed).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3); // No new network calls made on replay
	});

	it('should capture actionable Sentry error event with endpoint, channel, provider, and sanitized error context on WhatsApp 500', async () => {
		const sentryService = require('../../src/services/monitoring/SentryService');
		const captureSpy = jest.spyOn(sentryService, 'captureExternalFailure');

		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: jest.fn().mockResolvedValue('GreenAPI Server Error secret_token_abc123'),
		});

		await initializeNotificationServices(null);

		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', API_KEY)
			.send({
				message: 'Test Sentry reporting',
				channels: ['whatsapp'],
				whatsappChatId: '56912345678@c.us',
			});

		expect(res.status).toBe(200);
		expect(captureSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: 'whatsapp',
				external: expect.objectContaining({
					provider: 'whatsapp-greenapi',
					lastErrorCode: 500,
				}),
				http: expect.objectContaining({
					endpoint: '/api/webhook/message',
					method: 'POST',
				}),
			}),
		);

		captureSpy.mockRestore();
	});
});
