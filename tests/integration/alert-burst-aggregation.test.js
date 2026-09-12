/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const {
	initializeNotificationServices,
} = require('../../src/controllers/webhooks/handlers/alert/alert');
const { burstAggregator } = require('../../src/services/alerts/burstAggregator');
const { signalRepeatCooldown } = require('../../src/services/alerts/signalRepeatCooldown');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');

const BASE_TEXT_SELL = 'BINANCE:BTCUSDT (4h) cambió a señal de VENTA';
const BASE_TEXT_BUY = 'BINANCE:BTCUSDT (4h) cambió a señal de COMPRA';

function saveEnv() {
	const saved = {};
	for (const key of [
		'WEBHOOK_API_KEY', 'ENABLE_TELEGRAM_BOT', 'ENABLE_WHATSAPP_ALERTS',
		'BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ENABLE_GEMINI_GROUNDING',
		'ENABLE_ALERT_SYNTH_BURST_AGGREGATION', 'ALERT_BURST_WINDOW_MS',
		'ALERT_BURST_MIN_SIGNALS', 'ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION',
	]) {
		saved[key] = process.env[key];
	}
	return saved;
}

function restoreEnv(saved) {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function unescapeMarkdownV2(text) {
	return text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
}

describe('Alert burst aggregation endpoint behavior', () => {
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
			ENABLE_ALERT_SYNTH_BURST_AGGREGATION: 'true',
			ALERT_BURST_WINDOW_MS: '2000',
			ALERT_BURST_MIN_SIGNALS: '3',
			ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION: 'false',
		});

		jest.clearAllMocks();
		burstAggregator.reset();
		signalRepeatCooldown.reset();
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

	afterEach(async () => {
		restoreEnv(savedEnv);
		burstAggregator.reset();
		signalRepeatCooldown.reset();
		notificationRedriveService._resetForTesting();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		await new Promise((resolve) => setImmediate(resolve));
	});

	function telegramTexts() {
		return mockTelegramSendMessage.mock.calls.map((call) => {
			const text = call[1];
			return typeof text === 'string' ? unescapeMarkdownV2(text) : '';
		});
	}

	it('returns 200 with byte-for-byte identical payload when burst flag is disabled (default)', async () => {
		process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'false';

		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BASE_TEXT_SELL })
			.expect(200);

		expect(first.body.burstAggregateId).toBeUndefined();
		expect(first.body.aggregated).toBeUndefined();
		expect(first.body.pending).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});

	it('returns pending:true for each buffered alert and aggregates after the window closes', async () => {
		const r1 = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BASE_TEXT_SELL })
			.expect(200);
		expect(r1.body.pending).toBe(true);
		expect(r1.body.burstSignalCount).toBe(1);
		expect(r1.body.burstAggregateId).toBeDefined();

		const r2 = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (240) cambió a señal de VENTA' })
			.expect(200);
		expect(r2.body.pending).toBe(true);
		expect(r2.body.burstSignalCount).toBe(2);

		const r3 = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BNBUSDT (1D) cambió a señal de VENTA' })
			.expect(200);
		expect(r3.body.pending).toBe(true);
		expect(r3.body.burstSignalCount).toBe(3);

		await new Promise((resolve) => setTimeout(resolve, 2200));

		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		const texts = telegramTexts();
		expect(texts[0]).toMatch(/Regime: VENTA/);
		expect(texts[0]).toContain('BTCUSDT');
		expect(texts[0]).toContain('ETHUSDT');
		expect(texts[0]).toContain('BNBUSDT');
	});

	it('does not aggregate across sides (BUY and SELL stay separate)', async () => {
		process.env.ALERT_BURST_MIN_SIGNALS = '3';
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key').send({ text: BASE_TEXT_SELL }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key').send({ text: BASE_TEXT_BUY }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (240) cambió a señal de VENTA' }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BNBUSDT (1D) cambió a señal de VENTA' }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (240) cambió a señal de COMPRA' }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:LTCUSDT (1h) cambió a señal de COMPRA' }).expect(200);

		await new Promise((resolve) => setTimeout(resolve, 2200));

		const texts = telegramTexts();
		// 6 buffered alerts with MIN_SIGNALS=3 split into two bursts (SELL x3, BUY x3)
		expect(texts.length).toBe(2);
		expect(texts.filter((t) => t.includes('VENTA')).length).toBe(1);
		expect(texts.filter((t) => t.includes('COMPRA')).length).toBe(1);
	});

	it('falls back to individual delivery when burst is below MIN_SIGNALS', async () => {
		process.env.ALERT_BURST_MIN_SIGNALS = '3';
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key').send({ text: BASE_TEXT_SELL }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (240) cambió a señal de VENTA' }).expect(200);

		await new Promise((resolve) => setTimeout(resolve, 2200));

		const texts = telegramTexts();
		expect(texts.length).toBe(2);
		expect(texts[0]).toBe(BASE_TEXT_SELL);
		expect(texts[1]).toContain('ETHUSDT');
	});

	it('keeps different telegramChatId destinations in separate windows', async () => {
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: BASE_TEXT_SELL, telegramChatId: '-100AAA' }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (240) cambió a señal de VENTA', telegramChatId: '-100AAA' }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BNBUSDT (1D) cambió a señal de VENTA', telegramChatId: '-100AAA' }).expect(200);

		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:LTCUSDT (1h) cambió a señal de VENTA', telegramChatId: '-100BBB' }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:XRPUSDT (1h) cambió a señal de VENTA', telegramChatId: '-100BBB' }).expect(200);
		await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:DOGEUSDT (1h) cambió a señal de VENTA', telegramChatId: '-100BBB' }).expect(200);

		await new Promise((resolve) => setTimeout(resolve, 2200));

		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('exposes the same burstAggregateId on every participating alert response', async () => {
		const r1 = await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: BASE_TEXT_SELL }).expect(200);
		const r2 = await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (240) cambió a señal de VENTA' }).expect(200);
		const r3 = await request(app).post('/api/webhook/alert').set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BNBUSDT (1D) cambió a señal de VENTA' }).expect(200);

		expect(r1.body.burstAggregateId).toBe(r2.body.burstAggregateId);
		expect(r2.body.burstAggregateId).toBe(r3.body.burstAggregateId);
		expect(typeof r1.body.burstAggregateId).toBe('string');
	});

	it('honors dry-run and bypasses the burst buffer entirely', async () => {
		await request(app).post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: BASE_TEXT_SELL, dryRun: true })
			.expect(200);

		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		expect(burstAggregator.getStats().activeWindows).toBe(0);
	});
});
