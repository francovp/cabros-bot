'use strict';

const WhatsAppCommandBridgeService = require('../../src/services/notification/WhatsAppCommandBridgeService');

describe('WhatsAppCommandBridgeService', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		process.env.ENABLE_WHATSAPP_COMMANDS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.green-api.com/waInstance123456/sendMessage/';
		process.env.WHATSAPP_API_KEY = 'secret-api-token';
		process.env.WHATSAPP_COMMAND_CHAT_IDS = '120363000000000000@g.us, 120363111111111111@g.us';
	});

	afterEach(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
	});

	describe('Configuration and Allowlist', () => {
		test('is disabled by default when ENABLE_WHATSAPP_COMMANDS is not set', () => {
			delete process.env.ENABLE_WHATSAPP_COMMANDS;
			const service = new WhatsAppCommandBridgeService();
			expect(service.isEnabled()).toBe(false);
			expect(service.getStatus().status).toBe('disabled');
		});

		test('is configured when apiUrl, apiKey, and allowlisted chat IDs are set', () => {
			const service = new WhatsAppCommandBridgeService();
			expect(service.isEnabled()).toBe(true);
			expect(service.isConfigured()).toBe(true);
			expect(service.getAllowlistedChatIds()).toEqual(['120363000000000000@g.us', '120363111111111111@g.us']);
		});

		test('isChatAllowed returns true only for allowlisted chats', () => {
			const service = new WhatsAppCommandBridgeService();
			expect(service.isChatAllowed('120363000000000000@g.us')).toBe(true);
			expect(service.isChatAllowed('120363111111111111@g.us')).toBe(true);
			expect(service.isChatAllowed('120363999999999999@g.us')).toBe(false);
			expect(service.isChatAllowed(null)).toBe(false);
		});

		test('derives base instance URL from sendMessage URL', () => {
			const service = new WhatsAppCommandBridgeService({
				apiUrl: 'https://api.green-api.com/waInstance123456/sendMessage/',
			});
			expect(service.getBaseUrl()).toBe('https://api.green-api.com/waInstance123456/');
		});
	});

	describe('Command Handling', () => {
		test('ignores non-incomingMessageReceived webhook types', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({ whatsAppService: mockWhatsApp });

			const notification = {
				receiptId: 101,
				body: {
					typeWebhook: 'outgoingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: '!precio BTCUSDT' } },
				},
			};

			const handled = await service.handleNotification(notification);
			expect(handled.action).toBe('ignored');
			expect(handled.reason).toBe('unsupported_webhook_type');
			expect(mockWhatsApp.send).not.toHaveBeenCalled();
		});

		test('ignores messages from non-allowlisted chats', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({ whatsAppService: mockWhatsApp });

			const notification = {
				receiptId: 102,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: 'unknown-chat@g.us' },
					messageData: { textMessageData: { textMessage: '!precio BTCUSDT' } },
				},
			};

			const handled = await service.handleNotification(notification);
			expect(handled.action).toBe('ignored');
			expect(handled.reason).toBe('chat_not_allowlisted');
			expect(mockWhatsApp.send).not.toHaveBeenCalled();
		});

		test('ignores messages that do not start with !', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({ whatsAppService: mockWhatsApp });

			const notification = {
				receiptId: 103,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: 'hola amigos como va el btc' } },
				},
			};

			const handled = await service.handleNotification(notification);
			expect(handled.action).toBe('ignored');
			expect(handled.reason).toBe('not_a_command');
			expect(mockWhatsApp.send).not.toHaveBeenCalled();
		});

		test('executes !precio BTCUSDT and replies via WhatsAppService', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }) };
			const mockPriceResolver = jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				price: 65000,
				message: 'Precio de BTCUSDT es 65000',
			});

			const service = new WhatsAppCommandBridgeService({
				whatsAppService: mockWhatsApp,
				priceResolver: mockPriceResolver,
			});

			const notification = {
				receiptId: 104,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: '!precio BTCUSDT' } },
				},
			};

			const handled = await service.handleNotification(notification);
			expect(handled.action).toBe('executed');
			expect(handled.command).toBe('precio');
			expect(mockPriceResolver).toHaveBeenCalled();
			expect(mockWhatsApp.send).toHaveBeenCalledWith(
				expect.objectContaining({
					text: 'Precio de BTCUSDT es 65000',
					whatsappChatId: '120363000000000000@g.us',
				}),
			);
		});

		test('replies with usage guidance when !precio is missing symbol', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({ whatsAppService: mockWhatsApp });

			const notification = {
				receiptId: 105,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: '!precio' } },
				},
			};

			const handled = await service.handleNotification(notification);
			expect(handled.action).toBe('executed');
			expect(mockWhatsApp.send).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining('Por favor indica un símbolo'),
					whatsappChatId: '120363000000000000@g.us',
				}),
			);
		});

		test('executes !help and replies with available commands', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({ whatsAppService: mockWhatsApp });

			const notification = {
				receiptId: 106,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: '!help' } },
				},
			};

			const handled = await service.handleNotification(notification);
			expect(handled.action).toBe('executed');
			expect(handled.command).toBe('help');
			expect(mockWhatsApp.send).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining('!precio <simbolo>'),
					whatsappChatId: '120363000000000000@g.us',
				}),
			);
		});

		test('handles unknown command with hint and enforces cooldown', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({ whatsAppService: mockWhatsApp });

			const notification1 = {
				receiptId: 107,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: '!invalidcmd' } },
				},
			};

			const handled1 = await service.handleNotification(notification1);
			expect(handled1.action).toBe('unknown_command_hint');
			expect(mockWhatsApp.send).toHaveBeenCalledTimes(1);

			// Second unknown command immediately afterwards should be throttled
			const notification2 = {
				receiptId: 108,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: '!anotherinvalid' } },
				},
			};

			const handled2 = await service.handleNotification(notification2);
			expect(handled2.action).toBe('unknown_command_throttled');
			expect(mockWhatsApp.send).toHaveBeenCalledTimes(1);
		});

		test('rate limits excessive command calls per chat', async () => {
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const mockPriceResolver = jest.fn().mockResolvedValue({ message: 'Precio de BTCUSDT es 65000' });
			const service = new WhatsAppCommandBridgeService({
				whatsAppService: mockWhatsApp,
				priceResolver: mockPriceResolver,
				maxCommandsPerMinute: 2,
			});

			const notification = (id) => ({
				receiptId: id,
				body: {
					typeWebhook: 'incomingMessageReceived',
					senderData: { chatId: '120363000000000000@g.us' },
					messageData: { textMessageData: { textMessage: '!precio BTCUSDT' } },
				},
			});

			const res1 = await service.handleNotification(notification(1));
			const res2 = await service.handleNotification(notification(2));
			const res3 = await service.handleNotification(notification(3));

			expect(res1.action).toBe('executed');
			expect(res2.action).toBe('executed');
			expect(res3.action).toBe('rate_limited');
			expect(mockWhatsApp.send).toHaveBeenCalledTimes(2);
		});
	});

	describe('Poller and Lifecycle', () => {
		test('pollCycle receives notification, processes it, and deletes receipt', async () => {
			const mockFetch = jest.fn();
			// 1st call: receiveNotification
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					receiptId: 999,
					body: {
						typeWebhook: 'incomingMessageReceived',
						senderData: { chatId: '120363000000000000@g.us' },
						messageData: { textMessageData: { textMessage: '!help' } },
					},
				}),
			});
			// 2nd call: deleteNotification
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ result: true }),
			});

			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({
				whatsAppService: mockWhatsApp,
				fetchFn: mockFetch,
			});

			const result = await service.pollOnce();
			expect(result.processed).toBe(true);
			expect(result.receiptId).toBe(999);
			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(mockFetch.mock.calls[0][0]).toContain('/receiveNotification/');
			expect(mockFetch.mock.calls[1][0]).toContain('/deleteNotification/');
			expect(mockFetch.mock.calls[1][0]).toContain('/999');
			expect(mockWhatsApp.send).toHaveBeenCalled();
		});

		test('handles empty queue in pollOnce cleanly', async () => {
			const mockFetch = jest.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => null,
			});

			const service = new WhatsAppCommandBridgeService({ fetchFn: mockFetch });
			const result = await service.pollOnce();
			expect(result.processed).toBe(false);
			expect(result.empty).toBe(true);
		});

		test('handles receiveNotification error fail-open without throwing', async () => {
			const mockFetch = jest.fn().mockResolvedValueOnce({
				ok: false,
				status: 500,
				text: async () => 'Internal Server Error',
			});

			const service = new WhatsAppCommandBridgeService({ fetchFn: mockFetch });
			const result = await service.pollOnce();
			expect(result.processed).toBe(false);
			expect(result.error).toContain('500');
		});

		test('start and stop manages worker lifecycle cleanly', async () => {
			const service = new WhatsAppCommandBridgeService();
			service.start();
			expect(service.isRunning()).toBe(true);

			await service.stop();
			expect(service.isRunning()).toBe(false);
		});
	});
});
