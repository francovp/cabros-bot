const request = require('supertest');
const express = require('express');
const { getRoutes } = require('../../src/routes');

describe('Status endpoints', () => {
	const originalEnv = { ...process.env };
	let app;

	beforeEach(() => {
		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => null));

		process.env.WEBHOOK_API_KEY = 'status-key';
		process.env.SERVICE_NAME = 'cabros-bot-test';
		process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';
		process.env.NODE_ENV = 'test';
		delete process.env.SENTRY_ENVIRONMENT;
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'token';
		process.env.TELEGRAM_CHAT_ID = '123';
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://greenapi.example/';
		process.env.WHATSAPP_API_KEY = 'key';
		process.env.WHATSAPP_CHAT_ID = 'chat';
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'gemini-key';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
		delete process.env.TRADINGVIEW_MCP_URL;
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":"x"}';
		process.env.ENABLE_SENTRY = 'true';
		process.env.SENTRY_DSN = 'https://dsn.example';
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);
	});

	it('requires a valid API key when WEBHOOK_API_KEY is configured', async () => {
		const response = await request(app).get('/api/status');

		expect(response.status).toBe(401);
		expect(response.body.error).toBe('Unauthorized: Missing API key');
	});

	it('returns machine-readable status on /api/status', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.service).toEqual({
			name: 'cabros-bot-test',
			version: expect.any(String),
			commit: 'abcdef1234567890',
			environment: 'test',
		});
		expect(response.body.service).not.toHaveProperty('timestamp');
		expect(response.body.featureFlags.telegramBot).toBe(true);
		expect(response.body.deliveryChannels.telegram).toEqual({ enabled: true, status: 'ready' });
		expect(response.body.dependencies.gemini).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
		expect(response.body.dependencies.tradingViewMcp).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
		expect(response.body.dependencies.sentry.status).toBe('ready');
	});

	it('treats Gemini as enabled when news monitor depends on it', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.geminiGrounding).toBe(false);
		expect(response.body.featureFlags.newsMonitor).toBe(true);
		expect(response.body.dependencies.gemini).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('aliases /api/capabilities to the same payload shape', async () => {
		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body).toHaveProperty('service');
		expect(response.body).toHaveProperty('featureFlags');
		expect(response.body).toHaveProperty('deliveryChannels');
		expect(response.body).toHaveProperty('dependencies');
	});

	it('handles disabled optional integrations without failing', async () => {
		delete process.env.WHATSAPP_API_KEY;
		process.env.ENABLE_WHATSAPP_ALERTS = 'false';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.whatsapp).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		expect(response.body.dependencies.tradingViewMcp.status).toBe('disabled');
	});

	it('treats TradingView MCP as enabled when market scanner depends on it', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
		process.env.ENABLE_MARKET_SCANNER = 'true';
		delete process.env.TRADINGVIEW_MCP_URL;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.marketScanner).toBe(true);
		expect(response.body.featureFlags.tradingViewMcpEnrichment).toBe(false);
		expect(response.body.dependencies.tradingViewMcp).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('treats Firestore ADC on Google-managed runtimes as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.K_SERVICE = 'cabros-bot';
		process.env.GOOGLE_CLOUD_PROJECT = 'cabros-project';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('does not treat a bare Google project id as Firestore ADC readiness', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.GOOGLE_CLOUD_PROJECT = 'cabros-project';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('does not leak configured secret values', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');
		const serializedBody = JSON.stringify(response.body);

		expect(serializedBody).not.toContain('token');
		expect(serializedBody).not.toContain('key');
		expect(serializedBody).not.toContain('gemini-key');
		expect(serializedBody).not.toContain('https://dsn.example');
		expect(serializedBody).not.toContain('https://greenapi.example/');
	});

	it('reports preview-disabled Telegram delivery separately from the feature flag', async () => {
		process.env.RENDER = 'true';
		process.env.IS_PULL_REQUEST = 'true';
		process.env.NODE_ENV = 'production';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.service.environment).toBe('preview');
		expect(response.body.featureFlags.telegramBot).toBe(true);
		expect(response.body.deliveryChannels.telegram).toEqual({ enabled: false, status: 'disabled' });
		expect(response.body.dependencies.telegram.ready).toBe(false);
	});
});
