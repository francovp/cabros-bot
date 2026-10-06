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

		test('pollIntervalMs defaults to 3000 when env var is unset', () => {
			delete process.env.WHATSAPP_COMMAND_POLL_INTERVAL_MS;
			const service = new WhatsAppCommandBridgeService();
			expect(service.pollIntervalMs).toBe(3000);
		});

		test('pollIntervalMs reads from WHATSAPP_COMMAND_POLL_INTERVAL_MS env var', () => {
			process.env.WHATSAPP_COMMAND_POLL_INTERVAL_MS = '5000';
			const service = new WhatsAppCommandBridgeService();
			expect(service.pollIntervalMs).toBe(5000);
		});

		test('pollIntervalMs prefers constructor option over env var', () => {
			process.env.WHATSAPP_COMMAND_POLL_INTERVAL_MS = '5000';
			const service = new WhatsAppCommandBridgeService({ pollIntervalMs: 1500 });
			expect(service.pollIntervalMs).toBe(1500);
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

	describe('Bounded per-step deadlines and duplicate suppression', () => {
		const notificationPayload = (receiptId, text = '!precio BTCUSDT') => ({
			receiptId,
			body: {
				typeWebhook: 'incomingMessageReceived',
				senderData: { chatId: '120363000000000000@g.us' },
				messageData: { textMessageData: { textMessage: text } },
			},
		});

		test('deletes the receipt with its own budget when handling outlasts the receive timeout', async () => {
			const mockFetch = jest.fn().mockImplementation(async (url) => {
				if (url.includes('/receiveNotification/')) {
					return { ok: true, status: 200, json: async () => notificationPayload(4242) };
				}
				return { ok: true, status: 200, json: async () => ({ result: true }) };
			});

			const mockPriceResolver = jest.fn().mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve({ message: 'Precio de BTCUSDT es 65000' }), 120)),
			);

			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({
				whatsAppService: mockWhatsApp,
				priceResolver: mockPriceResolver,
				fetchFn: mockFetch,
				receiveTimeoutMs: 20,
				deleteTimeoutMs: 500,
			});

			const result = await service.pollOnce();

			expect(result.processed).toBe(true);
			expect(result.deleted).toBe(true);
			expect(mockPriceResolver).toHaveBeenCalledTimes(1);
			const deleteCalls = mockFetch.mock.calls.filter((c) => c[0].includes('/deleteNotification/'));
			expect(deleteCalls).toHaveLength(1);
			expect(deleteCalls[0][0]).toContain('/4242');
		});

		test('retries a failed delete and executes the command exactly once', async () => {
			let deleteAttempts = 0;
			const mockFetch = jest.fn().mockImplementation(async (url) => {
				if (url.includes('/receiveNotification/')) {
					return { ok: true, status: 200, json: async () => notificationPayload(5252) };
				}
				deleteAttempts += 1;
				if (deleteAttempts === 1) {
					return { ok: false, status: 500, text: async () => 'Internal Server Error' };
				}
				return { ok: true, status: 200, json: async () => ({ result: true }) };
			});

			const mockPriceResolver = jest.fn().mockResolvedValue({ message: 'Precio de BTCUSDT es 65000' });
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({
				whatsAppService: mockWhatsApp,
				priceResolver: mockPriceResolver,
				fetchFn: mockFetch,
			});

			const result = await service.pollOnce();

			expect(result.processed).toBe(true);
			expect(result.deleted).toBe(true);
			expect(deleteAttempts).toBe(2);
			expect(mockPriceResolver).toHaveBeenCalledTimes(1);
			expect(mockWhatsApp.send).toHaveBeenCalledTimes(1);
		});

		test('does not retry a non-retryable delete failure', async () => {
			let deleteAttempts = 0;
			const mockFetch = jest.fn().mockImplementation(async (url) => {
				if (url.includes('/receiveNotification/')) {
					return { ok: true, status: 200, json: async () => notificationPayload(6161) };
				}
				deleteAttempts += 1;
				return { ok: false, status: 400, text: async () => 'Bad Request' };
			});

			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({ whatsAppService: mockWhatsApp, fetchFn: mockFetch });

			const result = await service.pollOnce();

			expect(result.processed).toBe(true);
			expect(result.deleted).toBe(false);
			expect(deleteAttempts).toBe(1);
			expect(service.getStatus().deleteFailureCount).toBe(1);
		});

		test('skips a redelivered receiptId after both steps time out, without re-executing', async () => {
			const receipt = notificationPayload(7070);
			let deleteCalls = 0;

			const mockFetch = jest.fn().mockImplementation((url, options = {}) => {
				if (url.includes('/receiveNotification/')) {
					return Promise.resolve({ ok: true, status: 200, json: async () => receipt });
				}
				deleteCalls += 1;
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener('abort', () => {
						const err = new Error('aborted');
						err.name = 'AbortError';
						reject(err);
					});
				});
			});

			const mockPriceResolver = jest.fn().mockResolvedValue({ message: 'Precio de BTCUSDT es 65000' });
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const service = new WhatsAppCommandBridgeService({
				whatsAppService: mockWhatsApp,
				priceResolver: mockPriceResolver,
				fetchFn: mockFetch,
				deleteTimeoutMs: 10,
				deleteMaxAttempts: 1,
			});

			const first = await service.pollOnce();
			expect(first.processed).toBe(true);
			expect(first.deleted).toBe(false);
			expect(mockPriceResolver).toHaveBeenCalledTimes(1);

			const second = await service.pollOnce();
			expect(second.processed).toBe(true);
			expect(second.duplicate).toBe(true);
			expect(second.handlingResult.action).toBe('skipped_duplicate');
			expect(mockPriceResolver).toHaveBeenCalledTimes(1);
			expect(mockWhatsApp.send).toHaveBeenCalledTimes(1);
			expect(deleteCalls).toBeGreaterThanOrEqual(2);
			expect(service.getStatus().duplicateSkippedCount).toBe(1);
		});

		test('expires seen receipts after the TTL window', () => {
			const service = new WhatsAppCommandBridgeService({ seenReceiptTtlMs: 1 });
			service._markReceiptSeen(8080);
			expect(service._isSeenReceipt(8080)).toBe(true);
			jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 50);
			expect(service._isSeenReceipt(8080)).toBe(false);
		});

		test('bounds the seen receipt map', () => {
			const service = new WhatsAppCommandBridgeService({ seenReceiptMaxEntries: 3 });
			[1, 2, 3, 4, 5].forEach((id) => service._markReceiptSeen(id));
			expect(service.seenReceiptMap.size).toBe(3);
			expect(service._isSeenReceipt(1)).toBe(false);
			expect(service._isSeenReceipt(5)).toBe(true);
		});

		test('stop() aborts an in-flight poll fetch', async () => {
			let aborted = false;
			const mockFetch = jest.fn().mockImplementation((_url, options = {}) => {
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener('abort', () => {
						aborted = true;
						const err = new Error('aborted');
						err.name = 'AbortError';
						reject(err);
					});
				});
			});

			const service = new WhatsAppCommandBridgeService({
				fetchFn: mockFetch,
				receiveTimeoutMs: 5000,
			});
			service.start();

			const pollPromise = service.pollOnce();
			await new Promise((resolve) => setImmediate(resolve));
			await service.stop({ timeoutMs: 1000 });
			const result = await pollPromise;

			expect(aborted).toBe(true);
			expect(result.timeout).toBe(true);
		});

		test('suppresses a pending command reply once stop() was requested', async () => {
			let releasePrice;
			const mockPriceResolver = jest.fn().mockImplementation(
				() => new Promise((resolve) => { releasePrice = () => resolve({ message: 'Precio de BTCUSDT es 65000' }); }),
			);
			const mockWhatsApp = { send: jest.fn().mockResolvedValue({ success: true }) };
			const mockFetch = jest.fn().mockImplementation(async (url) => {
				if (url.includes('/receiveNotification/')) {
					return { ok: true, status: 200, json: async () => notificationPayload(9090) };
				}
				return { ok: true, status: 200, json: async () => ({ result: true }) };
			});

			const service = new WhatsAppCommandBridgeService({
				whatsAppService: mockWhatsApp,
				priceResolver: mockPriceResolver,
				fetchFn: mockFetch,
			});
			service.start();

			const pollPromise = service.pollOnce();
			await new Promise((resolve) => setImmediate(resolve));
			await service.stop({ timeoutMs: 50 });
			releasePrice();

			const result = await pollPromise;
			expect(result.processed).toBe(true);
			expect(mockWhatsApp.send).not.toHaveBeenCalled();
		});
	});
});
