/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { getCooldownChannelIdentity } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { initializeNotificationServices, getNotificationManager, resetNotificationManagerForTesting } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { signalRepeatCooldown } = require('../../src/services/alerts/signalRepeatCooldown');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

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
		resetNotificationManagerForTesting();
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

	afterEach(() => {
		restoreEnv(savedEnv);
		signalRepeatCooldown.reset();
		notificationRedriveService._resetForTesting();
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

	it('keeps cooldown reservations independent for destination overrides', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT, channels: ['telegram'], telegramChatId: 'chat-a' })
			.expect(200);
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT, channels: ['telegram'], telegramChatId: 'chat-b' })
			.expect(200);

		expect(second.body.suppressedRepeat).toBeUndefined();
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(2);
	});

	it('cancels a pending default-destination redrive after concrete delivery', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		delete process.env.TELEGRAM_CHAT_ID;
		const key = 'BINANCE|ETHUSDT|4h|BUY';
		const defaultChannel = getCooldownChannelIdentity('telegram', {});

		await notificationRedriveService.recordDeliveryResults(
			{ text: SIGNAL_TEXT, correlationId: 'default-destination-redrive' },
			[{ channel: 'telegram', success: false, error: 'Initial zero-channel drop' }],
			{
				repeatCooldown: {
					key,
					channelsByName: { telegram: defaultChannel },
					destinationsByName: { telegram: 'default' },
				},
			},
		);

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT, channels: ['telegram'], telegramChatId: 'chat-a' })
			.expect(200);

		expect(notificationRedriveService.inMemoryStore.get('default-destination-redrive_telegram').status)
			.toBe('cancelled');
	});

	it('cancels a pending default redrive after an opposite-side concrete delivery', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		delete process.env.TELEGRAM_CHAT_ID;
		const key = 'BINANCE|ETHUSDT|4h|BUY';
		const defaultChannel = getCooldownChannelIdentity('telegram', {});

		await notificationRedriveService.recordDeliveryResults(
			{ text: SIGNAL_TEXT, correlationId: 'opposite-default-redrive' },
			[{ channel: 'telegram', success: false, error: 'Initial zero-channel drop' }],
			{ repeatCooldown: { key, channelsByName: { telegram: defaultChannel } } },
		);

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT.replace('COMPRA', 'VENTA'), channels: ['telegram'], telegramChatId: 'chat-a' })
			.expect(200);

		expect(notificationRedriveService.inMemoryStore.get('opposite-default-redrive_telegram').status)
			.toBe('cancelled');
	});

	it('does not retain a late failure after an opposite-side delivery supersedes it', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		const supersededSpy = jest.spyOn(notificationRedriveService, 'isRepeatCooldownSuperseded').mockResolvedValue(true);
		mockTelegramSendMessage.mockRejectedValueOnce(new Error('late BUY failure'));

		try {
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: SIGNAL_TEXT })
				.expect(200);

			expect(supersededSpy).toHaveBeenCalled();
			expect(signalRepeatCooldown.getChannelTimestamp(
				'BINANCE|ETHUSDT|4h|BUY',
				getCooldownChannelIdentity('telegram', {}),
			)).toBeNull();
		} finally {
			supersededSpy.mockRestore();
		}
	});

	it('does not record suppressed repeats as signal outcomes', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		const enabledSpy = jest.spyOn(signalOutcomeService, 'isEnabled').mockReturnValue(true);
		const recordSpy = jest.spyOn(signalOutcomeService, 'recordSignal').mockResolvedValue(null);

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

			expect(recordSpy).toHaveBeenCalledTimes(1);
		} finally {
			enabledSpy.mockRestore();
			recordSpy.mockRestore();
		}
	});

	it('releases failed reservations when redrive is explicitly disabled', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'disabled';
		mockTelegramSendMessage.mockRejectedValue(new Error('Telegram unavailable'));

		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);

		expect(signalRepeatCooldown.getStats().activeTrackedSignals).toBe(0);
	});

	it('releases worker-role failures when durable redrive storage is unavailable', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
		const durableStoreSpy = jest.spyOn(notificationRedriveService, 'hasDurableStore').mockReturnValue(false);
		mockTelegramSendMessage.mockRejectedValue(new Error('Telegram unavailable'));

		try {
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: SIGNAL_TEXT })
				.expect(200);

			expect(signalRepeatCooldown.getStats().activeTrackedSignals).toBe(0);
		} finally {
			durableStoreSpy.mockRestore();
		}
	});

	it('does not retain synthetic cooldowns in intentional API-only mode', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		process.env.ENABLE_API_ONLY_MODE = 'true';
		process.env.ENABLE_TELEGRAM_BOT = 'false';
		process.env.ENABLE_WHATSAPP_ALERTS = 'false';
		process.env.ENABLE_DISCORD_ALERTS = 'false';
		const runtimeConfigSpy = jest.spyOn(remoteConfigService, 'getRuntimeConfig').mockReturnValue({ ENABLE_API_ONLY_MODE: true });
		for (const channel of getNotificationManager().channels.values()) {
			channel.enabled = false;
		}

		try {
			const first = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: SIGNAL_TEXT })
				.expect(200);
			const second = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: SIGNAL_TEXT })
				.expect(200);

			expect(first.body.suppressedRepeat).toBeUndefined();
			expect(second.body.suppressedRepeat).toBeUndefined();
			expect(signalRepeatCooldown.getStats().activeTrackedSignals).toBe(0);
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		} finally {
			runtimeConfigSpy.mockRestore();
		}
	});

	it('fingerprints the preview WhatsApp destination', () => {
		process.env.RAILWAY_ENVIRONMENT_NAME = 'cabros-bot-pr-671';
		process.env.WHATSAPP_PREVIEW_CHAT_ID = 'preview-chat@g.us';
		process.env.WHATSAPP_CHAT_ID = 'production-chat@g.us';

		const previewIdentity = getCooldownChannelIdentity('whatsapp', {});
		process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
		const productionIdentity = getCooldownChannelIdentity('whatsapp', {});

		expect(previewIdentity).not.toBe(productionIdentity);
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

		const originalReserve = signalRepeatCooldown.reserve;
		signalRepeatCooldown.reserve = () => ({ suppressed: false });

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
			signalRepeatCooldown.reserve = originalReserve;
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

	it('reserves the signal before an overlapping delivery completes', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		let releaseFirst;
		mockTelegramSendMessage
			.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
			.mockResolvedValueOnce({ message_id: 'unexpected-second-delivery' });

		const firstRequest = request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT });
		const firstResponse = new Promise((resolve, reject) => {
			firstRequest.end((error, response) => (error ? reject(error) : resolve(response)));
		});
		await new Promise((resolve) => {
			const waitForReservation = () => (releaseFirst ? resolve() : setImmediate(waitForReservation));
			waitForReservation();
		});

		const overlapping = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		expect(overlapping.body.suppressedRepeat).toBe(true);

		releaseFirst({ message_id: 'first-delivery' });
		expect((await firstResponse).statusCode).toBe(200);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
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

	it('validates explicit routing and returns 400 even when signal is within repeat cooldown', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		process.env.ENABLE_DISCORD_ALERTS = 'false';

		// First request with default routing succeeds and establishes cooldown
		const first = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT })
			.expect(200);
		expect(first.body.deliveredChannels).toEqual(['telegram']);

		// Second request explicitly requests disabled discord channel: must return 400, not 200 suppressed
		const second = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: SIGNAL_TEXT, channels: ['discord'] })
			.expect(400);

		expect(second.body.success).toBe(false);
		expect(second.body.error).toContain('Requested channel(s) disabled or misconfigured');
	});
});
