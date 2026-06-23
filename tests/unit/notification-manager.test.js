const NotificationManager = require('../../src/services/notification/NotificationManager');

describe('NotificationManager admin failure notifications', () => {
	const originalAdminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;

	afterEach(() => {
		jest.restoreAllMocks();
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
});
