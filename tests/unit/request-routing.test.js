const {
	parseNotificationRouting,
	sendWithNotificationRouting,
	assertChannelsAvailable,
	NotificationRoutingValidationError,
} = require('../../src/services/notification/requestRouting');

describe('requestRouting - discordWebhookUrl validation', () => {
	it('parses valid HTTPS Discord webhook URLs', () => {
		const result = parseNotificationRouting({
			discordWebhookUrl: 'https://discord.com/api/webhooks/123456/abc-xyz',
		});
		expect(result.discordWebhookUrl).toBe('https://discord.com/api/webhooks/123456/abc-xyz');

		const canaryResult = parseNotificationRouting({
			discordWebhookUrl: 'https://canary.discord.com/api/webhooks/987654/token-abc',
		});
		expect(canaryResult.discordWebhookUrl).toBe('https://canary.discord.com/api/webhooks/987654/token-abc');

		const appResult = parseNotificationRouting({
			discordWebhookUrl: 'https://discordapp.com/api/webhooks/987654/token-abc',
		});
		expect(appResult.discordWebhookUrl).toBe('https://discordapp.com/api/webhooks/987654/token-abc');
	});

	it('returns undefined when discordWebhookUrl is omitted', () => {
		const result = parseNotificationRouting({ text: 'hello' });
		expect(result.discordWebhookUrl).toBeUndefined();
	});

	it('throws NotificationRoutingValidationError for non-string or empty discordWebhookUrl', () => {
		expect(() => parseNotificationRouting({ discordWebhookUrl: '' }))
			.toThrow(NotificationRoutingValidationError);
		expect(() => parseNotificationRouting({ discordWebhookUrl: 12345 }))
			.toThrow(NotificationRoutingValidationError);
	});

	it('throws NotificationRoutingValidationError for non-HTTPS Discord webhook URLs', () => {
		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'http://discord.com/api/webhooks/123456/abc',
		})).toThrow(NotificationRoutingValidationError);
	});

	it('throws NotificationRoutingValidationError for non-Discord domains', () => {
		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'https://attacker.com/api/webhooks/123456/abc',
		})).toThrow(NotificationRoutingValidationError);
	});

	it('throws NotificationRoutingValidationError when path missing /api/webhooks/', () => {
		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'https://discord.com/api/v10/channels/123/messages',
		})).toThrow(NotificationRoutingValidationError);
	});

	it('throws NotificationRoutingValidationError for malformed Discord webhook paths without ID and token', () => {
		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'https://discord.com/api/webhooks/',
		})).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'https://discord.com/api/webhooks/123456',
		})).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'https://discord.com/api/webhooks/123456/',
		})).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'https://discord.com/api/webhooks/abc/token',
		})).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting({
			discordWebhookUrl: 'https://discord.com/foo/api/webhooks/123456/token',
		})).toThrow(NotificationRoutingValidationError);
	});

	it('includes discordWebhookUrl in sendWithNotificationRouting alert payload', async () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['discord']),
			sendToChannels: jest.fn().mockResolvedValue([{ success: true, channel: 'discord' }]),
			sendToAll: jest.fn().mockResolvedValue([{ success: true, channel: 'discord' }]),
		};

		const alert = { text: 'Alert message' };
		const routing = {
			channels: ['discord'],
			discordWebhookUrl: 'https://discord.com/api/webhooks/123456/abc-xyz',
		};

		await sendWithNotificationRouting(notificationManager, alert, routing);

		expect(notificationManager.sendToChannels).toHaveBeenCalledWith(
			expect.objectContaining({
				text: 'Alert message',
				discordWebhookUrl: 'https://discord.com/api/webhooks/123456/abc-xyz',
			}),
			['discord'],
			{},
		);
	});
});

describe('requestRouting - telegramThreadId validation', () => {
	it('parses valid integer and numeric string telegramThreadId', () => {
		expect(parseNotificationRouting({ telegramThreadId: 12345 }).telegramThreadId).toBe(12345);
		expect(parseNotificationRouting({ telegramThreadId: '12345' }).telegramThreadId).toBe(12345);
		expect(parseNotificationRouting({ telegramThreadId: 0 }).telegramThreadId).toBe(0);
		expect(parseNotificationRouting({ messageThreadId: 67890 }).telegramThreadId).toBe(67890);
		expect(parseNotificationRouting({ telegram_thread_id: 11111 }).telegramThreadId).toBe(11111);
		expect(parseNotificationRouting({ message_thread_id: 22222 }).telegramThreadId).toBe(22222);
	});

	it('returns undefined when telegramThreadId is omitted', () => {
		const result = parseNotificationRouting({ text: 'hello' });
		expect(result.telegramThreadId).toBeUndefined();
	});

	it('throws NotificationRoutingValidationError for negative or non-integer thread IDs', () => {
		expect(() => parseNotificationRouting({ telegramThreadId: -1 })).toThrow(NotificationRoutingValidationError);
		expect(() => parseNotificationRouting({ telegramThreadId: 1.5 })).toThrow(NotificationRoutingValidationError);
		expect(() => parseNotificationRouting({ telegramThreadId: 'abc' })).toThrow(NotificationRoutingValidationError);
		expect(() => parseNotificationRouting({ telegramThreadId: '' })).toThrow(NotificationRoutingValidationError);
		expect(() => parseNotificationRouting({ telegramThreadId: null })).toThrow(NotificationRoutingValidationError);
	});

	it('includes telegramThreadId in sendWithNotificationRouting alert payload', async () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
			sendToChannels: jest.fn().mockResolvedValue([{ success: true, channel: 'telegram' }]),
			sendToAll: jest.fn().mockResolvedValue([{ success: true, channel: 'telegram' }]),
		};

		const alert = { text: 'Alert message' };
		const routing = {
			channels: ['telegram'],
			telegramThreadId: 123,
		};

		await sendWithNotificationRouting(notificationManager, alert, routing);

		expect(notificationManager.sendToChannels).toHaveBeenCalledWith(
			expect.objectContaining({
				text: 'Alert message',
				telegramThreadId: 123,
			}),
			['telegram'],
			{},
		);
	});
});

describe('requestRouting - assertChannelsAvailable (GH-854 fail-fast)', () => {
	it('is a no-op when routing.channels is omitted (legacy broadcast)', () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
		};

		expect(() => assertChannelsAvailable(notificationManager, {})).not.toThrow();
		expect(() => assertChannelsAvailable(notificationManager, { channels: undefined })).not.toThrow();
		expect(() => assertChannelsAvailable(notificationManager, null)).not.toThrow();
		// Legacy broadcast does not consult the notification manager
		expect(notificationManager.getEnabledChannels).not.toHaveBeenCalled();
	});

	it('is a no-op when every requested channel is enabled', () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram', 'whatsapp', 'discord']),
		};

		expect(() => assertChannelsAvailable(notificationManager, { channels: ['telegram', 'discord'] }))
			.not.toThrow();
		expect(notificationManager.getEnabledChannels).toHaveBeenCalledTimes(1);
	});

	it('throws NotificationRoutingValidationError when a requested channel is disabled', () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
		};

		expect(() => assertChannelsAvailable(notificationManager, { channels: ['whatsapp'] }))
			.toThrow(NotificationRoutingValidationError);
		try {
			assertChannelsAvailable(notificationManager, { channels: ['whatsapp'] });
		} catch (error) {
			expect(error).toBeInstanceOf(NotificationRoutingValidationError);
			expect(error.statusCode).toBe(400);
			expect(error.message).toContain('Requested channel(s) disabled or misconfigured');
			expect(error.details).toEqual(expect.objectContaining({ field: 'channels', unavailableChannels: ['whatsapp'] }));
		}
	});

	it('lists every unavailable channel when multiple are missing', () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
		};

		expect(() => assertChannelsAvailable(notificationManager, { channels: ['whatsapp', 'discord'] }))
			.toThrow(/whatsapp.*discord|discord.*whatsapp/);
	});

	it('tolerates a missing notification manager when routing.channels is absent', () => {
		expect(() => assertChannelsAvailable(null, {})).not.toThrow();
		expect(() => assertChannelsAvailable(undefined, { channels: undefined })).not.toThrow();
	});
});
