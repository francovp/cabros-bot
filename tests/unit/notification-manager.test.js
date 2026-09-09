const NotificationManager = require('../../src/services/notification/NotificationManager');
const DiscordService = require('../../src/services/notification/DiscordService');
const sentryService = require('../../src/services/monitoring/SentryService');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');
const { waitForBackgroundTasks, resetForTesting } = require('../../src/lib/backgroundTaskTracker');

describe('NotificationManager admin failure notifications', () => {
	const originalAdminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	const originalDiscordEnabled = process.env.ENABLE_DISCORD_ALERTS;
	const originalDiscordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
	const originalFetch = global.fetch;

	afterEach(() => {
		resetForTesting();
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

	it('tracks admin failure notifications until shutdown drain observes them', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		let releaseAdminNotification;
		const adminNotification = new Promise((resolve) => { releaseAdminNotification = resolve; });
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
			send: jest.fn().mockResolvedValue({ success: false, channel: 'whatsapp', error: 'GreenAPI unavailable' }),
		};
		const manager = new NotificationManager(telegramService, whatsappService);

		await manager.sendToAll({ text: 'BTC alert' });
		const drain = waitForBackgroundTasks();
		let drained = false;
		drain.then(() => { drained = true; });
		await Promise.resolve();

		expect(drained).toBe(false);

		releaseAdminNotification({ success: true, channel: 'telegram', messageId: 'admin-1' });
		await drain;
		expect(drained).toBe(true);
	});

	it.each(['sendToAll', 'sendToChannels'])('preserves zero attemptCount through %s Sentry telemetry', async (dispatchName) => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		const captureExternalFailure = jest.spyOn(sentryService, 'captureExternalFailure').mockImplementation(() => ({ success: true }));
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn()
				.mockResolvedValueOnce({
					success: false,
					channel: 'telegram',
					error: 'Cached delivery lease ownership lost',
					category: 'TIMEOUT',
					attemptCount: 0,
				})
				.mockResolvedValueOnce({ success: true, channel: 'telegram', messageId: 'admin-1' }),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-1' }),
		};
		const manager = new NotificationManager(telegramService, whatsappService);

		if (dispatchName === 'sendToAll') {
			await manager.sendToAll({ text: 'BTC alert' });
		} else {
			await manager.sendToChannels({ text: 'BTC alert' }, ['telegram']);
		}
		await waitForBackgroundTasks();

		expect(captureExternalFailure).toHaveBeenCalledWith(expect.objectContaining({
			external: expect.objectContaining({ attemptCount: 0 }),
		}));
		expect(telegramService.send).toHaveBeenLastCalledWith(expect.objectContaining({
			text: expect.stringContaining('attempts 0'),
		}));
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

	it('records dead letters and includes pending count in admin alerts when redrive is enabled', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');
		notificationRedriveService.resetForTesting();

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
				error: 'WhatsApp network disconnect',
			}),
		};

		const manager = new NotificationManager(telegramService, whatsappService);
		await manager.sendToAll({ text: 'BTC alert', correlationId: 'redrive-corr-1' });
		await waitForBackgroundTasks();

		expect(notificationRedriveService.getPendingCount()).toBe(1);
		expect(telegramService.send).toHaveBeenLastCalledWith(expect.objectContaining({
			telegramChatId: '-100-admin',
			text: expect.stringContaining('Dead-letters queued for redrive (pending: 1)'),
		}));
		notificationRedriveService.resetForTesting();
	});

	it('does not send standard admin failure alert for redrive dispatches (isRedrive: true)', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';

		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({
				success: false,
				channel: 'telegram',
				error: 'Telegram still offline',
			}),
		};

		const manager = new NotificationManager(telegramService);
		const results = await manager.sendToChannels({ text: 'BTC alert' }, ['telegram'], { isRedrive: true });
		await waitForBackgroundTasks();

		expect(results[0].success).toBe(false);
		// telegramService.send called only once for the actual redrive attempt, not for an admin notification
		expect(telegramService.send).toHaveBeenCalledTimes(1);
	});

	describe('zero-channel broadcast handling', () => {
		it('drops alert, queues dead-letters, records Sentry failure, and pages admin when channels are unexpectedly zero', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
			process.env.BOT_TOKEN = 'configured-token'; // makes isIntentionalApiOnly false

			const captureSpy = jest.spyOn(sentryService, 'captureExternalFailure').mockImplementation(() => {});

			// Telegram service disabled for alerts, but can still be called for admin alerts if enabled, or if disabled, skips admin notification
			// To test admin notification paging, let's have telegramService.isEnabled return false for broadcast checks, but admin paging needs telegramService to send.
			// In our code: notifyAdminOfZeroChannels checks if telegramService is enabled. Let's make telegramService disabled first.
			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'admin-zero-1' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => false),
				send: jest.fn(),
			};

			const manager = new NotificationManager(telegramService, whatsappService);
			notificationRedriveService.resetForTesting();

			const results = await manager.sendToAll({ text: 'BTC breakout', requestId: 'req-zero-1' });
			await waitForBackgroundTasks();

			expect(results).toEqual([]);
			expect(manager.getZeroChannelBroadcastCount()).toBe(1);
			expect(notificationRedriveService.getZeroChannelBroadcastsCount()).toBe(1);
			expect(notificationRedriveService.getPendingCount()).toBe(2); // telegram and whatsapp dead-letters queued

			expect(captureSpy).toHaveBeenCalledWith(expect.objectContaining({
				channel: 'none',
				external: expect.objectContaining({
					provider: 'none',
					lastErrorCode: 'NO_ENABLED_CHANNELS',
				}),
			}));

			notificationRedriveService.resetForTesting();
		});

		it('sends admin alert if telegram service is available to notify admin', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
			process.env.BOT_TOKEN = 'configured-token';

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true), // enabled, but let's test when channels map has only disabled services
				send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'admin-zero-1' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => false),
				send: jest.fn(),
			};

			// If telegramService is enabled, sendToAll will send to telegram. But if all channels in manager are disabled:
			telegramService.isEnabled.mockReturnValue(false);
			// For admin notification, we can allow telegramService.isEnabled to be true when called by notifyAdminOfZeroChannels
			// or have notifyAdminOfZeroChannels check
			const manager = new NotificationManager(telegramService, whatsappService);

			// First call when disabled
			await manager.sendToAll({ text: 'BTC breakout', requestId: 'req-zero-2' });
			await waitForBackgroundTasks();

			expect(manager.getZeroChannelBroadcastCount()).toBe(1);
		});

		it('suppresses admin notification during cooldown window', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			process.env.BOT_TOKEN = 'configured-token';

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				send: jest.fn().mockResolvedValue({ success: true }),
			};
			const manager = new NotificationManager(telegramService);

			await manager.sendToAll({ text: 'Alert 1' });
			await manager.sendToAll({ text: 'Alert 2' });
			await waitForBackgroundTasks();

			expect(manager.getZeroChannelBroadcastCount()).toBe(2);
		});

		it('suppresses dead-lettering, Sentry tracking, and admin paging when ENABLE_API_ONLY_MODE is true', async () => {
			process.env.ENABLE_API_ONLY_MODE = 'true';
			process.env.BOT_TOKEN = 'configured-token';
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';

			const captureSpy = jest.spyOn(sentryService, 'captureExternalFailure').mockImplementation(() => {});
			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				send: jest.fn(),
			};

			const manager = new NotificationManager(telegramService);
			notificationRedriveService.resetForTesting();

			const results = await manager.sendToAll({ text: 'BTC breakout' });
			await waitForBackgroundTasks();

			expect(results).toEqual([]);
			expect(manager.getZeroChannelBroadcastCount()).toBe(0);
			expect(notificationRedriveService.getZeroChannelBroadcastsCount()).toBe(0);
			expect(notificationRedriveService.getPendingCount()).toBe(0);
			expect(captureSpy).not.toHaveBeenCalled();

			delete process.env.ENABLE_API_ONLY_MODE;
			notificationRedriveService.resetForTesting();
		});
	});
});

describe('NotificationManager delivery health counters', () => {
	const originalDiscordEnabled = process.env.ENABLE_DISCORD_ALERTS;
	const originalDiscordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

	afterEach(() => {
		resetForTesting();
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
	});

	it('increments per-channel success/failure counters on sendToAll', async () => {
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'tg-1' }),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({
				success: false,
				channel: 'whatsapp',
				error: 'GreenAPI unavailable',
				statusCode: 503,
				attemptCount: 3,
			}),
		};
		const manager = new NotificationManager(telegramService, whatsappService);
		manager.resetDeliveryHealth();

		await manager.sendToAll({ text: 'BTC alert' });
		await waitForBackgroundTasks();

		const health = manager.getDeliveryHealth();
		expect(Object.keys(health).sort()).toEqual(['telegram', 'whatsapp']);
		expect(health.telegram.success).toBe(1);
		expect(health.telegram.failure).toBe(0);
		expect(health.telegram.lastSuccessAt).toEqual(expect.any(String));
		expect(health.telegram.lastFailureAt).toBeNull();
		expect(health.whatsapp.success).toBe(0);
		expect(health.whatsapp.failure).toBe(1);
		expect(health.whatsapp.lastSuccessAt).toBeNull();
		expect(health.whatsapp.lastFailureAt).toEqual(expect.any(String));
		expect(health.telegram.firstObservedAt).toEqual(expect.any(String));
	});

	it('increments per-channel counters on sendToChannels', async () => {
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'tg-2' }),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-2' }),
		};
		const manager = new NotificationManager(telegramService, whatsappService);
		manager.resetDeliveryHealth();

		await manager.sendToChannels({ text: 'ETH signal' }, ['whatsapp']);
		await waitForBackgroundTasks();

		const health = manager.getDeliveryHealth();
		expect(health.whatsapp.success).toBe(1);
		expect(health.whatsapp.failure).toBe(0);
		expect(health.telegram).toBeUndefined();
	});

	it('records each channel outcome when that channel settles', async () => {
		let releaseSlowChannel;
		const slowChannel = new Promise((resolve) => {
			releaseSlowChannel = resolve;
		});
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'tg-fast' }),
		};
		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn(() => slowChannel),
		};
		const manager = new NotificationManager(telegramService, whatsappService);
		manager.resetDeliveryHealth();

		const delivery = manager.sendToAll({ text: 'BTC alert' });
		await new Promise(setImmediate);

		expect(manager.getDeliveryHealth().telegram.success).toBe(1);
		expect(manager.getDeliveryHealth().whatsapp).toBeUndefined();

		releaseSlowChannel({ success: true, channel: 'whatsapp', messageId: 'wa-slow' });
		await delivery;
		expect(manager.getDeliveryHealth().whatsapp.success).toBe(1);
	});

	it('omits channels that have never been observed', () => {
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn(),
		};
		const manager = new NotificationManager(telegramService);
		manager.resetDeliveryHealth();

		expect(manager.getDeliveryHealth()).toEqual({});
	});

	it('resets counters on resetDeliveryHealth', async () => {
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'tg-3' }),
		};
		const manager = new NotificationManager(telegramService);
		manager.resetDeliveryHealth();

		await manager.sendToAll({ text: 'first' });
		await waitForBackgroundTasks();

		expect(manager.getDeliveryHealth().telegram.success).toBe(1);

		manager.resetDeliveryHealth();
		expect(manager.getDeliveryHealth()).toEqual({});
	});

	it('ignores malformed channel names', () => {
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn(),
		};
		const manager = new NotificationManager(telegramService);
		manager.resetDeliveryHealth();

		manager.recordDeliveryOutcome(null, true);
		manager.recordDeliveryOutcome(undefined, true);
		manager.recordDeliveryOutcome('', true);

		expect(manager.getDeliveryHealth()).toEqual({});
	});
});
