/* global jest, describe, it, beforeEach, afterEach, expect, saveEnv, restoreEnv */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices, resetNotificationManagerForTesting } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { crossTimeframeCooldown } = require('../../src/services/alerts/crossTimeframeCooldown');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

const DAILY_SELL = 'BINANCE:BTCUSDT(D) cambió a señal de VENTA';
const FOUR_HOUR_SELL = 'BINANCE:BTCUSDT(240) pasó a señal de VENTA';
const FOUR_HOUR_BUY = 'BINANCE:BTCUSDT(240) pasó a señal de COMPRA';

describe('Alert cross-timeframe duplicate suppression endpoint behavior', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			ENABLE_DISCORD_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_ALERT_CROSS_TF_SUPPRESSION: 'true',
			ALERT_CROSS_TF_WINDOW_MS: '60000',
		});

		jest.clearAllMocks();
		resetNotificationManagerForTesting();
		crossTimeframeCooldown.reset();

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
		crossTimeframeCooldown.reset();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	function post(text, body = {}) {
		return request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text, ...body });
	}

	it('collapses a D + 240 same-direction pair into a single delivery', async () => {
		const first = await post(DAILY_SELL).expect(200);
		expect(first.body.suppressedRepeat).toBeUndefined();
		expect(first.body.suppressionReason).toBeUndefined();
		expect(first.body.deliveredChannels).toEqual(['telegram']);

		const second = await post(FOUR_HOUR_SELL).expect(200);
		expect(second.body.success).toBe(true);
		expect(second.body.suppressedRepeat).toBe(true);
		expect(second.body.suppressionReason).toBe('cross_timeframe_duplicate');
		expect(second.body.results).toEqual([]);
		expect(second.body.deliveredChannels).toEqual([]);
		expect(second.body.requestedChannels).toEqual(['telegram']);

		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		expect(crossTimeframeCooldown.getStats().suppressedCount).toBe(1);
	});

	it('collapses a 240 + D pair too — the collapse is not order-dependent', async () => {
		await post(FOUR_HOUR_SELL).expect(200);
		const second = await post(DAILY_SELL).expect(200);

		expect(second.body.suppressedRepeat).toBe(true);
		expect(second.body.suppressionReason).toBe('cross_timeframe_duplicate');
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});

	it('never collapses an opposite-side flip, and the flip clears the stale entry', async () => {
		await post(DAILY_SELL).expect(200);

		// Opposite side => a different store key, so it is never collapsed.
		const flip = await post(FOUR_HOUR_BUY).expect(200);
		expect(flip.body.suppressedRepeat).toBeUndefined();
		expect(flip.body.deliveredChannels).toEqual(['telegram']);

		// The flip cleared the pre-flip SELL entry, so a SELL that returns inside
		// the window is delivered rather than swallowed by the earlier signal.
		const backToSell = await post(FOUR_HOUR_SELL).expect(200);
		expect(backToSell.body.suppressedRepeat).toBeUndefined();

		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(3);
		expect(crossTimeframeCooldown.getStats().suppressedCount).toBe(0);
	});

	it('leaves different symbols and different exchanges alone', async () => {
		await post(DAILY_SELL).expect(200);
		await post('BINANCE:ETHUSDT(240) pasó a señal de VENTA').expect(200);
		await post('NASDAQ:NVDA(240) cambió a señal de VENTA').expect(200);

		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(3);
		expect(crossTimeframeCooldown.getStats().suppressedCount).toBe(0);
	});

	it('does not collapse when the flag is disabled (default behavior)', async () => {
		process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'false';

		await post(DAILY_SELL).expect(200);
		const second = await post(FOUR_HOUR_SELL).expect(200);

		expect(second.body.suppressedRepeat).toBeUndefined();
		expect(second.body.suppressionReason).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('delivers again once the window has elapsed', async () => {
		process.env.ALERT_CROSS_TF_WINDOW_MS = '0';

		await post(DAILY_SELL).expect(200);
		const second = await post(FOUR_HOUR_SELL).expect(200);

		expect(second.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('still delivers a dry run and does not consume the store', async () => {
		const dryRun = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: DAILY_SELL, dryRun: true })
			.expect(200);
		expect(dryRun.body.dryRun).toBe(true);

		// The dry run returned before the gate, so the live pair still collapses.
		const live = await post(DAILY_SELL).expect(200);
		expect(live.body.suppressedRepeat).toBeUndefined();
		const collapsed = await post(FOUR_HOUR_SELL).expect(200);
		expect(collapsed.body.suppressedRepeat).toBe(true);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});

	it('persists the suppression marker so audit and replay stay complete', async () => {
		const saveAlert = jest.spyOn(alertStorageService, 'saveAlert');
		await post(DAILY_SELL).expect(200);
		await post(FOUR_HOUR_SELL).expect(200);

		const suppressedCall = saveAlert.mock.calls.find(([payload]) => payload.suppressedRepeat === true);
		expect(suppressedCall).toBeDefined();
		expect(suppressedCall[0]).toMatchObject({
			text: FOUR_HOUR_SELL,
			suppressedRepeat: true,
			suppressionReason: 'cross_timeframe_duplicate',
		});

		const deliveredCall = saveAlert.mock.calls.find(([payload]) => payload.text === DAILY_SELL);
		expect(deliveredCall[0].suppressionReason).toBeNull();
		saveAlert.mockRestore();
	});

	describe('destination scoping', () => {
		let originalFetch;

		beforeEach(() => {
			originalFetch = global.fetch;
		});

		afterEach(() => {
			global.fetch = originalFetch;
		});

		it('keeps the timeframe per destination after a narrowing leg', async () => {
			process.env.ENABLE_DISCORD_ALERTS = 'true';
			process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/111/webhook-token';
			const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
			global.fetch = mockFetch;
			resetNotificationManagerForTesting();
			await initializeNotificationServices(mockBot);

			// DiscordService also probes the webhook, so count only the executions
			// it POSTs rather than every fetch.
			const discordPosts = () => mockFetch.mock.calls
				.filter(([, init]) => init && init.method === 'POST').length;

			const first = await post(DAILY_SELL, {
				channels: ['telegram'],
				telegramChatId: '-1001111111',
			}).expect(200);
			expect(first.body.suppressedRepeat).toBeUndefined();
			expect(first.body.deliveredChannels).toEqual(['telegram']);

			// Telegram:A already holds the 1D leg, so this 4h leg is narrowed to
			// the free discord destination.
			const narrowed = await post(FOUR_HOUR_SELL, {
				channels: ['telegram', 'discord'],
				telegramChatId: '-1001111111',
			}).expect(200);
			expect(narrowed.body.suppressedRepeat).toBeUndefined();
			expect(narrowed.body.deliveredChannels).toEqual(['discord']);
			expect(discordPosts()).toBe(1);

			// This leg repeats the timeframe the narrowing leg just reserved for
			// discord, but telegram:A still holds the 1D, so it must be collapsed.
			const repeat = await post(FOUR_HOUR_SELL, {
				channels: ['telegram'],
				telegramChatId: '-1001111111',
			}).expect(200);
			expect(repeat.body.suppressedRepeat).toBe(true);
			expect(repeat.body.suppressionReason).toBe('cross_timeframe_duplicate');
			expect(repeat.body.deliveredChannels).toEqual([]);

			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
			expect(discordPosts()).toBe(1);
			expect(crossTimeframeCooldown.getStats().suppressedCount).toBe(1);
		});
	});

	describe('provisional reservations', () => {
		it('retries delivery after the first leg failed on every channel', async () => {
			mockTelegramSendMessage.mockRejectedValueOnce(new Error('telegram unavailable'));

			const failed = await post(DAILY_SELL).expect(200);
			expect(failed.body.deliveredChannels).toEqual([]);
			expect(failed.body.results[0]).toMatchObject({ channel: 'telegram', success: false });
			expect(crossTimeframeCooldown.getStats().activeTrackedSignals).toBe(0);

			const callsBeforeRetry = mockTelegramSendMessage.mock.calls.length;
			const retry = await post(FOUR_HOUR_SELL).expect(200);
			expect(retry.body.suppressedRepeat).toBeUndefined();
			expect(retry.body.deliveredChannels).toEqual(['telegram']);
			expect(mockTelegramSendMessage.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
		});

		it('retries delivery after the first leg threw during dispatch', async () => {
			const { postAlert, getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
			const sendSpy = jest.spyOn(
				getNotificationManager().channels.get('telegram'),
				'send',
			).mockRejectedValueOnce(new Error('dispatch exploded'));
			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const run = (text) => new Promise((resolve) => {
				const req = { body: { text }, query: {} };
				const res = { status: jest.fn().mockReturnThis(), json: (payload) => resolve(payload) };
				postAlert(mockBot)(req, res).catch(() => resolve(null));
			});

			const failed = await run(DAILY_SELL);
			expect(failed.deliveredChannels).toEqual([]);
			expect(crossTimeframeCooldown.getStats().activeTrackedSignals).toBe(0);

			sendSpy.mockRestore();
			consoleSpy.mockRestore();

			const retry = await run(FOUR_HOUR_SELL);
			expect(retry.suppressedRepeat).toBeUndefined();
			expect(retry.deliveredChannels).toEqual(['telegram']);
		});

		it('leaves no reservation behind when the deployment cannot deliver at all', async () => {
			process.env.ENABLE_TELEGRAM_BOT = 'false';
			process.env.ENABLE_API_ONLY_MODE = 'true';
			resetNotificationManagerForTesting();
			await initializeNotificationServices(mockBot);

			const first = await post(DAILY_SELL).expect(200);
			expect(first.body.deliveredChannels).toEqual([]);
			expect(crossTimeframeCooldown.getStats().activeTrackedSignals).toBe(0);

			const second = await post(FOUR_HOUR_SELL).expect(200);
			expect(second.body.suppressedRepeat).toBeUndefined();
			expect(crossTimeframeCooldown.getStats().suppressedCount).toBe(0);
		});

		it('does not let one destination suppress a signal routed to another', async () => {
			const chatIdsSent = [];
			mockTelegramSendMessage.mockImplementation(async (_chatId) => {
				chatIdsSent.push(_chatId);
				return { message_id: 'test-msg-id' };
			});

			const first = await post(DAILY_SELL, { telegramChatId: '-1001111111' }).expect(200);
			expect(first.body.suppressedRepeat).toBeUndefined();

			const second = await post(FOUR_HOUR_SELL, { telegramChatId: '-1002222222' }).expect(200);
			expect(second.body.suppressedRepeat).toBeUndefined();
			expect(second.body.deliveredChannels).toEqual(['telegram']);
			expect(chatIdsSent).toEqual(['-1001111111', '-1002222222']);
			expect(crossTimeframeCooldown.getStats().suppressedCount).toBe(0);

			// Proves the gate is still armed for that destination.
			const third = await post('BINANCE:BTCUSDT(60) pasó a señal de VENTA', { telegramChatId: '-1002222222' }).expect(200);
			expect(third.body.suppressedRepeat).toBe(true);
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
		});
	});
});
