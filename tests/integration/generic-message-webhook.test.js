/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');

describe('POST /api/webhook/message - Generic message webhook', () => {
	const originalEnv = process.env;
	let mockBot;

	beforeEach(async () => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'true',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			WHATSAPP_API_URL: 'https://api.greenapi.com/waInstance123/',
			WHATSAPP_API_KEY: 'test-whatsapp-key',
			WHATSAPP_CHAT_ID: '120363000000000000@g.us',
			ENABLE_GEMINI_GROUNDING: 'false',
		};

		jest.clearAllMocks();

		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'tg-msg-123' }),
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		// Mock global.fetch for WhatsApp GreenAPI calls
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ idMessage: 'wa-msg-456' }),
		});

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	// ---------------------------------------------------------------------------
	// Success cases
	// ---------------------------------------------------------------------------
	it('sends a message to telegram only', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello from test', channels: ['telegram'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.results).toHaveLength(1);
		expect(res.body.results[0].channel).toBe('telegram');
		expect(res.body.results[0].success).toBe(true);
		expect(res.body.results[0].messageId).toBe('tg-msg-123');
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('sends a message to whatsapp only', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello WhatsApp', channels: ['whatsapp'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.results).toHaveLength(1);
		expect(res.body.results[0].channel).toBe('whatsapp');
		expect(res.body.results[0].success).toBe(true);
		expect(res.body.results[0].messageId).toBe('wa-msg-456');
		expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('sends a message to both channels', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello both channels', channels: ['telegram', 'whatsapp'] })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.results).toHaveLength(2);
		expect(res.body.results[0].channel).toBe('telegram');
		expect(res.body.results[0].success).toBe(true);
		expect(res.body.results[1].channel).toBe('whatsapp');
		expect(res.body.results[1].success).toBe(true);
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	// ---------------------------------------------------------------------------
	// Validation error cases
	// ---------------------------------------------------------------------------
	it('returns 400 when message is empty', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: '', channels: ['telegram'] })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('non-empty string');
	});

	it('returns 400 when message is missing', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ channels: ['telegram'] })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('message');
	});

	it('returns 400 when message is not a string', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 12345, channels: ['telegram'] })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('message');
	});

	it('returns 400 when channels is missing', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello' })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('channels');
	});

	it('returns 400 when channels is empty array', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello', channels: [] })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('channels');
	});

	it('returns 400 when channels contains unknown channel', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello', channels: ['telegram', 'discord'] })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('Unknown channel');
		expect(res.body.error).toContain('discord');
	});

	it('returns 400 when channels is not an array', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello', channels: 'telegram' })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('channels');
	});

	// ---------------------------------------------------------------------------
	// Chat ID override cases
	// ---------------------------------------------------------------------------
	it('sends to a custom telegramChatId override', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Override TG chat', channels: ['telegram'], telegramChatId: '-100999888777' })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.results).toHaveLength(1);
		expect(res.body.results[0].channel).toBe('telegram');
		expect(res.body.results[0].success).toBe(true);

		// Verify sendMessage was called with the override chatId, not the default
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
			'-100999888777',
			expect.any(String),
			expect.any(Object),
		);
	});

	it('sends to a custom whatsappChatId override', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Override WA chat', channels: ['whatsapp'], whatsappChatId: '120363555555555555@g.us' })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.results).toHaveLength(1);
		expect(res.body.results[0].channel).toBe('whatsapp');
		expect(res.body.results[0].success).toBe(true);

		// Verify fetch was called with the override chatId in the body
		const fetchCall = global.fetch.mock.calls[0];
		const fetchBody = JSON.parse(fetchCall[1].body);
		expect(fetchBody.chatId).toBe('120363555555555555@g.us');
	});

	it('sends with both chatId overrides simultaneously', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({
				message: 'Override both chats',
				channels: ['telegram', 'whatsapp'],
				telegramChatId: '-100111222333',
				whatsappChatId: '120363666666666666@g.us',
			})
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.results).toHaveLength(2);

		// Telegram used override
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
			'-100111222333',
			expect.any(String),
			expect.any(Object),
		);

		// WhatsApp used override
		const fetchCall = global.fetch.mock.calls[0];
		const fetchBody = JSON.parse(fetchCall[1].body);
		expect(fetchBody.chatId).toBe('120363666666666666@g.us');
	});

	it('returns 400 when telegramChatId is not a string', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello', channels: ['telegram'], telegramChatId: 12345 })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('telegramChatId');
	});

	it('returns 400 when telegramChatId is an empty string', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello', channels: ['telegram'], telegramChatId: '' })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('telegramChatId');
	});

	it('returns 400 when whatsappChatId is not a string', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello', channels: ['whatsapp'], whatsappChatId: true })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('whatsappChatId');
	});

	it('returns 400 when whatsappChatId is an empty string', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Hello', channels: ['whatsapp'], whatsappChatId: '' })
			.expect(400);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toContain('whatsappChatId');
	});

	it('sends message without override when telegramChatId is not provided', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Default chat', channels: ['telegram'] })
			.expect(200);

		expect(res.body.success).toBe(true);

		// Verify sendMessage was called with the default chatId
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
			'123456789',
			expect.any(String),
			expect.any(Object),
		);
	});

	// ---------------------------------------------------------------------------
	// Provider failure isolation
	// ---------------------------------------------------------------------------
	it('does not block the other channel when one provider fails', async () => {
		// Make WhatsApp fetch fail
		global.fetch.mockRejectedValue(new Error('WhatsApp API timeout'));

		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'test-key')
			.send({ message: 'Partial failure test', channels: ['telegram', 'whatsapp'] })
			.expect(200);

		// Telegram still succeeds
		expect(res.body.results[0].channel).toBe('telegram');
		expect(res.body.results[0].success).toBe(true);

		// WhatsApp fails (after retries)
		expect(res.body.results[1].channel).toBe('whatsapp');
		expect(res.body.results[1].success).toBe(false);
		expect(res.body.results[1].error).toContain('WhatsApp API timeout');

		// Overall success is still true (fail-open pattern)
		expect(res.body.success).toBe(true);

		expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(2);
		expect(mockBot.telegram.sendMessage).toHaveBeenLastCalledWith(
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID,
			expect.stringContaining('Failed channels: whatsapp'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
		// fetch is called multiple times due to WhatsApp retry logic
		expect(global.fetch).toHaveBeenCalled();
	});

	// ---------------------------------------------------------------------------
	// API key protection
	// ---------------------------------------------------------------------------
	it('returns 401 without API key', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.send({ message: 'Hello', channels: ['telegram'] })
			.expect(401);

		expect(res.body.error).toContain('Unauthorized');
	});

	it('returns 403 with wrong API key', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set('x-api-key', 'wrong-key')
			.send({ message: 'Hello', channels: ['telegram'] })
			.expect(403);

		expect(res.body.error).toContain('Forbidden');
	});
});
