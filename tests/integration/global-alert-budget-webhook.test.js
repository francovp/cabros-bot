/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const express = require('express');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { globalAlertBudget, resetAdminPageCooldownForTesting } = require('../../src/services/notifications/globalAlertBudget');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');
const { signalRepeatCooldown } = require('../../src/services/alerts/signalRepeatCooldown');
const { validateApiKey } = require('../../src/lib/auth');
const { idempotencyMiddleware } = require('../../src/lib/idempotency');
const { postAlert } = require('../../src/controllers/webhooks/handlers/alert/alert');

const SIGNAL_TEXT = 'BINANCE:ETHUSDT (4h) COMPRA — budget-test-alert';

function buildApp(mockBot) {
	const app = express();
	app.use(express.json());
	app.post('/api/webhook/alert', validateApiKey, idempotencyMiddleware, postAlert(mockBot));
	return app;
}

describe('Global alert budget webhook gate', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;
	let app;

	beforeEach(async () => {
		savedEnv = (() => {
			const env = {};
			for (const key of Object.keys(process.env)) {
				env[key] = process.env[key];
			}
			return env;
		})();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'budget-test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_NOTIFICATION_REDRIVE: 'false',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: '-100-admin',
		});

		jest.clearAllMocks();
		globalAlertBudget.resetForTesting();
		signalRepeatCooldown.reset();
		notificationRedriveService._resetForTesting();
		resetAdminPageCooldownForTesting();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-msg-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app = buildApp(mockBot);
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalAlertBudget.resetForTesting();
		signalRepeatCooldown.reset();
		notificationRedriveService._resetForTesting();
	});

	it('delivers alerts normally when the budget is not exhausted', async () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '5';
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});

	it('still returns 200 with success=false when the global budget is exhausted', async () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '2';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		const blocked = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(blocked.body.results).toEqual(expect.arrayContaining([
			expect.objectContaining({
				channel: 'telegram',
				success: false,
				statusCode: 429,
				errorCode: 'ALERT_BUDGET_EXCEEDED',
				budget: expect.objectContaining({
					enabled: true,
					used: 2,
					capacity: 2,
					remaining: 0,
					resetAt: expect.any(String),
				}),
			}),
		]));
		// 2 successful alerts (123456789) + 1 admin page (TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID)
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(3);
	});

	it('does not consume budget on a dryRun=true request', async () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '10';
		const dry = await request(app)
			.post('/api/webhook/alert?dryRun=true')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(dry.body.dryRun).toBe(true);
		expect(globalAlertBudget.dryRun().used).toBe(0);
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('bypasses the budget when GLOBAL_ALERT_BUDGET_PER_24H is 0', async () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '0';

		for (let i = 0; i < 3; i += 1) {
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'budget-test-key')
				.send({ text: SIGNAL_TEXT })
				.expect(200);
		}

		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(3);
	});

	it('tracks used count in the budget status across multiple alerts', async () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '5';
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(globalAlertBudget.dryRun().used).toBe(2);
	});

	it('does not page the admin chat when TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID is unset', async () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '1';
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		const blocked = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'budget-test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(blocked.body.results[0].errorCode).toBe('ALERT_BUDGET_EXCEEDED');
		// Only the single successful delivery (no admin page)
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});
});
