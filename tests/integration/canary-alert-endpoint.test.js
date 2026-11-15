const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	getFirestore: jest.fn(),
}));

jest.mock('../../src/services/notification/NotificationManager', () => {
	return jest.fn().mockImplementation(() => ({
		validateAll: jest.fn().mockResolvedValue(),
		getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
		sendToChannels: jest.fn().mockResolvedValue([
			{ channel: 'telegram', success: true },
		]),
		sendToAll: jest.fn().mockResolvedValue([
			{ channel: 'telegram', success: true },
		]),
	}));
});

jest.mock('../../src/controllers/webhooks/handlers/alert/grounding', () => ({
	enrichAlert: jest.fn().mockResolvedValue({
		grounded: true,
		source: 'test-grounding',
	}),
}));

describe('POST /api/webhook/canary-alert integration', () => {
	const originalEnv = process.env;
	const mockBot = {
		telegram: {
			sendMessage: jest.fn().mockResolvedValue({ message_id: 123 }),
		},
	};

	beforeEach(() => {
		process.env = {
			...originalEnv,
			NODE_ENV: 'test',
			WEBHOOK_API_KEY: 'test-canary-key',
			ENABLE_CANARY_ALERT: 'true',
			TELEGRAM_CHAT_ID: '123456789',
			BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
		};

		jest.clearAllMocks();
		alertStorageService.isEnabled.mockReturnValue(false);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('returns 401 Unauthorized when x-api-key is missing or invalid', async () => {
		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.send({})
			.expect(401);

		expect(res.body.error).toContain('Unauthorized');
	});

	it('returns 404 when ENABLE_CANARY_ALERT is disabled', async () => {
		process.env.ENABLE_CANARY_ALERT = 'false';

		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.set('x-api-key', 'test-canary-key')
			.send({})
			.expect(404);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toMatch(/disabled|not enabled/i);
	});

	it('executes full canary pipeline successfully with default payload and dry run', async () => {
		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.set('x-api-key', 'test-canary-key')
			.send({})
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			overall: 'healthy',
			canary: true,
			mode: 'dry_run',
			stages: expect.objectContaining({
				validation: expect.objectContaining({ status: 'pass' }),
				enrichment: expect.objectContaining({ status: 'pass' }),
				notification: expect.objectContaining({ status: 'pass' }),
				storage: expect.objectContaining({ status: 'pass', checked: false }),
			}),
		}));
		expect(typeof res.body.executionTimeMs).toBe('number');
		expect(typeof res.body.timestamp).toBe('string');
	});

	it('accepts custom text and custom symbol parameters', async () => {
		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.set('x-api-key', 'test-canary-key')
			.send({
				text: 'Custom canary alert for ETHUSDT 1h test',
				symbol: 'BINANCE:ETHUSDT',
				useTradingViewData: false,
			})
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.overall).toBe('healthy');
		expect(res.body.stages.validation.parsedSymbol).toBe('ETHUSDT');
		expect(res.body.stages.enrichment.status).toBe('pass');
	});

	it('performs storage read probe when Firestore alert storage is enabled', async () => {
		const mockLimit = jest.fn().mockReturnValue({
			get: jest.fn().mockResolvedValue({ empty: false, size: 1 }),
		});
		const mockCollection = jest.fn().mockReturnValue({ limit: mockLimit });
		const mockFirestore = { collection: mockCollection };

		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.getFirestore.mockReturnValue(mockFirestore);

		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.set('x-api-key', 'test-canary-key')
			.send({})
			.expect(200);

		expect(res.body.stages.storage.checked).toBe(true);
		expect(res.body.stages.storage.status).toBe('pass');
		expect(mockCollection).toHaveBeenCalledWith('alerts');
		expect(mockLimit).toHaveBeenCalledWith(1);
	});

	it('returns 503 unhealthy when storage read probe fails', async () => {
		const mockLimit = jest.fn().mockReturnValue({
			get: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
		});
		const mockCollection = jest.fn().mockReturnValue({ limit: mockLimit });
		const mockFirestore = { collection: mockCollection };

		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.getFirestore.mockReturnValue(mockFirestore);

		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.set('x-api-key', 'test-canary-key')
			.send({})
			.expect(503);

		expect(res.body.success).toBe(false);
		expect(res.body.overall).toBe('unhealthy');
		expect(res.body.stages.storage.status).toBe('fail');
		expect(res.body.stages.storage.error).toBe('Firestore unavailable');
	});

	it('returns 503 unhealthy when validation fails (e.g. invalid text type)', async () => {
		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.set('x-api-key', 'test-canary-key')
			.send({ text: 12345 })
			.expect(503);

		expect(res.body.success).toBe(false);
		expect(res.body.overall).toBe('unhealthy');
		expect(res.body.stages.validation.status).toBe('fail');
	});

	it('actually invokes notification delivery when deliver: true is requested', async () => {
		const res = await request(app)
			.post('/api/webhook/canary-alert')
			.set('x-api-key', 'test-canary-key')
			.send({ deliver: true })
			.expect(200);

		expect(res.body.mode).toBe('delivery');
		expect(res.body.stages.notification.delivered).toBe(true);
	});
});
