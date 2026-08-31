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

describe('requestRouting - symbolRoutes', () => {
	it('normalizes per-symbol channel routes', () => {
		expect(parseNotificationRouting({
			symbolRoutes: {
				btcusdt: { channels: ['telegram'] },
				' NASDAQ : NVDA ': { channels: ['discord'] },
			},
		}).symbolRoutes).toEqual({
			BTCUSDT: { channels: ['telegram'] },
			'NASDAQ:NVDA': { channels: ['discord'] },
		});
	});

	it('rejects invalid per-symbol channel routes', () => {
		expect(() => parseNotificationRouting({
			symbolRoutes: { BTCUSDT: { channels: ['slack'] } },
		})).toThrow(NotificationRoutingValidationError);
		expect(() => parseNotificationRouting({
			symbolRoutes: { BTCUSDT: { channels: ['telegram', 123] } },
		})).toThrow(NotificationRoutingValidationError);
	});

	it('dispatches matched symbols to their own channels', async () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram', 'discord']),
			sendToChannels: jest.fn(({ symbol }, channels) => Promise.resolve([
				{ success: true, channel: channels[0], symbol },
			])),
			sendToAll: jest.fn(),
		};

		const routing = parseNotificationRouting({
			symbolRoutes: {
				BTCUSDT: { channels: ['telegram'] },
				'NASDAQ:NVDA': { channels: ['discord'] },
			},
		});

		const results = await sendWithNotificationRouting(
			notificationManager,
			{ text: 'BTCUSDT and NASDAQ:NVDA momentum update' },
			routing,
		);

		expect(notificationManager.sendToChannels).toHaveBeenCalledTimes(2);
		expect(notificationManager.sendToChannels.mock.calls.map(([, channels]) => channels)).toEqual([
			['telegram'],
			['discord'],
		]);
		expect(results).toEqual([
			{ success: true, channel: 'telegram', symbol: 'BTCUSDT' },
			{ success: true, channel: 'discord', symbol: 'NVDA' },
		]);
		expect(notificationManager.sendToAll).not.toHaveBeenCalled();
	});

	it('uses global channels for symbols without a route', async () => {
		const notificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram', 'whatsapp']),
			sendToChannels: jest.fn().mockResolvedValue([{ success: true, channel: 'telegram' }]),
			sendToAll: jest.fn().mockResolvedValue([{ success: true, channel: 'whatsapp' }]),
		};

		const routing = parseNotificationRouting({
			channels: ['whatsapp'],
			symbolRoutes: { BTCUSDT: { channels: ['telegram'] } },
		});

		await sendWithNotificationRouting(
			notificationManager,
			{ text: 'BTCUSDT and ETHUSDT momentum update' },
			routing,
		);

		expect(notificationManager.sendToChannels).toHaveBeenCalledWith(
			expect.objectContaining({ symbol: 'BTCUSDT' }),
			['telegram'],
			expect.any(Object),
		);
		expect(notificationManager.sendToChannels).toHaveBeenCalledWith(
			expect.objectContaining({ symbol: 'ETHUSDT' }),
			['whatsapp'],
			expect.any(Object),
		);
	});
});
