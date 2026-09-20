'use strict';

const maintenanceMode = require('../../src/lib/maintenanceMode');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('maintenanceMode', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.ENABLE_MAINTENANCE_MODE;
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		remoteConfigService._resetForTesting();
		maintenanceMode._resetForTesting();
	});

	afterAll(() => {
		process.env = { ...originalEnv };
		remoteConfigService._resetForTesting();
		maintenanceMode._resetForTesting();
	});

	describe('isMaintenanceModeEnabled', () => {
		it('defaults to false when environment variable and remote config are unset', () => {
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);
		});

		it('returns true when process.env.ENABLE_MAINTENANCE_MODE is true', () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(true);
		});

		it('returns false when process.env.ENABLE_MAINTENANCE_MODE is false', () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);
		});

		it('prioritizes Remote Config override over process.env', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: true });
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(true);

			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: false });
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);
		});
	});

	describe('maintenanceModeMiddleware', () => {
		it('calls next() when maintenance mode is disabled', async () => {
			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();

			await maintenanceMode.maintenanceModeMiddleware(req, res, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(status).not.toHaveBeenCalled();
		});

		it('returns 503 SERVICE_UNAVAILABLE with expected JSON when maintenance mode is enabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();

			await maintenanceMode.maintenanceModeMiddleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(status).toHaveBeenCalledWith(503);
			expect(json).toHaveBeenCalledWith({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('sends an admin Telegram notification on mode toggle and does not duplicate', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();

			await maintenanceMode.maintenanceModeMiddleware(req, res, next);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage).toHaveBeenCalledWith(
				'123456789',
				expect.stringContaining('Modo de mantenimiento'),
				expect.objectContaining({ parse_mode: 'MarkdownV2' }),
			);

			// Second request while still enabled should NOT send another notification
			await maintenanceMode.maintenanceModeMiddleware(req, res, next);
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		it('fails open if admin notification fails', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn().mockRejectedValue(new Error('Network error'));
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();
			expect(() => maintenanceMode.maintenanceModeMiddleware(req, res, next)).not.toThrow();
			expect(status).toHaveBeenCalledWith(503);
		});
		it('resets notification latch when maintenance mode transitions to disabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			// First notification
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Calling again while enabled: no new notification
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Mode is turned off -> isMaintenanceModeEnabled() resets latch
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);

			// Mode is turned back on -> should notify again
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});

		it('retries notification on subsequent check if previous notification failed', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn()
				.mockRejectedValueOnce(new Error('Network timeout'))
				.mockResolvedValueOnce({ message_id: 2 });
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			// First attempt fails -> should not set permanent latch
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Second attempt while still enabled -> should retry and succeed
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);

			// Third attempt -> already latched because previous succeeded
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});
	});

	describe('isTelegramCommand', () => {
		it('returns true for text starting with slash', () => {
			expect(maintenanceMode.isTelegramCommand({ message: { text: '/start' } })).toBe(true);
			expect(maintenanceMode.isTelegramCommand({ message: { text: '/precio btc' } })).toBe(true);
		});

		it('returns true for messages with bot_command entity at offset 0', () => {
			expect(
				maintenanceMode.isTelegramCommand({
					message: {
						text: 'precio btc',
						entities: [{ type: 'bot_command', offset: 0, length: 6 }],
					},
				}),
			).toBe(true);
		});

		it('returns false for plain text messages without command', () => {
			expect(maintenanceMode.isTelegramCommand({ message: { text: 'hello world' } })).toBe(false);
			expect(maintenanceMode.isTelegramCommand({ message: { text: '' } })).toBe(false);
		});

		it('returns false for callback queries, empty messages, or non-object contexts', () => {
			expect(maintenanceMode.isTelegramCommand({ callbackQuery: { data: 'confirm' } })).toBe(false);
			expect(maintenanceMode.isTelegramCommand({})).toBe(false);
			expect(maintenanceMode.isTelegramCommand(null)).toBe(false);
		});
	});

	describe('telegramMaintenanceMode', () => {
		it('calls next() when maintenance mode is disabled', async () => {
			const reply = jest.fn();
			const context = { reply, message: { text: '/precio btc' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(reply).not.toHaveBeenCalled();
		});

		it('replies with maintenance notice and suppresses next() when maintenance mode is enabled for commands', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn().mockResolvedValue({});
			const context = { reply, message: { text: '/precio btc' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).not.toHaveBeenCalled();
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply).toHaveBeenCalledWith(expect.stringMatching(/mantenimiento/i));
		});

		it('calls next() without replying when message is not a command even if maintenance mode is enabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn();
			const context = { reply, message: { text: 'just a normal message' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(reply).not.toHaveBeenCalled();
		});

		it('calls next() for callback queries even if maintenance mode is enabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn();
			const context = { reply, callbackQuery: { id: 'cb1', data: 'action' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(reply).not.toHaveBeenCalled();
		});
	});
});
