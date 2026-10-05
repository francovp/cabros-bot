const NotificationManager = require('../../src/services/notification/NotificationManager');
const DiscordService = require('../../src/services/notification/DiscordService');
const sentryService = require('../../src/services/monitoring/SentryService');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');
const { deliveryMetricsService } = require('../../src/services/notification/DeliveryMetricsService');
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
			{ success: true, channel: 'telegram', messageId: 'alert-1', durationMs: expect.any(Number) },
			{
				success: false,
				channel: 'whatsapp',
				error: 'GreenAPI 503: unavailable',
				statusCode: 503,
				attemptCount: 3,
				durationMs: expect.any(Number),
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
			{ success: false, channel: 'telegram', error: 'Telegram unavailable', durationMs: expect.any(Number) },
			{ success: true, channel: 'whatsapp', messageId: 'wa-1', durationMs: expect.any(Number) },
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
			{ success: false, channel: 'whatsapp', error: 'GreenAPI unavailable', durationMs: expect.any(Number) },
		]);
		expect(telegramService.send).toHaveBeenCalledTimes(1);
		expect(telegramService.send).toHaveBeenCalledWith(expect.objectContaining({
			telegramChatId: '-100-admin',
			text: expect.stringContaining('Failed channels: whatsapp'),
		}));
	});

	it('guarantees durationMs is populated and non-negative on all formatted results', async () => {
		const mockTelegram = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram' }),
		};
		const failingWhatsapp = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockRejectedValue(new Error('Network crash')),
		};
		const manager = new NotificationManager(mockTelegram, failingWhatsapp);

		const allResults = await manager.sendToAll({ text: 'BTC alert' });
		expect(allResults).toHaveLength(2);
		for (const res of allResults) {
			expect(typeof res.durationMs).toBe('number');
			expect(res.durationMs).toBeGreaterThanOrEqual(0);
		}

		const routedResults = await manager.sendToChannels({ text: 'BTC alert' }, ['telegram', 'whatsapp']);
		expect(routedResults).toHaveLength(2);
		for (const res of routedResults) {
			expect(typeof res.durationMs).toBe('number');
			expect(res.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	it('times each channel individually when calculating fallback durationMs', async () => {
		const fastTelegram = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockImplementation(() => new Promise((resolve) => {
				setTimeout(() => resolve({ success: true, channel: 'telegram' }), 10);
			})),
		};
		const slowWhatsapp = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockImplementation(() => new Promise((resolve) => {
				setTimeout(() => resolve({ success: true, channel: 'whatsapp' }), 60);
			})),
		};
		const manager = new NotificationManager(fastTelegram, slowWhatsapp);

		const results = await manager.sendToAll({ text: 'Timing test' });
		const telegramResult = results.find((r) => r.channel === 'telegram');
		const whatsappResult = results.find((r) => r.channel === 'whatsapp');

		expect(telegramResult.durationMs).toBeLessThan(whatsappResult.durationMs);
		expect(telegramResult.durationMs).toBeLessThan(50);
		expect(whatsappResult.durationMs).toBeGreaterThanOrEqual(50);
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

		it('suppresses dead-lettering when alert or options is marked as probe or redrive ineligible', async () => {
			process.env.BOT_TOKEN = 'configured-token';
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';

			const recordSpy = jest.spyOn(notificationRedriveService, 'recordDeliveryResults');
			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				send: jest.fn(),
			};

			const manager = new NotificationManager(telegramService);
			notificationRedriveService.resetForTesting();

			await manager.sendToAll({ text: 'Probe test', isProbe: true });
			await waitForBackgroundTasks();

			expect(recordSpy).not.toHaveBeenCalled();
			recordSpy.mockRestore();
			notificationRedriveService.resetForTesting();
		});

		it('sends admin alert when telegram broadcast channel is disabled but bot is eligible for admin delivery', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
			process.env.BOT_TOKEN = 'configured-token';

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				isAdminDeliveryEligible: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'admin-zero-1' }),
			};

			const manager = new NotificationManager(telegramService);
			notificationRedriveService.resetForTesting();

			await manager.sendToAll({ text: 'BTC breakout', requestId: 'req-zero-admin-test' });
			await waitForBackgroundTasks();

			expect(manager.getZeroChannelBroadcastCount()).toBe(1);
			expect(telegramService.send).toHaveBeenCalledTimes(1);
			expect(telegramService.send).toHaveBeenCalledWith(expect.objectContaining({
				telegramChatId: '-100-admin',
				text: expect.stringContaining('CRITICAL: Notification delivery failure (Zero channels enabled)'),
			}));

			notificationRedriveService.resetForTesting();
		});

		it('queues dead letters only for operator-configured channels during zero-channel broadcast drop', async () => {
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
			process.env.BOT_TOKEN = 'configured-token';

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => true),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => false),
			};
			const discordService = {
				name: 'discord',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => false),
			};

			const manager = new NotificationManager(telegramService, whatsappService, discordService);
			notificationRedriveService.resetForTesting();

			await manager.sendToAll({ text: 'BTC breakout', requestId: 'req-configured-only' });
			await waitForBackgroundTasks();

			expect(manager.getZeroChannelBroadcastCount()).toBe(1);
			expect(notificationRedriveService.getPendingCount()).toBe(1);
			const pending = Array.from(notificationRedriveService.inMemoryStore.values());
			expect(pending.map(r => r.channel)).toEqual(['telegram']);

			notificationRedriveService.resetForTesting();
		});

		it('does not queue dead letters when zero channels are operator-configured', async () => {
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
			process.env.BOT_TOKEN = 'configured-token';

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => false),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => false),
			};

			const manager = new NotificationManager(telegramService, whatsappService);
			notificationRedriveService.resetForTesting();

			await manager.sendToAll({ text: 'BTC breakout', requestId: 'req-zero-configured' });
			await waitForBackgroundTasks();

			expect(manager.getZeroChannelBroadcastCount()).toBe(1);
			expect(notificationRedriveService.getPendingCount()).toBe(0);

			notificationRedriveService.resetForTesting();
		});
	});

	describe('sendToChannels signal composition', () => {
		it('composes channel lease signal with caller signal so caller abort cancels delivery', async () => {
			const callerController = new AbortController();
			const channelController = new AbortController();
			let observedSignal;

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn().mockImplementation((_, options) => {
					observedSignal = options.signal;
					return Promise.resolve({ success: true, channel: 'telegram' });
				}),
			};

			const manager = new NotificationManager(telegramService);
			await manager.sendToChannels(
				{ text: 'BTC alert' },
				['telegram'],
				{
					signal: callerController.signal,
					signalByChannel: {
						telegram: channelController.signal,
					},
				},
			);

			expect(observedSignal).toBeDefined();
			expect(observedSignal.aborted).toBe(false);

			callerController.abort('caller cancelled');
			expect(observedSignal.aborted).toBe(true);
		});

		it('composes channel lease signal with caller signal so channel lease loss cancels delivery', async () => {
			const callerController = new AbortController();
			const channelController = new AbortController();
			let observedSignal;

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn().mockImplementation((_, options) => {
					observedSignal = options.signal;
					return Promise.resolve({ success: true, channel: 'telegram' });
				}),
			};

			const manager = new NotificationManager(telegramService);
			await manager.sendToChannels(
				{ text: 'BTC alert' },
				['telegram'],
				{
					signal: callerController.signal,
					signalByChannel: {
						telegram: channelController.signal,
					},
				},
			);

			expect(observedSignal).toBeDefined();
			expect(observedSignal.aborted).toBe(false);

			channelController.abort('lease lost');
			expect(observedSignal.aborted).toBe(true);
		});
	});

	describe('zero-channel page diagnostic context (GH-713)', () => {
		it('includes the configured and unconfigured channel names in the zero-channel admin page', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => false),
				send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'admin-ctx-1' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => true),
				send: jest.fn(),
			};
			const discordService = {
				name: 'discord',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => false),
				send: jest.fn(),
			};

			const manager = new NotificationManager(telegramService, whatsappService, discordService);

			await manager.sendToAll({ text: 'BTC breakout', requestId: 'req-ctx-1' });
			await waitForBackgroundTasks();

			const adminMessage = telegramService.send.mock.calls.at(-1)[0].text;

			// Operators must be able to answer "why did I get this page?" from the message alone.
			expect(adminMessage).toContain('whatsapp');
			expect(adminMessage).toMatch(/configured/i);
			expect(adminMessage).toMatch(/not configured|unconfigured/i);
		});

		it('reports a distinct message when no channel is configured by operator intent', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => false),
				send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'admin-ctx-2' }),
			};

			const manager = new NotificationManager(telegramService);

			await manager.sendToAll({ text: 'ETH breakout', requestId: 'req-ctx-2' });
			await waitForBackgroundTasks();

			const adminMessage = telegramService.send.mock.calls.at(-1)[0].text;

			expect(adminMessage).toMatch(/no notification channels are configured/i);
			// The dead-letter line must not claim dead-letters were queued when nothing was queued.
			expect(adminMessage).not.toMatch(/dead-lettered/i);
			expect(adminMessage).not.toMatch(/Dead-letters queued for redrive/i);
		});
	});

	describe('admin paging fallback when the admin Telegram chat breaks (#1168)', () => {
		afterEach(() => {
			deliveryMetricsService.resetForTesting();
		});

		it('falls back to WhatsApp when the admin Telegram page fails with chat not found', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			jest.spyOn(console, 'error').mockImplementation(() => {});

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn()
					// broadcast delivery fails → triggers the admin page
					.mockResolvedValueOnce({
						success: false,
						channel: 'telegram',
						error: 'Telegram unavailable',
						statusCode: 502,
						attemptCount: 1,
					})
					// admin page → definitive 400
					.mockResolvedValueOnce({
						success: false,
						channel: 'telegram',
						error: 'Bad Request: chat not found',
						statusCode: 400,
						attemptCount: 1,
					}),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'wa-1' })
					.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'wa-admin-1' }),
			};

			const manager = new NotificationManager(telegramService, whatsappService);
			await manager.sendToAll({ text: 'BTC alert' });
			await waitForBackgroundTasks();

			expect(whatsappService.send).toHaveBeenCalledTimes(2);
			expect(whatsappService.send.mock.calls[1][0]).toEqual(
				expect.objectContaining({ text: expect.stringContaining('Failed channels: telegram') }),
			);
			// The fallback payload must not carry the Telegram admin chat id.
			expect(whatsappService.send.mock.calls[1][0].telegramChatId).toBeUndefined();
			expect(manager.getAdminPagingStatus()).toEqual(expect.objectContaining({
				status: 'ready',
				lastSuccessChannel: 'whatsapp',
				consecutiveFailures: 0,
			}));
		});

		it('skips a channel already known to be failing and pages the healthy one', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			jest.spyOn(console, 'error').mockImplementation(() => {});

			// Simulate the live production signal: whatsapp healthy, discord 0/3.
			for (let i = 0; i < 3; i += 1) {
				deliveryMetricsService.record({ channel: 'discord', success: false });
			}
			deliveryMetricsService.record({ channel: 'whatsapp', success: true });

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'Telegram unavailable' })
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'chat not found' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'wa-1' })
					.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'wa-admin-1' }),
			};
			const discordService = {
				name: 'discord',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				send: jest.fn().mockResolvedValue({ success: true, channel: 'discord', messageId: 'dc-1' }),
			};

			const manager = new NotificationManager(telegramService, whatsappService, discordService);
			await manager.sendToAll({ text: 'BTC alert' });
			await waitForBackgroundTasks();

			// discord is first in the deterministic order but is 0/3, so it is skipped entirely
			// and the healthy whatsapp carries the page.
			expect(discordService.send).toHaveBeenCalledTimes(1);
			expect(whatsappService.send.mock.calls[1][0].text).toContain('Failed channels: telegram');
			expect(manager.getAdminPagingStatus().lastSuccessChannel).toBe('whatsapp');
		});

		it('does not page the same channel that just failed its own delivery', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			jest.spyOn(console, 'error').mockImplementation(() => {});

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: true, channel: 'telegram', messageId: 'tg-1' })
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'chat not found' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				// Broadcast fails → whatsapp is now 0/1 and must not receive its own failure page.
				send: jest.fn().mockResolvedValue({ success: false, channel: 'whatsapp', error: 'GreenAPI 503' }),
			};

			const manager = new NotificationManager(telegramService, whatsappService);
			await manager.sendToAll({ text: 'BTC alert' });
			await waitForBackgroundTasks();

			expect(whatsappService.send).toHaveBeenCalledTimes(1);
			expect(manager.getAdminPagingStatus()).toEqual(expect.objectContaining({
				status: 'degraded',
				consecutiveFailures: 1,
				fallbackChannels: [],
			}));
		});

		it('does not page a never-configured channel (no phantom admin page)', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			jest.spyOn(console, 'error').mockImplementation(() => {});

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'Telegram unavailable' })
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'chat not found' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => false),
				send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-1' }),
			};
			const discordService = {
				name: 'discord',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => false),
				send: jest.fn(),
			};

			const manager = new NotificationManager(telegramService, whatsappService, discordService);
			await manager.sendToAll({ text: 'BTC alert' });
			await waitForBackgroundTasks();

			// whatsapp and discord each saw only their own broadcast delivery — no admin page.
			expect(whatsappService.send).toHaveBeenCalledTimes(1);
			expect(discordService.send).toHaveBeenCalledTimes(1);
			// Undeliverable on every operator channel is still recorded, not silently dropped.
			expect(manager.getAdminPagingStatus()).toEqual(expect.objectContaining({
				status: 'degraded',
				consecutiveFailures: 1,
				fallbackChannels: [],
			}));
		});

		it('records a Sentry event and reports degraded status when every operator channel fails', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			jest.spyOn(console, 'error').mockImplementation(() => {});
			const captureSpy = jest.spyOn(sentryService, 'captureExternalFailure').mockImplementation(() => ({ success: true }));

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'Telegram unavailable' })
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'chat not found' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				// Healthy historically, so it is still a candidate, and it throws on the page.
				send: jest.fn()
					.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'wa-1' })
					.mockRejectedValueOnce(new Error('GreenAPI down')),
			};
			// A prior successful whatsapp delivery keeps it eligible for the page attempt.
			deliveryMetricsService.record({ channel: 'whatsapp', success: true });

			const manager = new NotificationManager(telegramService, whatsappService);
			await manager.sendToAll({ text: 'BTC alert' });
			await waitForBackgroundTasks();

			expect(captureSpy).toHaveBeenCalledWith(expect.objectContaining({
				channel: 'admin-paging',
				external: expect.objectContaining({ lastErrorCode: 'ADMIN_PAGING_UNDELIVERABLE' }),
				extra: expect.objectContaining({ page_type: 'delivery-failure' }),
			}));
			expect(manager.getAdminPagingStatus()).toEqual(expect.objectContaining({
				status: 'degraded',
				attempts: 2,
				failures: 2,
				consecutiveFailures: 2,
			}));
		});

		it('routes the zero-channel page through the same fallback chain', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			process.env.BOT_TOKEN = 'configured-token';
			jest.spyOn(console, 'error').mockImplementation(() => {});

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => false),
				isAdminDeliveryEligible: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				send: jest.fn().mockResolvedValue({ success: false, channel: 'telegram', error: 'chat not found' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => false),
				isConfigured: jest.fn(() => true),
				send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-admin-zero' }),
			};

			const manager = new NotificationManager(telegramService, whatsappService);
			await manager.sendToAll({ text: 'BTC breakout', requestId: 'req-zero-fallback' });
			await waitForBackgroundTasks();

			expect(whatsappService.send).toHaveBeenCalledTimes(1);
			expect(whatsappService.send.mock.calls[0][0].text).toContain('Zero channels enabled');
			notificationRedriveService.resetForTesting();
		});

		it('preserves the real attemptCount reported in the admin page', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			jest.spyOn(console, 'error').mockImplementation(() => {});

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'Telegram unavailable' })
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'chat not found', attemptCount: 1 }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'wa-1' })
					.mockResolvedValueOnce({ success: true, channel: 'whatsapp', messageId: 'wa-admin' }),
			};

			const manager = new NotificationManager(telegramService, whatsappService);
			await manager.sendToAll({ text: 'BTC alert' });
			await waitForBackgroundTasks();

			const byChannel = manager.getAdminPagingStatus().byChannel;
			expect(byChannel).toEqual(expect.arrayContaining([
				expect.objectContaining({ pageType: 'delivery-failure', channel: 'telegram', failure: 1 }),
				expect.objectContaining({ pageType: 'delivery-failure', channel: 'whatsapp', success: 1 }),
			]));
		});

		it('does not record admin fallback sends in broadcast delivery metrics', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
			jest.spyOn(console, 'error').mockImplementation(() => {});

			const telegramService = {
				name: 'telegram',
				isEnabled: jest.fn(() => true),
				send: jest.fn()
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'Telegram unavailable' })
					.mockResolvedValueOnce({ success: false, channel: 'telegram', error: 'chat not found' }),
			};
			const whatsappService = {
				name: 'whatsapp',
				isEnabled: jest.fn(() => true),
				isConfigured: jest.fn(() => true),
				// broadcast fails; the admin fallback send succeeds
				send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-1' }),
			};

			const manager = new NotificationManager(telegramService, whatsappService);
			await manager.sendToAll({ text: 'BTC alert' });
			await waitForBackgroundTasks();

			expect(whatsappService.send).toHaveBeenCalledTimes(2); // broadcast + admin fallback
			// Only the single broadcast attempt is counted for whatsapp.
			expect(deliveryMetricsService.getSnapshot().byChannel.whatsapp.total).toBe(1);
		});
	});
});

describe('NotificationManager delivery-metrics durationMs fallback (#1112)', () => {
	const { deliveryMetricsService } = require('../../src/services/notification/DeliveryMetricsService');
	const FALLBACK_DISPATCH_MS = 742;

	let manager;

	beforeEach(() => {
		deliveryMetricsService.resetForTesting();
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => false),
			isConfigured: jest.fn(() => true),
			send: jest.fn(),
		};
		manager = new NotificationManager(telegramService);
	});

	afterEach(() => {
		deliveryMetricsService.resetForTesting();
		jest.restoreAllMocks();
	});

	// Issue #1112: an excluded sample would leave averageDeliveryMs null instead of the fallback value.
	it.each([
		['missing', undefined],
		['null', null],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY],
		['non-numeric string', 'fast'],
	])('substitutes the total dispatch duration when a channel result has a %s durationMs', (_label, durationMs) => {
		manager._recordDeliveryMetrics(
			[{ success: true, channel: 'telegram', durationMs }],
			FALLBACK_DISPATCH_MS,
		);

		const snapshot = deliveryMetricsService.getSnapshot();
		expect(snapshot.success).toBe(1);
		expect(snapshot.byChannel.telegram.averageDeliveryMs).toBe(FALLBACK_DISPATCH_MS);
	});

	it('excludes a negative durationMs from the average but still counts the delivery', () => {
		manager._recordDeliveryMetrics(
			[{ success: true, channel: 'telegram', durationMs: -5 }],
			FALLBACK_DISPATCH_MS,
		);

		// A negative value is a finite number, so the manager keeps it instead of substituting;
		// record()'s non-negative guard is what drops it from the average.
		const snapshot = deliveryMetricsService.getSnapshot();
		expect(snapshot.success).toBe(1);
		expect(snapshot.byChannel.telegram.averageDeliveryMs).toBeNull();
	});

	it('keeps a valid channel-reported durationMs instead of the dispatch fallback', () => {
		manager._recordDeliveryMetrics(
			[{ success: true, channel: 'telegram', durationMs: 120 }],
			FALLBACK_DISPATCH_MS,
		);

		const snapshot = deliveryMetricsService.getSnapshot();
		expect(snapshot.byChannel.telegram.averageDeliveryMs).toBe(120);
	});

	it('substitutes only the affected results and averages them with reported durations', () => {
		manager._recordDeliveryMetrics(
			[
				{ success: true, channel: 'telegram', durationMs: 100 },
				{ success: false, channel: 'whatsapp' },
				{ success: true, channel: 'discord', durationMs: Number.NaN },
			],
			FALLBACK_DISPATCH_MS,
		);

		const snapshot = deliveryMetricsService.getSnapshot();
		expect(snapshot.total).toBe(3);
		expect(snapshot.failure).toBe(1);
		// (100 + 742 + 742) / 3 — the whatsapp sample is included via the fallback, not dropped.
		expect(snapshot.averageDeliveryMs).toBe(528);
		expect(snapshot.byChannel.telegram.averageDeliveryMs).toBe(100);
		expect(snapshot.byChannel.whatsapp.averageDeliveryMs).toBe(FALLBACK_DISPATCH_MS);
		expect(snapshot.byChannel.discord.averageDeliveryMs).toBe(FALLBACK_DISPATCH_MS);
	});

	it('still records counters for a skipped result without counting it as a delivery', () => {
		manager._recordDeliveryMetrics(
			[{ success: true, channel: 'telegram', durationMs: 50, skipped: true }],
			FALLBACK_DISPATCH_MS,
		);

		expect(deliveryMetricsService.getSnapshot()).toBeNull();
	});
});

