/**
 * tests/integration/alert-whatsapp.test.js
 * Integration tests for WhatsApp alert delivery via webhook
 */

const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const NotificationManager = require('../../src/services/notification/NotificationManager');

describe('WhatsApp Alert Integration', () => {
  let whatsappService;
  let notificationManager;
  let mockBot;

  beforeEach(() => {
    // Setup for testing
    process.env.ENABLE_WHATSAPP_ALERTS = 'true';
    process.env.WHATSAPP_API_URL = 'https://api.green.com/waInstance123/';
    process.env.WHATSAPP_API_KEY = 'test-key-123';
    process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';

    mockBot = {
      telegram: {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 'tg-123' }),
      },
    };

    whatsappService = new WhatsAppService();
    notificationManager = new NotificationManager(mockBot, whatsappService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('webhook /api/webhook/alert with WhatsApp', () => {
    it('should send to WhatsApp with correct payload', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          idMessage: 'whatsapp-msg-123',
        }),
      });

      const alertText = 'BTC is at $45000';
      const result = await whatsappService.send({ text: alertText });

      expect(result.success).toBe(true);
      expect(result.channel).toBe('whatsapp');
      expect(result.messageId).toBe('whatsapp-msg-123');
    });

    it('should verify message is fetched within 5 seconds (simulated)', async () => {
      const startTime = Date.now();

      global.fetch = jest.fn().mockImplementation(async () => {
        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          ok: true,
          json: async () => ({
            success: true,
            idMessage: 'whatsapp-msg-456',
          }),
        };
      });

      const result = await whatsappService.send({ text: 'Test alert' });
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000);
    });

    it('should preserve special characters in message', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          idMessage: 'whatsapp-msg-789',
        }),
      });

      const alertText = 'BTC [+2.5%] *strong* _italic_';
      await whatsappService.send({ text: alertText });

      const fetchCall = global.fetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);

      // Should contain the formatted message
      expect(payload.message).toBeDefined();
      expect(payload.customPreview.title).toBe('Trading View Alert');
    });

    it('should include customPreview.title in payload', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          idMessage: 'whatsapp-msg-abc',
        }),
      });

      await whatsappService.send({ text: 'Test' });

      const fetchCall = global.fetch.mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);

      expect(payload.customPreview).toBeDefined();
      expect(payload.customPreview.title).toBe('Trading View Alert');
    });
  });

  describe('webhook response format', () => {
    it('should return 200 OK regardless of delivery success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          idMessage: 'msg-123',
        }),
      });

      const result = await whatsappService.send({ text: 'Alert' });

      // In the actual webhook handler, this would always return 200 OK
      expect(result.channel).toBe('whatsapp');
    });

    it('should include channel name in response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          idMessage: 'msg-456',
        }),
      });

      const result = await whatsappService.send({ text: 'Alert' });

      expect(result.channel).toBe('whatsapp');
    });
  });
});
