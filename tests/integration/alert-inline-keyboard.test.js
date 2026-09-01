'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/notification/NotificationManager', () => {
	const mockModule = jest.fn();
	mockModule.sendToAll = jest.fn();
	mockModule.sendToChannels = jest.fn();
	return mockModule;
});
jest.mock('../../src/services/notification/TelegramService', () => {
	const mockModule = jest.fn();
	mockModule.validate = jest.fn();
	mockModule.isEnabled = jest.fn();
	mockModule.send = jest.fn();
	return mockModule;
});
jest.mock('../../src/services/notification/WhatsAppService', () => {
	const mockModule = jest.fn();
	mockModule.validate = jest.fn();
	mockModule.isEnabled = jest.fn();
	mockModule.send = jest.fn();
	return mockModule;
});
jest.mock('../../src/services/notification/DiscordService', () => {
	const mockModule = jest.fn();
	mockModule.validate = jest.fn();
	mockModule.isEnabled = jest.fn();
	mockModule.send = jest.fn();
	return mockModule;
});
jest.mock('../../src/lib/validation', () => ({
	validateAlert: jest.fn((text) => ({ text })),
}));

const { shortIdFor, defaultStore } = require('../../src/services/alerts/telegramActionStore');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const NotificationManager = require('../../src/services/notification/NotificationManager');
const alertModule = require('../../src/controllers/webhooks/handlers/alert/alert');

function buildApp() {
	const app = express();
	app.use(express.json());
	const { getRoutes } = require('../../src/routes');
	app.use('/api', getRoutes(() => ({
		telegram: {
			editMessageReplyMarkup: jest.fn(),
			sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
		},
	})));
	return app;
}

describe('Inline keyboard markup on /api/webhook/alert', () => {
	let sendToAllMock;
	let sendToChannelsMock;

	beforeEach(() => {
		jest.clearAllMocks();
		alertModule.__resetNotificationManagerForTesting();
		sendToAllMock = jest.fn().mockImplementation((alert) => Promise.resolve([
			{ channel: 'telegram', success: true, messageId: '101', alert },
		]));
		sendToChannelsMock = jest.fn().mockImplementation((alert) => Promise.resolve([
			{ channel: 'telegram', success: true, messageId: '101', alert },
		]));
		NotificationManager.mockImplementation(() => ({
			validateAll: jest.fn().mockResolvedValue([]),
			getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
			sendToAll: sendToAllMock,
			sendToChannels: sendToChannelsMock,
			isIntentionalApiOnly: jest.fn(() => false),
		}));
		defaultStore.clear();
		process.env.WEBHOOK_API_KEY = 'test-api-key';
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		process.env.TELEGRAM_CHAT_ID = 'chat-1';
		alertStorageService.isEnabled = jest.fn(() => true);
		alertStorageService.saveAlert = jest.fn().mockResolvedValue('stored-alert-id');
	});

	afterEach(() => {
		delete process.env.WEBHOOK_API_KEY;
		delete process.env.ENABLE_TELEGRAM_BOT;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.TELEGRAM_CHAT_ID;
	});

	it('attaches a reply_markup to the alert payload when storage is enabled', async () => {
		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });

		expect(response.status).toBe(200);
		expect(sendToAllMock).toHaveBeenCalledTimes(1);
		const sentAlert = sendToAllMock.mock.calls[0][0];
		expect(sentAlert.replyMarkup).toBeDefined();
		expect(sentAlert.replyMarkup.inline_keyboard).toBeDefined();
		const callbackActions = sentAlert.replyMarkup.inline_keyboard
			.flat()
			.map((button) => button.callback_data.split(':')[0]);
		expect(callbackActions).toEqual(expect.arrayContaining(['r', 'x', 'd', 'vu', 'vd']));
	});

	it('does not attach reply_markup when storage is disabled', async () => {
		alertStorageService.isEnabled = jest.fn(() => false);

		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });

		expect(response.status).toBe(200);
		expect(sendToAllMock).toHaveBeenCalledTimes(1);
		const sentAlert = sendToAllMock.mock.calls[0][0];
		expect(sentAlert.replyMarkup).toBeUndefined();
	});

	it('persists the alert with a pre-generated alertId that matches the markup shortId', async () => {
		const app = buildApp();
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });

		const sentAlert = sendToAllMock.mock.calls[0][0];
		const expectedShortId = sentAlert.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1];
		expect(expectedShortId).toMatch(/^[0-9A-Z]{8}$/);
		expect(alertStorageService.saveAlert).toHaveBeenCalledTimes(1);
		const savedAlertId = alertStorageService.saveAlert.mock.calls[0][0].alertId;
		expect(shortIdFor(savedAlertId)).toBe(expectedShortId);
	});

	it('each callback_data is within the 64-byte Telegram limit', async () => {
		const app = buildApp();
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });

		const sentAlert = sendToAllMock.mock.calls[0][0];
		sentAlert.replyMarkup.inline_keyboard.flat().forEach((button) => {
			expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
		});
	});

	it('routes reply_markup through sendToChannels when explicit channels are requested', async () => {
		const app = buildApp();
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT', channels: ['telegram'] });

		expect(sendToChannelsMock).toHaveBeenCalledTimes(1);
		const sentAlert = sendToChannelsMock.mock.calls[0][0];
		expect(sentAlert.replyMarkup).toBeDefined();
	});
});
