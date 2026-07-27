const NotificationManager = require('../../src/services/notification/NotificationManager');
const DiscordService = require('../../src/services/notification/DiscordService');
const sentryService = require('../../src/services/monitoring/SentryService');

describe('NotificationManager admin failure notifications', () => {
	const originalAdminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	const originalDiscordEnabled = process.env.ENABLE_DISCORD_ALERTS;
	const originalDiscordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
	const originalFetch = global.fetch;

	afterEach(() => {
		jest.restoreAllMocks();
		if (originalFetch === undefined) {
			delete global.fetch;
		} else {
			global.fetch = originalFetch;
		}
		if (originalDiscordEnabled === undefined) {
			delete process.env.ENABLE_DISCORD_ALERTS;
		} else {
			process.env.ENABLE_DISCORD_ALERTS = originalDiscordEnabled;
		}
		if (originalDiscordWebhookUrl === undefined) {
			delete process.env.DISCORD_WEBHOOK_URL;
		} else {
			process.env.DISCORD_WEBHOOK_URL = originalDiscordWebhookUrl;
		}
		if (originalAdminChatId === undefined) {
			delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		} else {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = originalAdminChatId;
		}
	});

	it('notifies the Telegram admin once when WhatsApp delivery fails', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn()
				.mockResolvedValueOnce({ success: true, channel: 'telegram', messageId: 'alert-1' })
				.mockResolvedValueOnce({ success: true, channel: 'telegram', messageId: 'admin-1' }),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({
				success: false,
				channel: 'whatsapp',
				error: 'GreenAPI 503: unavailable',
				statusCode: 503,
				attemptCount: 3,
			}),
		};
		const manager = new NotificationManager(telegramService, whatsappService);

		const results = await manager.sendToAll({ text: 'BTC alert', requestId: 'req-103' });

		expect(results).toEqual([
			{ success: true, channel: 'telegram', messageId: 'alert-1' },
			{
				success: false,
				channel: 'whatsapp',
				error: 'GreenAPI 503: unavailable',
				statusCode: 503,
				attemptCount: 3,
			},
		]);
		expect(telegramService.send).toHaveBeenCalledTimes(2);
		expect(telegramService.send).toHaveBeenLastCalledWith(expect.objectContaining({
			telegramChatId: '-100-admin',
			text: expect.stringContaining('Failed channels: whatsapp'),
		}));
		expect(telegramService.send.mock.calls[1][0].text).toContain('Succeeded channels: telegram');
		expect(telegramService.send.mock.calls[1][0].text).toContain('Request ID: req-103');
		expect(telegramService.send.mock.calls[1][0].text).toContain('status 503, attempts 3');
	});

	it('does not recurse or reject when Telegram and its admin notification fail', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		jest.spyOn(console, 'error').mockImplementation(() => {});
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({
				success: false,
				channel: 'telegram',
				error: 'Telegram unavailable',
			}),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-1' }),
		};
		const manager = new NotificationManager(telegramService, whatsappService);

		await expect(manager.sendToAll({ text: 'BTC alert' })).resolves.toEqual([
			{ success: false, channel: 'telegram', error: 'Telegram unavailable' },
			{ success: true, channel: 'whatsapp', messageId: 'wa-1' },
		]);
		expect(telegramService.send).toHaveBeenCalledTimes(2);
	});

	it('notifies the Telegram admin when a selectively routed channel fails', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'admin-1' }),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({
				success: false,
				channel: 'whatsapp',
				error: 'GreenAPI unavailable',
			}),
		};
		const manager = new NotificationManager(telegramService, whatsappService);

		const results = await manager.sendToChannels({ text: 'BTC alert' }, ['whatsapp']);

		expect(results).toEqual([
			{ success: false, channel: 'whatsapp', error: 'GreenAPI unavailable' },
		]);
		expect(telegramService.send).toHaveBeenCalledTimes(1);
		expect(telegramService.send).toHaveBeenCalledWith(expect.objectContaining({
			telegramChatId: '-100-admin',
			text: expect.stringContaining('Failed channels: whatsapp'),
		}));
	});

	it('returns delivery results without waiting for the admin notification', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		let resolveAdminNotification;
		const adminNotification = new Promise((resolve) => {
			resolveAdminNotification = resolve;
		});
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn()
				.mockResolvedValueOnce({ success: true, channel: 'telegram', messageId: 'alert-1' })
				.mockReturnValueOnce(adminNotification),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({
				success: false,
				channel: 'whatsapp',
				error: 'GreenAPI unavailable',
			}),
		};
		const manager = new NotificationManager(telegramService, whatsappService);
		let deliverySettled = false;

		const delivery = manager.sendToAll({ text: 'BTC alert' }).then((results) => {
			deliverySettled = true;
			return results;
		});
		await new Promise(setImmediate);
		const settledBeforeAdmin = deliverySettled;
		resolveAdminNotification({ success: true, channel: 'telegram', messageId: 'admin-1' });
		await delivery;

		expect(settledBeforeAdmin).toBe(true);
	});

	it.each([
		['sendToAll', (manager, alert) => manager.sendToAll(alert)],
		['sendToChannels', (manager, alert) => manager.sendToChannels(alert, ['discord'])],
	])('preserves Discord attemptCount through %s and admin failure alerting', async (_dispatchName, dispatch) => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		process.env.ENABLE_DISCORD_ALERTS = 'true';
		process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/token';
		const captureExternalFailure = jest.spyOn(sentryService, 'captureExternalFailure').mockImplementation(() => ({ success: true }));
		const discordService = new DiscordService({
			logger: { warn: jest.fn() },
			maxRetries: 2,
			maxRetryDelayMs: 100,
			maxTotalRetryWaitMs: 1000,
		});
		await discordService.validate();
		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 429,
			headers: new Map([['retry-after', '0.001']]),
			text: async () => 'rate limited',
		});
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'telegram-1' }),
		};
		const manager = new NotificationManager(telegramService, null, discordService);

		const results = await dispatch(manager, { text: 'BTC alert', requestId: 'req-discord-429' });

		expect(results).toContainEqual(expect.objectContaining({
			success: false,
			channel: 'discord',
			attemptCount: 3,
		}));
		expect(captureExternalFailure).toHaveBeenCalledWith(expect.objectContaining({
			external: expect.objectContaining({
				provider: 'discord-webhook',
				attemptCount: 3,
			}),
		}));
		expect(telegramService.send).toHaveBeenLastCalledWith(expect.objectContaining({
			telegramChatId: '-100-admin',
			text: expect.stringContaining('attempts 3'),
		}));
	});
});
