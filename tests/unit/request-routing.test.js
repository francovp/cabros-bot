const {
	parseNotificationRouting,
	sendWithNotificationRouting,
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

describe('requestRouting - strict chat ID validation (opt-in via { strictChatIds: true })', () => {
	it('accepts numeric Telegram chat IDs and GreenAPI WhatsApp chat IDs when strict is enabled', () => {
		const result = parseNotificationRouting(
			{
				telegramChatId: '-1001234567890',
				whatsappChatId: '120363025492938@g.us',
			},
			{ strictChatIds: true },
		);
		expect(result.telegramChatId).toBe('-1001234567890');
		expect(result.whatsappChatId).toBe('120363025492938@g.us');
	});

	it('accepts @c.us WhatsApp chat IDs in strict mode', () => {
		const result = parseNotificationRouting(
			{ whatsappChatId: '5511999999999@c.us' },
			{ strictChatIds: true },
		);
		expect(result.whatsappChatId).toBe('5511999999999@c.us');
	});

	it('rejects @public handles in strict mode (only numeric Telegram IDs accepted by default)', () => {
		expect(() => parseNotificationRouting(
			{ telegramChatId: '@tradingview' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting(
			{ telegramChatId: '@everyone' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);
	});

	it('rejects free-form Telegram chat IDs in strict mode', () => {
		expect(() => parseNotificationRouting(
			{ telegramChatId: '<script>alert(1)</script>' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting(
			{ telegramChatId: 'not-a-number' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting(
			{ telegramChatId: '0' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);
	});

	it('rejects malformed WhatsApp chat IDs in strict mode', () => {
		expect(() => parseNotificationRouting(
			{ whatsappChatId: 'not-a-greenapi-id' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting(
			{ whatsappChatId: '120363025492938@unknown.us' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting(
			{ whatsappChatId: 'abc@c.us' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);
	});

	it('rejects chat IDs that contain MarkdownV2 escape-trigger characters in strict mode', () => {
		expect(() => parseNotificationRouting(
			{ telegramChatId: '100123 ' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting(
			{ telegramChatId: '100123<' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);

		expect(() => parseNotificationRouting(
			{ whatsappChatId: '120363@g.us\r' },
			{ strictChatIds: true },
		)).toThrow(NotificationRoutingValidationError);
	});

	it('does NOT validate chat IDs by default (strictChatIds opt-in for back-compat)', () => {
		const result = parseNotificationRouting({
			telegramChatId: 'chat-override-999',
			whatsappChatId: 'not-a-greenapi-id',
		});
		expect(result.telegramChatId).toBe('chat-override-999');
		expect(result.whatsappChatId).toBe('not-a-greenapi-id');
	});

	it('still returns undefined when chat IDs are omitted in strict mode', () => {
		const result = parseNotificationRouting({ text: 'hello' }, { strictChatIds: true });
		expect(result.telegramChatId).toBeUndefined();
		expect(result.whatsappChatId).toBeUndefined();
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

