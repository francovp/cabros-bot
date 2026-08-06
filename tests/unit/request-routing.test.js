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
