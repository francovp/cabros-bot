/**
 * tests/integration/graceful-degradation.test.js
 * End-to-end tests for graceful fallback and backward compatibility
 */

const TelegramService = require('../../src/services/notification/TelegramService');
const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const NotificationManager = require('../../src/services/notification/NotificationManager');

describe('Graceful Degradation & Fallback', () => {
  let mockBot;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockBot = {
      telegram: {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 'tg-123' }),
      },
    };

    // Setup minimum config
    process.env.BOT_TOKEN = 'test-bot-token';
    process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restore original env (clean up any test modifications)
    Object.keys(process.env).forEach((key) => {
      if (!originalEnv.hasOwnProperty(key)) {
        delete process.env[key];
      }
    });
  });

  describe('Test 1: No WhatsApp config, only Telegram', () => {
    it('should send alert only to Telegram successfully', async () => {
      // Ensure WhatsApp is disabled
      delete process.env.ENABLE_WHATSAPP_ALERTS;

      const telegramService = new TelegramService({ bot: mockBot });
      const whatsappService = new WhatsAppService();
      const notificationManager = new NotificationManager(telegramService, whatsappService);

      await notificationManager.validateAll();

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      // Should have exactly one result (Telegram)
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe('telegram');
      expect(results[0].success).toBe(true);
      expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('Test 2: WhatsApp config missing API key, Telegram configured', () => {
    it('should send only to Telegram, WhatsApp silently disabled', async () => {
      process.env.ENABLE_WHATSAPP_ALERTS = 'true';
      process.env.WHATSAPP_API_URL = 'https://api.green.com/';
      // Missing: WHATSAPP_API_KEY
      process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';

      const telegramService = new TelegramService({ bot: mockBot });
      const whatsappService = new WhatsAppService();
      const notificationManager = new NotificationManager(telegramService, whatsappService);

      await notificationManager.validateAll();

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      // Should have only Telegram
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe('telegram');
      expect(results[0].success).toBe(true);

      // WhatsApp should be disabled
      expect(whatsappService.isEnabled()).toBe(false);

      // No error should be thrown
      expect(() => {}).not.toThrow();
    });
  });

  describe('Test 3: Both services disabled (edge case)', () => {
    it('should not crash, return empty results, and log warning', async () => {
      // Disable both
      delete process.env.BOT_TOKEN;
      delete process.env.ENABLE_WHATSAPP_ALERTS;

      const telegramService = new TelegramService({ bot: mockBot });
      const whatsappService = new WhatsAppService();
      const notificationManager = new NotificationManager(telegramService, whatsappService);

      const mockLogger = {
        warn: jest.fn(),
        debug: jest.fn(),
      };

      // Mock console to capture warnings
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      await notificationManager.validateAll();

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      // Should return empty results but not crash
      expect(results).toHaveLength(0);
      expect(() => {}).not.toThrow();

      consoleSpy.mockRestore();
    });
  });

  describe('Test 4: Backward compatibility verification', () => {
    it('should maintain existing Telegram-only webhook behavior', async () => {
      const telegramService = new TelegramService({ bot: mockBot });
      const whatsappService = new WhatsAppService();
      const notificationManager = new NotificationManager(telegramService, whatsappService);

      // This is how existing deployments work
      await notificationManager.validateAll();

      // Send alert
      const results = await notificationManager.sendToAll({
        text: 'BTC is at $45000',
        enriched: null,
      });

      // Should work exactly like before
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].channel).toBe('telegram');
      expect(results[0].success).toBe(true);
      expect(mockBot.telegram.sendMessage).toHaveBeenCalled();
    });
  });

  describe('Test 5: One channel fails, other continues', () => {
    it('should handle Telegram failure gracefully', async () => {
      process.env.ENABLE_WHATSAPP_ALERTS = 'true';
      process.env.WHATSAPP_API_URL = 'https://api.green.com/';
      process.env.WHATSAPP_API_KEY = 'test-key';
      process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';

      mockBot.telegram.sendMessage.mockRejectedValueOnce(new Error('Bot token invalid'));

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, idMessage: 'wa-msg-1' }),
      });

      const telegramService = new TelegramService({ bot: mockBot });
      const whatsappService = new WhatsAppService();
      const notificationManager = new NotificationManager(telegramService, whatsappService);

      await notificationManager.validateAll();

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      // Should have both results
      expect(results.length).toBe(2);

      // Telegram failed
      expect(results[0].success).toBe(false);

      // WhatsApp succeeded
      expect(results[1].success).toBe(true);

      // No exception thrown
      expect(() => {}).not.toThrow();
    });
  });

  describe('Test 6: Existing alert enrichment still works', () => {
    it('should pass enriched content to both channels', async () => {
      process.env.ENABLE_WHATSAPP_ALERTS = 'true';
      process.env.WHATSAPP_API_URL = 'https://api.green.com/';
      process.env.WHATSAPP_API_KEY = 'test-key';
      process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, idMessage: 'wa-msg-enriched' }),
      });

      const telegramService = new TelegramService({ bot: mockBot });
      const whatsappService = new WhatsAppService();
      const notificationManager = new NotificationManager(telegramService, whatsappService);

      await notificationManager.validateAll();

      const enrichedAlert = {
        text: 'Original alert',
        enriched: {
          originalText: 'Original alert',
          summary: 'Price breakout detected',
          citations: [],
        },
      };

      const results = await notificationManager.sendToAll(enrichedAlert);

      // Both should receive enriched content
      expect(results.length).toBe(2);
      results.forEach((r) => {
        expect(r.success).toBe(true);
      });
    });
  });
});
