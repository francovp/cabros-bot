'use strict';

const { postCanaryAlert } = require('../../src/controllers/webhooks/handlers/canaryAlert/canaryAlert');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	getFirestore: jest.fn(),
	saveAlert: jest.fn(),
}));

jest.mock('../../src/controllers/webhooks/handlers/alert/grounding', () => ({
	enrichAlert: jest.fn(),
}));

const { enrichAlert } = require('../../src/controllers/webhooks/handlers/alert/grounding');

function createMockReq(overrides = {}) {
	return {
		body: {},
		query: {},
		headers: {},
		...overrides,
	};
}

function createMockRes() {
	const res = {};
	res.status = jest.fn().mockReturnValue(res);
	res.json = jest.fn().mockReturnValue(res);
	res.send = jest.fn().mockReturnValue(res);
	return res;
}

describe('postCanaryAlert controller', () => {
	let savedEnv;
	let mockBot;
	let mockFirestore;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_CANARY_ALERT = 'true';
		process.env.ENABLE_TELEGRAM_BOT = 'false';
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

		remoteConfigService._resetForTesting();
		jest.clearAllMocks();

		mockFirestore = {
			collection: jest.fn().mockReturnValue({
				limit: jest.fn().mockReturnValue({
					get: jest.fn().mockResolvedValue({ empty: false, size: 1 }),
				}),
			}),
		};

		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.getFirestore.mockReturnValue(mockFirestore);

		mockBot = {
			telegram: {
				getMe: jest.fn().mockResolvedValue({ id: 123456, username: 'test_bot' }),
			},
		};
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		Object.assign(process.env, savedEnv);
		remoteConfigService._resetForTesting();
	});

	it('returns 404 when ENABLE_CANARY_ALERT is not enabled', async () => {
		process.env.ENABLE_CANARY_ALERT = 'false';
		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq();
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
			error: 'Canary alert is not enabled',
			code: 'FEATURE_DISABLED',
		}));
	});

	it('executes full pipeline with default synthetic alert and returns healthy report', async () => {
		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq();
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		const report = res.json.mock.calls[0][0];

		expect(report.canary).toBe(true);
		expect(report.overall).toBe('healthy');
		expect(typeof report.totalMs).toBe('number');
		expect(report.stages).toBeDefined();

		// Validation stage
		expect(report.stages.validation.ok).toBe(true);
		expect(typeof report.stages.validation.ms).toBe('number');

		// Enrichment stage (skipped because no provider is enabled)
		expect(report.stages.enrichment.ok).toBe(true);
		expect(report.stages.enrichment.provider).toBe('none');
		expect(report.stages.enrichment.skipped).toBe(true);

		// Notification stage
		expect(report.stages.notification.ok).toBe(true);
		expect(typeof report.stages.notification.channel).toBe('string');
		expect(typeof report.stages.notification.ms).toBe('number');

		// Storage stage
		expect(report.stages.storage.ok).toBe(true);
		expect(report.stages.storage.collection).toBe('alerts');
		expect(typeof report.stages.storage.ms).toBe('number');

		// Never stores an alert document in the alerts collection
		expect(alertStorageService.saveAlert).not.toHaveBeenCalled();
		expect(mockFirestore.collection).toHaveBeenCalledWith('alerts');
	});

	it('executes enrichment stage when Gemini grounding is enabled', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		enrichAlert.mockResolvedValueOnce({
			extraText: 'BTC is bullish according to live data',
			sources: ['binance'],
		});

		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq({
			body: { text: 'BINANCE:BTCUSDT 1h BUY' },
		});
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		const report = res.json.mock.calls[0][0];
		expect(report.stages.enrichment.ok).toBe(true);
		expect(report.stages.enrichment.provider).toBe('gemini');
		expect(enrichAlert).toHaveBeenCalled();
	});

	it('marks overall as degraded when enrichment fails fail-open', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		enrichAlert.mockRejectedValueOnce(new Error('Gemini API quota exceeded'));

		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq({
			body: { text: 'BINANCE:BTCUSDT 1h BUY' },
		});
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		const report = res.json.mock.calls[0][0];
		expect(report.overall).toBe('degraded');
		expect(report.stages.enrichment.ok).toBe(false);
		expect(report.stages.enrichment.error).toContain('Gemini API quota exceeded');
	});

	it('marks overall as unhealthy and returns 503 when storage probe fails', async () => {
		mockFirestore.collection.mockReturnValueOnce({
			limit: jest.fn().mockReturnValue({
				get: jest.fn().mockRejectedValueOnce(new Error('Firestore connection timeout')),
			}),
		});

		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq();
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(503);
		const report = res.json.mock.calls[0][0];
		expect(report.overall).toBe('unhealthy');
		expect(report.stages.storage.ok).toBe(false);
		expect(report.stages.storage.error).toContain('Firestore connection timeout');
	});

	it('marks overall as unhealthy when validation fails for empty/invalid text', async () => {
		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq({
			body: { text: '' },
		});
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(503);
		const report = res.json.mock.calls[0][0];
		expect(report.overall).toBe('unhealthy');
		expect(report.stages.validation.ok).toBe(false);
	});

	it('skips storage stage gracefully when Firestore alert storage is disabled', async () => {
		alertStorageService.isEnabled.mockReturnValue(false);

		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq();
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		const report = res.json.mock.calls[0][0];
		expect(report.stages.storage.ok).toBe(true);
		expect(report.stages.storage.skipped).toBe(true);
	});

	it('logs structured metric for operator observability', async () => {
		const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

		const handler = postCanaryAlert(() => mockBot);
		const req = createMockReq();
		const res = createMockRes();

		await handler(req, res);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('[CANARY]'),
			expect.objectContaining({
				canary: true,
				overall: 'healthy',
			}),
		);

		consoleSpy.mockRestore();
	});
});
