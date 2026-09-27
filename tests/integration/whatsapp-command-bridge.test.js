'use strict';

const request = require('supertest');
const express = require('express');
const { getRoutes } = require('../../src/routes');
const WhatsAppCommandBridgeService = require('../../src/services/notification/WhatsAppCommandBridgeService');

describe('WhatsApp Command Bridge Integration', () => {
	let originalEnv;
	let originalFetch;
	let app;

	beforeEach(() => {
		originalEnv = { ...process.env };
		originalFetch = global.fetch;
		process.env.ENABLE_WHATSAPP_COMMANDS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.green-api.com/waInstance7107356806/sendMessage/';
		process.env.WHATSAPP_API_KEY = 'mock-green-api-token';
		process.env.WHATSAPP_COMMAND_CHAT_IDS = '120363025492938@g.us,120363099999999@g.us';

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes());
	});

	afterEach(() => {
		process.env = originalEnv;
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	test('GET /api/status reflects whatsappCommands and whatsappCommandBridge state', async () => {
		const res = await request(app).get('/api/status');
		if (res.status !== 200) {
			console.error('Status endpoint error:', res.body);
		}
		expect(res.status).toBe(200);
		expect(res.body.featureFlags).toHaveProperty('whatsappCommands');
		expect(res.body.featureFlags.whatsappCommands).toBe(true);
		expect(res.body.dependencies).toHaveProperty('whatsappCommandBridge');
		expect(res.body.dependencies.whatsappCommandBridge).toMatchObject({
			enabled: true,
			configured: true,
			status: 'ready',
			allowlistedChatsCount: 2,
		});
	});

	test('processes !precio command end-to-end via GreenAPI polling flow', async () => {
		const mockCalls = [];
		const mockFetch = jest.fn().mockImplementation(async (url, options = {}) => {
			mockCalls.push({ url, options });

			if (url.includes('/receiveNotification/')) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						receiptId: 445566,
						body: {
							typeWebhook: 'incomingMessageReceived',
							instanceData: { idInstance: 7107356806 },
							senderData: {
								chatId: '120363025492938@g.us',
								sender: '56912345678@c.us',
								senderName: 'Test User',
							},
							messageData: {
								typeMessage: 'textMessage',
								textMessageData: {
									textMessage: '!precio BTCUSDT',
								},
							},
						},
					}),
				};
			}

			if (url.includes('/deleteNotification/')) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ result: true }),
				};
			}

			if (url.includes('/sendMessage/')) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ idMessage: 'green-msg-123' }),
				};
			}

			return { ok: true, status: 200, json: async () => ({}) };
		});
		global.fetch = mockFetch;

		const mockPriceResolver = jest.fn().mockResolvedValue({
			symbol: 'BTCUSDT',
			price: 68450.25,
			message: 'Precio de BTCUSDT en Binance: 68,450.25 USDT',
		});

		const bridge = new WhatsAppCommandBridgeService({
			fetchFn: mockFetch,
			priceResolver: mockPriceResolver,
		});

		const pollResult = await bridge.pollOnce();
		expect(pollResult.processed).toBe(true);
		expect(pollResult.receiptId).toBe(445566);
		expect(mockPriceResolver).toHaveBeenCalled();

		// Check that receiveNotification, sendMessage, and deleteNotification were invoked
		const receiveCall = mockCalls.find((c) => c.url.includes('/receiveNotification/'));
		const sendCall = mockCalls.find((c) => c.url.includes('/sendMessage/'));
		const deleteCall = mockCalls.find((c) => c.url.includes('/deleteNotification/'));

		expect(receiveCall).toBeDefined();
		expect(sendCall).toBeDefined();
		expect(deleteCall).toBeDefined();

		const sentPayload = JSON.parse(sendCall.options.body);
		expect(sentPayload.chatId).toBe('120363025492938@g.us');
		expect(sentPayload.message).toContain('68,450.25');
	});
});
