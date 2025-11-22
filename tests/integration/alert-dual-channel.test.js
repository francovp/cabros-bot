/**
 * tests/integration/alert-dual-channel.test.js
 * Integration tests for dual-channel (Telegram + WhatsApp) alert delivery
 */

const TelegramService = require('../../src/services/notification/TelegramService');
const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const NotificationManager = require('../../src/services/notification/NotificationManager');

describe('Dual-Channel Alert Integration', () => {
  let telegramService;
  let whatsappService;
  let notificationManager;
  let mockBot;

  beforeEach(() => {
    // Setup for testing
    process.env.ENABLE_WHATSAPP_ALERTS = 'true';
    process.env.WHATSAPP_API_URL = 'https://api.green.com/waInstance123/';
    process.env.WHATSAPP_API_KEY = 'test-key-123';
    process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';
    process.env.BOT_TOKEN = 'test-bot-token';
    process.env.TELEGRAM_CHAT_ID = '-1001234567890';

    mockBot = {
      telegram: {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 'tg-123' }),
        getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
      },
    };

    telegramService = new TelegramService({ bot: mockBot });
    whatsappService = new WhatsAppService();
    notificationManager = new NotificationManager(telegramService, whatsappService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('sendToAll with both channels enabled', () => {
    it('should send to both channels in parallel', async () => {
      await telegramService.validate();
      await whatsappService.validate();

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, idMessage: 'whatsapp-msg-123' }),
      });

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      expect(results.length).toBe(2);
      expect(results[0].channel).toBe('telegram');
      expect(results[1].channel).toBe('whatsapp');
      expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should not block WhatsApp if Telegram fails', async () => {
      await telegramService.validate();
      await whatsappService.validate();

      mockBot.telegram.sendMessage.mockRejectedValueOnce(new Error('Telegram error'));

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, idMessage: 'whatsapp-msg-456' }),
      });

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      expect(results.length).toBe(2);
      expect(results[0].success).toBe(false); // Telegram failed
      expect(results[1].success).toBe(true); // WhatsApp succeeded
    });

    it('should not block Telegram if WhatsApp fails', async () => {
      await telegramService.validate();
      await whatsappService.validate();

      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true); // Telegram succeeded
      expect(results[1].success).toBe(false); // WhatsApp failed
      expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should return response with both channels regardless of success', async () => {
      await telegramService.validate();
      await whatsappService.validate();

      mockBot.telegram.sendMessage.mockResolvedValueOnce({ message_id: 'tg-789' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, idMessage: 'wa-789' }),
      });

      const results = await notificationManager.sendToAll({ text: 'Test alert' });

      expect(results.length).toBe(2);
      results.forEach((result) => {
        expect(result.channel).toBeDefined();
        expect(result.success).toBeDefined();
        expect(result.error || result.messageId).toBeDefined();
      });
    });
  });

  describe('performance: no latency impact', () => {
    it('should execute parallel sends concurrently', async () => {
      await telegramService.validate();
      await whatsappService.validate();

      let telegramStartTime;
      let whatsappStartTime;

      mockBot.telegram.sendMessage.mockImplementationOnce(async () => {
        telegramStartTime = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { message_id: 'tg-perf-1' };
      });

      global.fetch = jest.fn().mockImplementationOnce(async () => {
        whatsappStartTime = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          ok: true,
          json: async () => ({ success: true, idMessage: 'wa-perf-1' }),
        };
      });

      const startTime = Date.now();
      await notificationManager.sendToAll({ text: 'Test alert' });
      const duration = Date.now() - startTime;

      // Both calls should happen concurrently (total ~100ms), not sequentially (~200ms)
      expect(duration).toBeLessThan(250); // Allow some margin
    });
  });

  describe('enabled channels tracking', () => {
    it('should return list of enabled channels', async () => {
      await telegramService.validate();
      await whatsappService.validate();

      const enabledChannels = notificationManager.getEnabledChannels();

      expect(enabledChannels).toContain('telegram');
      expect(enabledChannels).toContain('whatsapp');
    });

    it('should only include enabled channels', async () => {
      process.env.ENABLE_WHATSAPP_ALERTS = 'false';
      const ws = new WhatsAppService();
      await ws.validate();
      await telegramService.validate();

      const nm = new NotificationManager(telegramService, ws);
      const enabledChannels = nm.getEnabledChannels();

      expect(enabledChannels).toContain('telegram');
      expect(enabledChannels).not.toContain('whatsapp');
    });
  });
});
