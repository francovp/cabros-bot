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

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const NotificationManager = require('../../src/services/notification/NotificationManager');
const alertModule = require('../../src/controllers/webhooks/handlers/alert/alert');
const { waitForBackgroundTasks, resetForTesting: resetTasksForTesting } = require('../../src/lib/backgroundTaskTracker');

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
	let editMessageReplyMarkupMock;

	beforeEach(() => {
		jest.clearAllMocks();
		resetTasksForTesting();
		alertModule.__resetNotificationManagerForTesting();
		editMessageReplyMarkupMock = jest.fn().mockResolvedValue(undefined);
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
			channels: new Map([['telegram', {
				bot: { telegram: { editMessageReplyMarkup: editMessageReplyMarkupMock } },
			}]]),
			isIntentionalApiOnly: jest.fn(() => false),
		}));
		process.env.WEBHOOK_API_KEY = 'test-api-key';
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		process.env.TELEGRAM_CHAT_ID = 'chat-1';
		process.env.TELEGRAM_ACTION_OPERATOR_USER_IDS = '42';
		alertStorageService.isEnabled = jest.fn(() => true);
		alertStorageService.saveAlert = jest.fn().mockResolvedValue('stored-alert-id');
	});

	afterEach(() => {
		delete process.env.WEBHOOK_API_KEY;
		delete process.env.ENABLE_TELEGRAM_BOT;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.TELEGRAM_CHAT_ID;
		delete process.env.TELEGRAM_ACTION_OPERATOR_USER_IDS;
	});

	it('attaches a reply_markup only after the alert is durably stored', async () => {
		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });
		await new Promise((resolve) => setImmediate(resolve));

		expect(response.status).toBe(200);
		expect(sendToAllMock).toHaveBeenCalledTimes(1);
		const sentAlert = sendToAllMock.mock.calls[0][0];
		expect(sentAlert.replyMarkup).toBeUndefined();
		expect(editMessageReplyMarkupMock).toHaveBeenCalledTimes(1);
		const replyMarkup = editMessageReplyMarkupMock.mock.calls[0][3];
		expect(replyMarkup.inline_keyboard).toBeDefined();
		const callbackActions = replyMarkup.inline_keyboard
			.flat()
			.map((button) => button.callback_data.split(':')[0]);
		expect(callbackActions).toEqual(expect.arrayContaining(['r', 'x', 'd', 'vu', 'vd']));
		expect(editMessageReplyMarkupMock).toHaveBeenCalledWith(
			'chat-1',
			101,
			undefined,
			replyMarkup,
		);
	});

	it('does not attach a keyboard when durable alert storage fails', async () => {
		alertStorageService.saveAlert.mockResolvedValue(null);
		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });
		await new Promise((resolve) => setImmediate(resolve));

		expect(response.status).toBe(200);
		expect(sendToAllMock.mock.calls[0][0].replyMarkup).toBeUndefined();
		expect(editMessageReplyMarkupMock).not.toHaveBeenCalled();
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

	it('persists the alert with a pre-generated alertId used by the markup', async () => {
		const app = buildApp();
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });
		await new Promise((resolve) => setImmediate(resolve));

		const savedAlertId = alertStorageService.saveAlert.mock.calls[0][0].alertId;
		const sentAlert = sendToAllMock.mock.calls[0][0];
		const replyMarkup = editMessageReplyMarkupMock.mock.calls[0][3];
		const expectedAlertId = replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1];
		expect(expectedAlertId).toMatch(/^[a-f0-9-]{36}$/);
		expect(alertStorageService.saveAlert).toHaveBeenCalledTimes(1);
		expect(savedAlertId).toBe(expectedAlertId);
		expect(sentAlert.replyMarkup).toBeUndefined();
	});

	it('each callback_data is within the 64-byte Telegram limit', async () => {
		const app = buildApp();
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });
		await new Promise((resolve) => setImmediate(resolve));

		const replyMarkup = editMessageReplyMarkupMock.mock.calls[0][3];
		replyMarkup.inline_keyboard.flat().forEach((button) => {
			expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
		});
	});

	it('routes reply_markup through sendToChannels when explicit channels are requested', async () => {
		const app = buildApp();
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT', channels: ['telegram'] });
		await new Promise((resolve) => setImmediate(resolve));

		expect(sendToChannelsMock).toHaveBeenCalledTimes(1);
		const sentAlert = sendToChannelsMock.mock.calls[0][0];
		expect(sentAlert.replyMarkup).toBeUndefined();
		expect(editMessageReplyMarkupMock).toHaveBeenCalledTimes(1);
	});

	it('tracks post-persistence keyboard attachment in backgroundTaskTracker', async () => {
		let resolveKeyboardEdit;
		editMessageReplyMarkupMock.mockImplementation(() => new Promise((resolve) => {
			resolveKeyboardEdit = resolve;
		}));

		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-api-key')
			.send({ text: 'BINANCE:BTCUSDT' });

		expect(response.status).toBe(200);

		let drained = false;
		const drainPromise = waitForBackgroundTasks().then(() => {
			drained = true;
		});

		await new Promise((resolve) => setImmediate(resolve));
		expect(drained).toBe(false);
		expect(editMessageReplyMarkupMock).toHaveBeenCalledTimes(1);

		resolveKeyboardEdit();
		await drainPromise;
		expect(drained).toBe(true);
	});

	describe('attachInlineKeyboardAfterPersistence', () => {
		it('bounds slow or hanging editMessageReplyMarkup with a timeout and logs a warning', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			const hangingEdit = jest.fn(() => new Promise(() => {}));
			const manager = {
				channels: new Map([
					['telegram', { bot: { telegram: { editMessageReplyMarkup: hangingEdit } } }],
				]),
			};
			const results = [{ channel: 'telegram', success: true, messageId: 42 }];
			const routing = { telegramChatId: 'chat-1' };
			const replyMarkup = { inline_keyboard: [] };

			await alertModule.attachInlineKeyboardAfterPersistence({
				manager,
				results,
				routing,
				replyMarkup,
				timeoutMs: 50,
			});

			expect(hangingEdit).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledWith(
				'[Alert] Failed to attach inline keyboard after persistence:',
				expect.stringContaining('timed out after 50ms'),
			);
			warnSpy.mockRestore();
		});

		it('does nothing when results or replyMarkup or manager are missing', async () => {
			await expect(alertModule.attachInlineKeyboardAfterPersistence({})).resolves.toBeUndefined();
			await expect(alertModule.attachInlineKeyboardAfterPersistence({
				results: [],
				replyMarkup: {},
			})).resolves.toBeUndefined();
			await expect(alertModule.attachInlineKeyboardAfterPersistence({
				aggregated: true,
				replyMarkup: {},
			})).resolves.toBeUndefined();
		});
	});
});
