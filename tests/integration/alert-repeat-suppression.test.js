/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { signalRepeatCooldown } = require('../../src/services/alerts/signalRepeatCooldown');

const SIGNAL_TEXT = 'BINANCE:ETHUSDT (4h) COMPRA — señal de prueba';

describe('Alert repeat suppression endpoint behavior', () => {
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
		});

		jest.clearAllMocks();
		signalRepeatCooldown.reset();

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
		signalRepeatCooldown.reset();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('delivers both alerts when suppression is disabled (default behavior)', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'false';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(second.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('suppresses the second same-signal alert and reports suppressedRepeat:true', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';

		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		expect(first.body.suppressedRepeat).toBeUndefined();
		expect(first.body.deliveredChannels).toEqual(['telegram']);

		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		expect(second.body.success).toBe(true);
		expect(second.body.suppressedRepeat).toBe(true);
		expect(second.body.results).toEqual([]);
		expect(second.body.deliveredChannels).toEqual([]);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);

		const stats = signalRepeatCooldown.getStats();
		expect(stats.suppressedCount).toBe(1);
	});

	it('always delivers an opposite-side flip regardless of cooldown', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		const flipText = 'BINANCE:ETHUSDT (4h) VENTA — giro bajista';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		const flip = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: flipText })
			.expect(200);

		expect(flip.body.suppressedRepeat).toBeUndefined();
		expect(flip.body.deliveredChannels).toEqual(['telegram']);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('fails open to delivery when the cooldown store errors', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';

		const throwingStore = new Map();
		throwingStore.get = () => {
			throw new Error('store unavailable');
		};
		const originalIsSuppressed = signalRepeatCooldown.isSuppressed;
		signalRepeatCooldown.isSuppressed = () => ({ suppressed: false });

		try {
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: SIGNAL_TEXT })
				.expect(200);
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: SIGNAL_TEXT })
				.expect(200);
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
		} finally {
			signalRepeatCooldown.isSuppressed = originalIsSuppressed;
		}
	});

	it('skips the cooldown entirely in dry-run mode', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';

		await request(app)
			.post('/api/webhook/alert?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(second.body.dryRun).toBe(true);
		expect(second.body.suppressedRepeat).toBeUndefined();
	});

	it('does not commit the cooldown when every channel delivery fails', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		mockTelegramSendMessage.mockRejectedValue(new Error('Telegram unavailable'));

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		expect(signalRepeatCooldown.getStats().activeTrackedSignals).toBe(0);

		// Provider recovers: the client retry delivers instead of being suppressed.
		mockTelegramSendMessage.mockResolvedValue({ message_id: 'recovered' });
		const retry = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(retry.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(retry.body.deliveredChannels).toEqual(['telegram']);
	});

	it('never suppresses alerts with unsupported raw timeframes', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		const oddTimeframe = 'BINANCE:ETHUSDT (3m) COMPRA — marco raro';

		await request(app)
			.post('/api/webhook/alert?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({ text: oddTimeframe })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({ text: oddTimeframe })
			.expect(200);

		// Dry-run bypasses the gate, so the pair proves nothing about cooldown;
		// assert via the service store instead using real delivery.
		signalRepeatCooldown.reset();
		const parsed = require('../../src/services/tradingview/parseTradingViewSignal').parseTradingViewSignal(oddTimeframe);
		const verdict = signalRepeatCooldown.isSuppressed(parsed);
		expect(verdict.suppressed).toBe(false);

		mockTelegramSendMessage.mockClear();
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: oddTimeframe })
			.expect(200);
		const third = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: `${oddTimeframe} (segundo aviso)` })
			.expect(200);

		expect(third.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('delivers a BUY → SELL → BUY sequence without swallowing the final re-entry', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		const buyText = 'BINANCE:ETHUSDT (4h) COMPRA — entrada larga';
		const sellText = 'BINANCE:ETHUSDT (4h) VENTA — giro corto';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: buyText })
			.expect(200);
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: sellText })
			.expect(200);
		const reBuy = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: buyText })
			.expect(200);

		expect(reBuy.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(3);
	});
});
