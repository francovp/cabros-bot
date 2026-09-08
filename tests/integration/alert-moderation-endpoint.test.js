/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { alertModeration } = require('../../src/services/alerts/alertModeration');

function saveEnv() {
	return { ...process.env };
}

function restoreEnv(saved) {
	for (const key of Object.keys(process.env)) {
		if (!(key in saved)) delete process.env[key];
	}
	Object.assign(process.env, saved);
}

describe('Alert moderation endpoint behavior', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_ALERT_MODERATION: 'false',
		});

		jest.clearAllMocks();
		alertModeration.reset();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-msg-id' });
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
		alertModeration.reset();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('passes alerts through unchanged when moderation is disabled', async () => {
		process.env.ENABLE_ALERT_MODERATION = 'false';
		process.env.ALERT_MODERATION_DENYLIST = 'banana';

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'this alert mentions banana' })
			.expect(200);

		expect(response.body.delivered).toBeUndefined();
		expect(response.body.reason).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});

	it('rejects a denylist match before delivery and returns moderation_rejected', async () => {
		process.env.ENABLE_ALERT_MODERATION = 'true';
		process.env.ALERT_MODERATION_DENYLIST = 'banana';
		alertModeration.refreshConfig();

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'this alert mentions banana' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.delivered).toBe(false);
		expect(response.body.reason).toBe('moderation_rejected');
		expect(response.body.moderationReason).toBe('denylist');
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('rejects a payload with a control character under universal rules', async () => {
		process.env.ENABLE_ALERT_MODERATION = 'true';
		process.env.ALERT_MODERATION_DENYLIST = '';
		process.env.ALERT_MODERATION_REGEX = '';
		alertModeration.refreshConfig();

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('content-type', 'application/json')
			.send({ text: 'hello\u0001world' })
			.expect(200);

		expect(response.body.delivered).toBe(false);
		expect(response.body.reason).toBe('moderation_rejected');
		expect(response.body.moderationReason).toBe('control_characters');
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('rejects a payload with 200+ identical characters under universal rules', async () => {
		process.env.ENABLE_ALERT_MODERATION = 'true';
		process.env.ALERT_MODERATION_DENYLIST = '';
		process.env.ALERT_MODERATION_REGEX = '';
		alertModeration.refreshConfig();

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'a'.repeat(250) })
			.expect(200);

		expect(response.body.delivered).toBe(false);
		expect(response.body.reason).toBe('moderation_rejected');
		expect(response.body.moderationReason).toBe('identical_run');
	});

	it('lets a clean alert through when moderation is enabled but no list is configured', async () => {
		process.env.ENABLE_ALERT_MODERATION = 'true';
		process.env.ALERT_MODERATION_DENYLIST = '';
		process.env.ALERT_MODERATION_REGEX = '';
		alertModeration.refreshConfig();

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (4h) COMPRA — clean alert' })
			.expect(200);

		expect(response.body.delivered).toBeUndefined();
		expect(response.body.reason).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});

	it('rejects a regex match when ALERT_MODERATION_REGEX is configured', async () => {
		process.env.ENABLE_ALERT_MODERATION = 'true';
		process.env.ALERT_MODERATION_DENYLIST = '';
		process.env.ALERT_MODERATION_REGEX = 'badword';
		alertModeration.refreshConfig();

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'this contains a badword inside' })
			.expect(200);

		expect(response.body.delivered).toBe(false);
		expect(response.body.moderationReason).toBe('regex');
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});
});
