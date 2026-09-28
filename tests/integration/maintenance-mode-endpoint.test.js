'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { _resetForTesting } = require('../../src/lib/maintenanceMode');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => {
	const actual = jest.requireActual('../../src/controllers/webhooks/handlers/alert/alert');
	return {
		...actual,
		postAlert: jest.fn(() => (_req, res) => res.status(200).json({ success: true })),
	};
});

describe('Maintenance Mode Integration Tests', () => {
	let originalEnv;
	let mockBot;

	beforeEach(() => {
		originalEnv = { ...process.env };
		_resetForTesting();
		remoteConfigService._resetForTesting?.();

		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 123 }),
			},
		};

		process.env.WEBHOOK_API_KEY = 'test-key';
		process.env.ENABLE_MAINTENANCE_MODE = 'false';
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;

		app.use('/api', getRoutes(() => mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
		_resetForTesting();
		remoteConfigService._resetForTesting?.();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('When maintenance mode is disabled (default)', () => {
		it('allows webhook requests to proceed past maintenance middleware', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ message: 'test alert' });

			expect(res.status).toBe(200);
			expect(res.body).toEqual({ success: true });
		});

		it('reports maintenanceMode: false in /api/status', async () => {
			const res = await request(app)
				.get('/api/status')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.featureFlags).toBeDefined();
			expect(res.body.featureFlags.maintenanceMode).toBe(false);
		});
	});

	describe('When maintenance mode is enabled via environment variable', () => {
		beforeEach(() => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = 'admin-chat-123';
		});

		it('returns 401 when request is unauthorized even if maintenance mode is enabled', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.send({ message: 'unauthorized' })
				.expect(401);

			expect(res.body).toHaveProperty('error');
			expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
		});

		it('returns 503 with exact MAINTENANCE_MODE payload for POST /api/webhook/alert', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ message: 'btc pump' })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('returns 503 for POST /api/webhook/message', async () => {
			const res = await request(app)
				.post('/api/webhook/message')
				.set('x-api-key', 'test-key')
				.send({ text: 'hello' })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('returns 503 for POST /api/webhook/expanded-analysis-alert', async () => {
			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'] })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('returns 503 for POST /api/webhook/market-scanner-alert', async () => {
			const res = await request(app)
				.post('/api/webhook/market-scanner-alert')
				.set('x-api-key', 'test-key')
				.send({ scans: ['gainers'] })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('returns 503 for POST /api/webhook/volume-confirmation', async () => {
			const res = await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BINANCE:BTCUSDT' })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('returns 503 for POST /api/webhook/symbol-analysis', async () => {
			const res = await request(app)
				.post('/api/webhook/symbol-analysis')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BINANCE:BTCUSDT' })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('returns 503 for POST /api/news-monitor', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-key')
				.send({ crypto: ['BTC'] })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('returns 503 for GET /api/news-monitor', async () => {
			const res = await request(app)
				.get('/api/news-monitor')
				.set('x-api-key', 'test-key')
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('leaves GET /healthcheck returning 200 OK', async () => {
			const res = await request(app)
				.get('/healthcheck')
				.expect(200);

			expect(res.body).toEqual({ uptime: expect.any(Number) });
		});

		it('returns 200 with featureFlags.maintenanceMode: true for GET /api/status', async () => {
			const res = await request(app)
				.get('/api/status')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.featureFlags).toBeDefined();
			expect(res.body.featureFlags.maintenanceMode).toBe(true);
		});

		it('returns 200 with featureFlags.maintenanceMode: true for GET /api/capabilities', async () => {
			const res = await request(app)
				.get('/api/capabilities')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.featureFlags).toBeDefined();
			expect(res.body.featureFlags.maintenanceMode).toBe(true);
		});

		it('notifies admin on toggle when a protected route is called in maintenance mode', async () => {
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ message: 'alert' })
				.expect(503);

			expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
				'admin-chat-123',
				expect.stringContaining('Modo de mantenimiento ACTIVADO'),
				expect.objectContaining({ parse_mode: 'MarkdownV2' }),
			);

			// Calling again should not re-notify (latched)
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ message: 'alert' })
				.expect(503);

			expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
		});
	});

	describe('When maintenance mode is enabled via Firebase Remote Config', () => {
		beforeEach(() => {
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = 'admin-chat-456';
			remoteConfigService._setRemoteOverridesForTesting({
				ENABLE_MAINTENANCE_MODE: true,
			});
		});

		it('prefers Remote Config true over env var false and returns 503', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ message: 'btc pump' })
				.expect(503);

			expect(res.body).toEqual({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('reflects maintenanceMode: true in /api/status when enabled via Remote Config', async () => {
			const res = await request(app)
				.get('/api/status')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.featureFlags.maintenanceMode).toBe(true);
		});
	});
});
