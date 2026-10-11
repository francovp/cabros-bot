/* global jest, describe, it, beforeEach, afterEach, expect, saveEnv, restoreEnv */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const {
	initializeNotificationServices,
	getNotificationManager,
	__resetNotificationManagerForTesting,
} = require('../../src/controllers/webhooks/handlers/alert/alert');
const { burstAggregator } = require('../../src/services/alerts/burstAggregator');

/**
 * These tests drive the real `/api/webhook/alert` route with the real
 * NotificationManager. Only the provider transports are mocked, because the
 * thing under test is how many channel messages a burst actually produces.
 *
 * A held alert keeps its HTTP response open for the window, so the assertions
 * rely on the real (short) window rather than fake timers: with the 1000ms
 * floor the suite stays fast while still exercising the genuine timer path.
 */
const WINDOW_MS = 1000;

function alert(text) {
	return { text };
}

const RISK_OFF_BURST = [
	'BINANCE:BTCUSDT (D) VENTA — ruptura',
	'BINANCE:BTCUSDT (240) VENTA — ruptura',
	'BINANCE:ETHUSDT (240) VENTA — ruptura',
	'BINANCE:BNBUSDT (D) VENTA — ruptura',
];

describe('Alert burst aggregation endpoint behavior (#1104)', () => {
	let savedEnv;
	let telegramSendMessage;
	let whatsappFetch;
	let originalFetch;
	let mockBot;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '-1001234567890',
			ENABLE_WHATSAPP_ALERTS: 'true',
			WHATSAPP_API_URL: 'https://api.green.com/waInstance123/',
			WHATSAPP_API_KEY: 'whatsapp-test-key',
			WHATSAPP_CHAT_ID: '120363422033474991@c.us',
			ENABLE_GEMINI_GROUNDING: 'false',
			ALERT_BURST_WINDOW_MS: String(WINDOW_MS),
			ALERT_BURST_MIN_SIGNALS: '3',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
		});
		delete process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION;

		jest.clearAllMocks();
		__resetNotificationManagerForTesting();
		burstAggregator.reset();

		telegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'tg-msg' });
		mockBot = {
			telegram: {
				sendMessage: telegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		originalFetch = global.fetch;
		whatsappFetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ success: true, idMessage: 'wa-msg' }),
			text: async () => '',
		});
		global.fetch = whatsappFetch;

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		global.fetch = originalFetch;
		restoreEnv(savedEnv);
		burstAggregator.reset();
		__resetNotificationManagerForTesting();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	function postAlert(text, body = {}) {
		return request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', process.env.WEBHOOK_API_KEY)
			.send({ ...alert(text), ...body });
	}

	describe('flag off (default)', () => {
		it('delivers every alert individually and adds no aggregated marker', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'false';

			const responses = await Promise.all(RISK_OFF_BURST.map((text) => postAlert(text)));

			for (const response of responses) {
				expect(response.status).toBe(200);
				expect(response.body.aggregated).toBeUndefined();
				expect(response.body.burstAggregateId).toBeUndefined();
				expect(response.body.results).toHaveLength(2);
				expect(response.body.deliveredChannels).toEqual(expect.arrayContaining(['telegram', 'whatsapp']));
			}

			expect(telegramSendMessage).toHaveBeenCalledTimes(4);
			expect(whatsappFetch).toHaveBeenCalledTimes(4);
		});
	});

	describe('same-direction burst', () => {
		it('collapses a 4-symbol SELL burst into one message per channel', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			const responses = await Promise.all(RISK_OFF_BURST.map((text) => postAlert(text)));

			// One regime message per channel, not 4.
			expect(telegramSendMessage).toHaveBeenCalledTimes(1);
			expect(whatsappFetch).toHaveBeenCalledTimes(1);

			const aggregateIds = new Set();
			for (const response of responses) {
				expect(response.status).toBe(200);
				expect(response.body.aggregated).toBe(true);
				expect(response.body.burstSignalCount).toBe(4);
				expect(response.body.deliveredChannels).toEqual(expect.arrayContaining(['telegram', 'whatsapp']));
				expect(response.body.burstAggregateId).toEqual(expect.any(String));
				aggregateIds.add(response.body.burstAggregateId);
			}
			expect(aggregateIds.size).toBe(1);

			const sentText = telegramSendMessage.mock.calls[0][1];
			expect(sentText).toContain('RISK\\-OFF');
			expect(sentText).toContain('BTCUSDT');
			expect(sentText).toContain('ETHUSDT');
			expect(sentText).toContain('BNBUSDT');
		});

		it('escapes aggregated symbols for MarkdownV2 on Telegram', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			await Promise.all([
				postAlert('NASDAQ:BRK.B (1D) VENTA'),
				postAlert('NASDAQ:A-B-C (1D) VENTA'),
				postAlert('NASDAQ:X.Y.Z (1D) VENTA'),
			]);

			const [chatId, sentText, extra] = telegramSendMessage.mock.calls[0];
			expect(sentText).toContain('BRK\\.B');
			expect(sentText).toContain('A\\-B\\-C');
			expect(sentText).toContain('X\\.Y\\.Z');
			// The chat id and parse mode must be untouched by aggregation.
			expect(chatId).toBe('-1001234567890');
			expect(extra).toMatchObject({ parse_mode: 'MarkdownV2' });
		});

		it('aggregates a cross-asset BUY burst so a regime shift reads as one event', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			await Promise.all([
				postAlert('BATS:TSM (1D) COMPRA'),
				postAlert('BATS:ORCL (1D) COMPRA'),
				postAlert('BATS:QCOM (1D) COMPRA'),
				postAlert('BINANCE:ETHUSDT (240) COMPRA'),
			]);

			expect(telegramSendMessage).toHaveBeenCalledTimes(1);
			const sentText = telegramSendMessage.mock.calls[0][1];
			expect(sentText).toContain('RISK\\-ON');
			expect(sentText).toContain('BATS:TSM');
			expect(sentText).toContain('BINANCE:ETHUSDT');
		});

		it('records the aggregation counters on the dependency status', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			await Promise.all(RISK_OFF_BURST.map((text) => postAlert(text)));

			const status = await request(app)
				.get('/api/status')
				.set('x-api-key', process.env.WEBHOOK_API_KEY);

			expect(status.status).toBe(200);
			expect(status.body.featureFlags.alertBurstAggregation).toBe(true);
			expect(status.body.dependencies.alertBurstAggregation).toMatchObject({
				enabled: true,
				openWindows: 0,
				aggregatedBurstCount: 1,
				aggregatedSignalCount: 4,
				aggregatedFailoverCount: 0,
				windowMs: WINDOW_MS,
				minSignals: 3,
			});
			expect(status.body.dependencies.alertBurstAggregation.lastAggregatedAt).not.toBeNull();
		});
	});

	describe('grouping rules', () => {
		it('never merges mixed directions and evaluates each side independently', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			const responses = await Promise.all([
				postAlert('BINANCE:BTCUSDT (1D) VENTA'),
				postAlert('BINANCE:ETHUSDT (1D) VENTA'),
				postAlert('BATS:TSM (1D) COMPRA'),
				postAlert('BATS:ORCL (1D) COMPRA'),
				postAlert('BATS:QCOM (1D) COMPRA'),
			]);

			const sells = responses.slice(0, 2);
			const buys = responses.slice(2);
			expect(sells.every((response) => response.body.aggregated === undefined)).toBe(true);
			expect(buys.every((response) => response.body.aggregated === true)).toBe(true);

			// 2 SELL messages + 1 aggregate BUY message.
			expect(telegramSendMessage).toHaveBeenCalledTimes(3);
			const aggregateCalls = telegramSendMessage.mock.calls.filter((call) => String(call[1]).includes('RISK\\-ON'));
			expect(aggregateCalls).toHaveLength(1);
		});

		it('delivers normally when the burst is below ALERT_BURST_MIN_SIGNALS', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			process.env.ALERT_BURST_MIN_SIGNALS = '4';

			const responses = await Promise.all([
				postAlert('BINANCE:BTCUSDT (1D) VENTA'),
				postAlert('BINANCE:ETHUSDT (1D) VENTA'),
				postAlert('BINANCE:BNBUSDT (1D) VENTA'),
			]);

			expect(telegramSendMessage).toHaveBeenCalledTimes(3);
			expect(responses.every((response) => response.body.aggregated === undefined)).toBe(true);
		});

		it('never merges alerts with different channels or chat overrides', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			const responses = await Promise.all([
				postAlert('BINANCE:BTCUSDT (1D) VENTA'),
				postAlert('BINANCE:ETHUSDT (1D) VENTA'),
				postAlert('BINANCE:BNBUSDT (1D) VENTA', { channels: ['telegram'] }),
				postAlert('BINANCE:XRPUSDT (1D) VENTA', { telegramChatId: '-1009999' }),
			]);

			// Three distinct routing identities, each below the minimum of 3.
			expect(responses.every((response) => response.body.aggregated === undefined)).toBe(true);
			const aggregateCalls = telegramSendMessage.mock.calls.filter((call) => String(call[1]).includes('Regime shift'));
			expect(aggregateCalls).toHaveLength(0);

			const chatIds = telegramSendMessage.mock.calls.map((call) => call[0]);
			expect(chatIds).toContain('-1009999');
		});

		it('never merges symbol-route requests because one message cannot honour per-symbol channels', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			const responses = await Promise.all([
				postAlert('BINANCE:BTCUSDT (1D) VENTA', { symbolRoutes: { BTCUSDT: { channels: ['telegram'] } } }),
				postAlert('BINANCE:ETHUSDT (1D) VENTA', { symbolRoutes: { ETHUSDT: { channels: ['telegram'] } } }),
				postAlert('BINANCE:BNBUSDT (1D) VENTA', { symbolRoutes: { BNBUSDT: { channels: ['telegram'] } } }),
			]);

			expect(responses.every((response) => response.body.aggregated === undefined)).toBe(true);
			const aggregateCalls = telegramSendMessage.mock.calls.filter((call) => String(call[1]).includes('Regime shift'));
			expect(aggregateCalls).toHaveLength(0);
			expect(telegramSendMessage).toHaveBeenCalledTimes(3);
		});

		it('bypasses unparsed alert text entirely', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			const responses = await Promise.all([
				postAlert('alerta manual sin simbolo'),
				postAlert('otra alerta manual'),
				postAlert('tercera alerta manual'),
			]);

			expect(responses.every((response) => response.body.aggregated === undefined)).toBe(true);
			expect(telegramSendMessage).toHaveBeenCalledTimes(3);
		});

		it('does not hold a dry-run request in the window', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			const started = Date.now();
			const responses = await Promise.all([
				postAlert('BINANCE:BTCUSDT (1D) VENTA', { dryRun: true }),
				postAlert('BINANCE:ETHUSDT (1D) VENTA', { dryRun: true }),
			]);

			expect(responses.every((response) => response.body.dryRun === true)).toBe(true);
			expect(Date.now() - started).toBeLessThan(WINDOW_MS);
			expect(telegramSendMessage).not.toHaveBeenCalled();
		});
	});

	describe('fail-open', () => {
		it('delivers every held alert individually when the aggregate dispatch throws', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const manager = getNotificationManager();
			const originalSendToAll = manager.sendToAll.bind(manager);
			manager.sendToAll = async (alertPayload, options) => {
				if (alertPayload && alertPayload.source === 'webhook-alert-burst') {
					throw new Error('simulated aggregate dispatch failure');
				}
				return originalSendToAll(alertPayload, options);
			};

			const responses = await Promise.all(RISK_OFF_BURST.map((text) => postAlert(text)));

			for (const response of responses) {
				expect(response.status).toBe(200);
				expect(response.body.aggregated).toBeUndefined();
				expect(response.body.burstAggregateId).toBeUndefined();
				expect(response.body.deliveredChannels).toEqual(expect.arrayContaining(['telegram', 'whatsapp']));
			}
			// No constituent was lost: each one reached its channel individually.
			expect(telegramSendMessage).toHaveBeenCalledTimes(4);
			const aggregateCalls = telegramSendMessage.mock.calls
				.filter((call) => String(call[1]).includes('Regime shift'));
			expect(aggregateCalls).toHaveLength(0);
			expect(burstAggregator.getStats().aggregatedFailoverCount).toBe(1);
		});

		it('still returns 200 and persists when a channel fails inside the aggregate', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			whatsappFetch.mockResolvedValue({
				ok: false,
				status: 500,
				json: async () => ({ error: 'green api down' }),
			});

			const responses = await Promise.all(RISK_OFF_BURST.map((text) => postAlert(text)));

			for (const response of responses) {
				expect(response.status).toBe(200);
				expect(response.body.aggregated).toBe(true);
				expect(response.body.deliveredChannels).toContain('telegram');
				expect(response.body.results.some((result) => result.channel === 'whatsapp' && result.success === false)).toBe(true);
			}
		});
	});

	describe('shutdown flush', () => {
		it('releases a held alert when the windows are flushed before the window elapses', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';

			const pending = Promise.all([
				postAlert('BINANCE:BTCUSDT (1D) VENTA'),
				postAlert('BINANCE:ETHUSDT (1D) VENTA'),
				postAlert('BINANCE:BNBUSDT (1D) VENTA'),
			]);
			// Let all three reach the aggregator and open the shared window.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(burstAggregator.getOpenWindowCount()).toBe(1);

			await burstAggregator.flushAll('shutdown');
			const responses = await pending;

			expect(burstAggregator.getOpenWindowCount()).toBe(0);
			expect(responses).toHaveLength(3);
			expect(responses.every((response) => response.status === 200)).toBe(true);
			expect(telegramSendMessage).toHaveBeenCalledTimes(1);
		});
	});
});