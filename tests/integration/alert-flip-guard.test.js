/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const {
	initializeNotificationServices,
} = require('../../src/controllers/webhooks/handlers/alert/alert');
const { signalFlipGuard } = require('../../src/services/alerts/signalFlipGuard');
const { signalRepeatCooldown } = require('../../src/services/alerts/signalRepeatCooldown');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');

const SELL_TEXT = 'BINANCE:ETHUSDT (4h) VENTA — initial alert';
const BUY_TEXT = 'BINANCE:ETHUSDT (4h) COMPRA — flip alert';

function saveEnv() {
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => (
			key === 'WEBHOOK_API_KEY'
			|| key === 'ENABLE_TELEGRAM_BOT'
			|| key === 'ENABLE_WHATSAPP_ALERTS'
			|| key === 'BOT_TOKEN'
			|| key === 'TELEGRAM_CHAT_ID'
			|| key === 'ENABLE_GEMINI_GROUNDING'
			|| key === 'ENABLE_ALERT_FLIP_GUARD'
			|| key === 'ALERT_FLIP_COOLDOWN_HOURS'
			|| key === 'ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION'
			|| key === 'NOTIFICATION_REDRIVE_WORKER_ROLE'
			|| key === 'ENABLE_NOTIFICATION_REDRIVE'
		)),
	);
}

function restoreEnv(saved) {
	for (const key of Object.keys(saved)) {
		process.env[key] = saved[key];
	}
	for (const key of [
		'ENABLE_ALERT_FLIP_GUARD',
		'ALERT_FLIP_COOLDOWN_HOURS',
		'ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION',
	]) {
		if (!(key in saved)) delete process.env[key];
	}
}

describe('Alert flip guard endpoint behavior', () => {
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
			ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION: 'false',
			NOTIFICATION_REDRIVE_WORKER_ROLE: 'disabled',
			ENABLE_NOTIFICATION_REDRIVE: 'false',
		});

		jest.clearAllMocks();
		signalFlipGuard.reset();
		signalRepeatCooldown.reset();
		notificationRedriveService._resetForTesting();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'flip-msg-id' });
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
		signalFlipGuard.reset();
		signalRepeatCooldown.reset();
		notificationRedriveService._resetForTesting();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('delivers both alerts unchanged when the flip guard is disabled', async () => {
		process.env.ENABLE_ALERT_FLIP_GUARD = 'false';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SELL_TEXT })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BUY_TEXT })
			.expect(200);

		expect(second.body.flipContext).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
		const secondText = mockTelegramSendMessage.mock.calls[1][1];
		expect(secondText).not.toMatch(/señal opuesta/);
	});

	it('annotates the opposite-direction alert and reports flipContext', async () => {
		process.env.ENABLE_ALERT_FLIP_GUARD = 'true';
		process.env.ALERT_FLIP_COOLDOWN_HOURS = '24';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SELL_TEXT })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BUY_TEXT })
			.expect(200);

		expect(second.body.flipContext).toBeDefined();
		expect(second.body.flipContext.previousDirection).toBe('SELL');
		expect(second.body.flipContext.symbol).toBe('ETHUSDT');
		expect(second.body.flipContext.hoursDelta).toBeGreaterThanOrEqual(0);
		expect(second.body.flipContext.previousAt).toMatch(/T.*Z$/);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);

		const secondText = mockTelegramSendMessage.mock.calls[1][1];
		expect(secondText).toMatch(/⚠️/);
		expect(secondText).toMatch(/señal opuesta/);
		expect(secondText).toMatch(/VENTA/);
	});

	it('does not annotate when the cooldown window has elapsed', async () => {
		process.env.ENABLE_ALERT_FLIP_GUARD = 'true';
		process.env.ALERT_FLIP_COOLDOWN_HOURS = '1';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SELL_TEXT })
			.expect(200);

		// Force the recorded timestamp into the past by clearing the store and
		// recording an old fire directly so the second alert is outside the
		// cooldown window.
		signalFlipGuard.reset();
		const oldTime = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
		signalFlipGuard.recordFire({ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'SELL' }, oldTime);

		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BUY_TEXT })
			.expect(200);

		expect(second.body.flipContext).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
		const secondText = mockTelegramSendMessage.mock.calls[1][1];
		expect(secondText).not.toMatch(/⚠️/);
	});

	it('treats same-side signals as not flipped', async () => {
		process.env.ENABLE_ALERT_FLIP_GUARD = 'true';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BUY_TEXT })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BUY_TEXT })
			.expect(200);

		expect(second.body.flipContext).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
		const secondText = mockTelegramSendMessage.mock.calls[1][1];
		expect(secondText).not.toMatch(/⚠️/);
	});

	it('exposes flip guard counters via signalFlipGuard.getStats', async () => {
		process.env.ENABLE_ALERT_FLIP_GUARD = 'true';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SELL_TEXT })
			.expect(200);
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BUY_TEXT })
			.expect(200);

		const stats = signalFlipGuard.getStats();
		expect(stats.annotatedCount).toBe(1);
		expect(stats.cooldownHours).toBe(24);
		expect(stats.activeTrackedKeys).toBe(1);
		expect(stats.lastAnnotatedAt).toBeTruthy();
	});
});