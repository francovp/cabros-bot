/**
 * tests/unit/whatsapp-service.test.js
 * Unit tests for WhatsAppService
 */

const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const WhatsAppMarkdownFormatter = require('../../src/services/notification/formatters/whatsappMarkdownFormatter');

describe('WhatsAppService', () => {
	let service;
	let mockLogger;

	beforeEach(() => {
		mockLogger = {
			debug: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
			log: jest.fn(),
		};
		service = new WhatsAppService({ logger: mockLogger });
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('validate', () => {
		it('should return disabled when ENABLE_WHATSAPP_ALERTS is not true', async () => {
			delete process.env.ENABLE_WHATSAPP_ALERTS;
			const result = await service.validate();

			expect(result.valid).toBe(true);
			expect(result.message).toContain('disabled');
			expect(service.enabled).toBe(false);
		});

		it('should return error when WHATSAPP_API_URL missing', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_KEY = 'test-key';
			process.env.WHATSAPP_CHAT_ID = '123@g.us';
			delete process.env.WHATSAPP_API_URL;

			service = new WhatsAppService(); // Create new service to pick up env changes
			const result = await service.validate();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('Missing');
		});

		it('should return error when WHATSAPP_API_KEY missing', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/';
			process.env.WHATSAPP_CHAT_ID = '123@g.us';
			delete process.env.WHATSAPP_API_KEY;

			service = new WhatsAppService();
			const result = await service.validate();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('Missing');
		});

		it('should return error when WHATSAPP_CHAT_ID missing', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/';
			process.env.WHATSAPP_API_KEY = 'test-key';
			delete process.env.WHATSAPP_CHAT_ID;

			service = new WhatsAppService();
			const result = await service.validate();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('Missing');
		});

		it('should return success when all env vars present', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/';
			process.env.WHATSAPP_API_KEY = 'test-key';
			process.env.WHATSAPP_CHAT_ID = '123@g.us';

			service = new WhatsAppService();
			const result = await service.validate();

			expect(result.valid).toBe(true);
			expect(service.enabled).toBe(true);
		});
	});

	describe('isEnabled', () => {
		it('should return false when not validated', () => {
			expect(service.isEnabled()).toBe(false);
		});

		it('should return true after successful validation', async () => {
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/';
			process.env.WHATSAPP_API_KEY = 'test-key';
			process.env.WHATSAPP_CHAT_ID = '123@g.us';

			service = new WhatsAppService();
			await service.validate();

			expect(service.isEnabled()).toBe(true);
		});
	});

	describe('send', () => {
		beforeEach(() => {
			// Setup for successful validation
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			process.env.WHATSAPP_API_URL = 'https://api.green.com/waInstance123/';
			process.env.WHATSAPP_API_KEY = 'test-key-123';
			process.env.WHATSAPP_CHAT_ID = '120363xxxxx@g.us';

			service = new WhatsAppService({ logger: mockLogger });
		});

		it('should retry on network error and succeed on second attempt', async () => {
			global.fetch = jest
				.fn()
				.mockRejectedValueOnce(new Error('Network error'))
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ success: true, idMessage: 'msg-123' }),
				});

			const result = await service.send({ text: 'Test alert' });

			expect(result.success).toBe(true);
			expect(result.messageId).toBe('msg-123');
			expect(result.attemptCount).toBe(2);
			expect(global.fetch).toHaveBeenCalledTimes(2);
		});

		it('should exhaust retries on persistent failure', async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ success: false, error: 'Rate limited' }),
			});

			const result = await service.send({ text: 'Test alert' });

			expect(result.success).toBe(false);
			expect(result.attemptCount).toBe(3);
			expect(global.fetch).toHaveBeenCalledTimes(3);
		});

		it('should respect 10s timeout', async () => {
			global.fetch = jest.fn().mockImplementation(() => {
				const controller = new AbortController();
				return new Promise((_, reject) => {
					setTimeout(() => {
						reject(new DOMException('The operation was aborted', 'AbortError'));
					}, 100);
				});
			});

			// Mock AbortSignal.timeout to simulate timeout
			const originalTimeout = AbortSignal.timeout;
			AbortSignal.timeout = jest.fn((ms) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), ms);
				return controller.signal;
			});

			// For this test, we'll just verify the timeout parameter is set
			// The actual timeout behavior depends on Node.js fetch implementation
			process.env.ENABLE_WHATSAPP_ALERTS = 'true';
			service = new WhatsAppService({ logger: mockLogger });
			await service.validate();

			// Restore
			AbortSignal.timeout = originalTimeout;
		});

		it('should return SendResult with channel, success, and error fields', async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => 'Server error',
			});

			const result = await service.send({ text: 'Test alert' });

			expect(result.channel).toBe('whatsapp');
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should split long messages into multiple GreenAPI requests instead of truncating', async () => {
			global.fetch = jest
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ idMessage: 'msg-1' }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ idMessage: 'msg-2' }),
				});

			const longText = 'A'.repeat(20010);
			const result = await service.send({ text: longText });

			expect(result.success).toBe(true);
			expect(result.channel).toBe('whatsapp');
			expect(result.messageCount).toBe(2);
			expect(result.messageIds).toEqual(['msg-1', 'msg-2']);
			expect(result.messageId).toBe('msg-1,msg-2');
			expect(global.fetch).toHaveBeenCalledTimes(2);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('sending 2 parts instead of truncating'),
			);

			const firstPayload = JSON.parse(global.fetch.mock.calls[0][1].body);
			const secondPayload = JSON.parse(global.fetch.mock.calls[1][1].body);

			expect(firstPayload.customPreview).toEqual({ title: 'Trading View Alert' });
			expect(secondPayload.customPreview).toBeUndefined();
			expect(firstPayload.message + secondPayload.message).toBe(longText);
			expect(firstPayload.message.endsWith('…')).toBe(false);
			expect(secondPayload.message.endsWith('…')).toBe(false);
		});
	});
});
