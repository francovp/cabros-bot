/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { signalCrossTimeframeCooldown } = require('../../src/services/alerts/signalCrossTimeframeCooldown');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');

const DAY_TEXT = 'BINANCE:BTCUSDT (D) VENTA — producción cross-tf D';
const TF240_TEXT = 'BINANCE:BTCUSDT (240) VENTA — producción cross-tf 240';
const OPPOSITE_TEXT = 'BINANCE:BTCUSDT (240) COMPRA — opuesto flip';
const EXTERNAL_TEXT = 'BINANCE:ETHUSDT (240) VENTA — símbolo distinto, mismo timeframe';

describe('Alert cross-timeframe suppression endpoint behavior', () => {
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
		});

		jest.clearAllMocks();
		signalCrossTimeframeCooldown.reset();
		notificationRedriveService._resetForTesting();

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
		signalCrossTimeframeCooldown.reset();
		notificationRedriveService._resetForTesting();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('delivers both alerts when ENABLE_ALERT_CROSS_TF_SUPPRESSION=false (default)', async () => {
		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAY_TEXT })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: TF240_TEXT })
			.expect(200);

		expect(first.body.suppressedRepeat).toBeUndefined();
		expect(second.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('suppresses the second same-side alert on a different timeframe and reports suppressionReason', async () => {
		process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';

		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAY_TEXT })
			.expect(200);
		expect(first.body.suppressedRepeat).toBeUndefined();
		expect(first.body.deliveredChannels).toEqual(['telegram']);

		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: TF240_TEXT })
			.expect(200);
		expect(second.body.success).toBe(true);
		expect(second.body.suppressedRepeat).toBe(true);
		expect(second.body.suppressionReason).toBe('cross_timeframe_duplicate');
		expect(second.body.results).toEqual([]);
		expect(second.body.deliveredChannels).toEqual([]);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);

		const stats = signalCrossTimeframeCooldown.getStats();
		expect(stats.suppressedCount).toBe(1);
	});

	it('does not collapse opposite-side flips (flip protection)', async () => {
		process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';

		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAY_TEXT })
			.expect(200);
		const flip = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: OPPOSITE_TEXT })
			.expect(200);

		expect(first.body.suppressedRepeat).toBeUndefined();
		expect(flip.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('does not collapse a different symbol on the same/different timeframe', async () => {
		process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAY_TEXT })
			.expect(200);
		const external = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: EXTERNAL_TEXT })
			.expect(200);

		expect(external.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('does not collapse when the prior signal is outside the window', async () => {
		process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
		process.env.ALERT_CROSS_TF_WINDOW_MS = '50';

		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAY_TEXT })
			.expect(200);
		await new Promise((resolve) => setTimeout(resolve, 80));
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: TF240_TEXT })
			.expect(200);

		expect(first.body.suppressedRepeat).toBeUndefined();
		expect(second.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('preserves the existing CB-230 same-timeframe suppression contract byte-for-byte', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		// ENABLE_ALERT_CROSS_TF_SUPPRESSION left unset (false): cross-tf module stays inert.

		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAY_TEXT })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAY_TEXT })
			.expect(200);

		expect(first.body.suppressedRepeat).toBeUndefined();
		expect(second.body.suppressedRepeat).toBe(true);
		expect(second.body.suppressionReason).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});
});
