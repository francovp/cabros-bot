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

			await expect(maintenanceMode.maintenanceModeMiddleware(req, res, next)).resolves.not.toThrow();
			expect(status).toHaveBeenCalledWith(503);
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

		it('replies with maintenance notice and suppresses next() when maintenance mode is enabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn().mockResolvedValue({});
			const context = { reply, message: { text: '/precio btc' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).not.toHaveBeenCalled();
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply).toHaveBeenCalledWith(expect.stringMatching(/mantenimiento/i));
		});
	});
});
