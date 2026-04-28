/**
 * tests/integration/config-validation.test.js
 * Integration tests for environment variable configuration validation
 */

const TelegramService = require('../../src/services/notification/TelegramService');
const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const NotificationManager = require('../../src/services/notification/NotificationManager');

describe('Configuration Validation', () => {
	let mockBot;

	beforeEach(() => {
		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'tg-123' }),
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		// Reset env vars
		delete process.env.ENABLE_WHATSAPP_ALERTS;
		process.env.BOT_TOKEN = 'test-bot-token';
		process.env.TELEGRAM_CHAT_ID = '-1001234567890';
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('WhatsApp disabled by default', () => {
		it('should disable WhatsApp when ENABLE_WHATSAPP_ALERTS is not true', async () => {
			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();
			const notificationManager = new NotificationManager(telegramService, whatsappService);

			await notificationManager.validateAll();

			const enabledChannels = notificationManager.getEnabledChannels();
			expect(enabledChannels).toContain('telegram');
			expect(enabledChannels).not.toContain('whatsapp');
		});

		it('should allow app to start with only Telegram configured', async () => {
			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();
			const notificationManager = new NotificationManager(telegramService, whatsappService);

			// Should not throw
			await expect(notificationManager.validateAll()).resolves.not.toThrow();
		});
	});

	describe('WhatsApp configuration validation', () => {
		it('should enable WhatsApp when all env vars are set', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/';
			process.env.WHATSAPP_API_KEY = 'test-key';
			process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';

			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();

			await telegramService.validate();
			const result = await whatsappService.validate();

			expect(result.valid).toBe(true);
			expect(whatsappService.isEnabled()).toBe(true);
		});

		it('should warn if config incomplete (missing WHATSAPP_API_KEY)', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/';
			process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';
			delete process.env.WHATSAPP_API_KEY;

			const whatsappService = new WhatsAppService();
			const result = await whatsappService.validate();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('Missing');
		});

		it('should not crash app if WhatsApp config incomplete', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/';
			delete process.env.WHATSAPP_API_KEY;
			process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';

			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();
			const notificationManager = new NotificationManager(telegramService, whatsappService);

			// Should not throw
			await expect(notificationManager.validateAll()).resolves.not.toThrow();

			// Telegram should still be enabled
			const enabledChannels = notificationManager.getEnabledChannels();
			expect(enabledChannels).toContain('telegram');
		});
	});

	describe('graceful degradation', () => {
		it('should work with only Telegram (no WhatsApp config)', async () => {
			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();
			const notificationManager = new NotificationManager(telegramService, whatsappService);

			await notificationManager.validateAll();

			global.fetch = jest.fn(); // Mock fetch (shouldn't be called)

			const results = await notificationManager.sendToAll({ text: 'Alert' });

			expect(results.length).toBe(1); // Only Telegram
			expect(results[0].channel).toBe('telegram');
			expect(global.fetch).not.toHaveBeenCalled(); // WhatsApp shouldn't try to send
		});

		it('should warn if no channels are enabled', async () => {
			process.env.BOT_TOKEN = undefined; // Telegram will fail validation

			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();
			const notificationManager = new NotificationManager(telegramService, whatsappService);

			// Validate (Telegram will fail, WhatsApp is disabled)
			await notificationManager.validateAll();

			const enabledChannels = notificationManager.getEnabledChannels();
			expect(enabledChannels.length).toBe(0);
		});
	});

	describe('backward compatibility', () => {
		it('should preserve existing Telegram-only behavior', async () => {
			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();
			const notificationManager = new NotificationManager(telegramService, whatsappService);

			await notificationManager.validateAll();

			const results = await notificationManager.sendToAll({ text: 'Legacy alert' });

			expect(results).toHaveLength(1);
			expect(results[0].channel).toBe('telegram');
			expect(mockBot.telegram.sendMessage).toHaveBeenCalled();
		});

		it('should not break existing deployments without WhatsApp', async () => {
			const telegramService = new TelegramService({ bot: mockBot });
			const whatsappService = new WhatsAppService();
			const notificationManager = new NotificationManager(telegramService, whatsappService);

			// Simulate existing deployment (only Telegram configured)
			await notificationManager.validateAll();

			// Should still work
			const enabledChannels = notificationManager.getEnabledChannels();
			expect(enabledChannels).toContain('telegram');

			// WhatsApp should be disabled, not crash
			expect(whatsappService.isEnabled()).toBe(false);
		});
	});
});
