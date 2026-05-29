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

		process.env.SERVICE_NAME = 'cabros-bot-test';
		process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';
		process.env.NODE_ENV = 'test';
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
		process.env.TRADINGVIEW_MCP_URL = 'https://tradingview-mcp.example/mcp';
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

	it('returns machine-readable status on /api/status', async () => {
		const response = await request(app).get('/api/status');

		expect(response.status).toBe(200);
		expect(response.body.service.name).toBe('cabros-bot-test');
		expect(response.body.service.commit).toBe('abcdef1234567890');
		expect(response.body.featureFlags.telegramBot).toBe(true);
		expect(response.body.deliveryChannels.telegram.configured).toBe(true);
		expect(response.body.dependencies.gemini.configured).toBe(true);
		expect(response.body.dependencies.sentry.configured).toBe(true);
	});

	it('aliases /api/capabilities to the same payload shape', async () => {
		const response = await request(app).get('/api/capabilities');

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

		const response = await request(app).get('/api/status');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.whatsapp.enabled).toBe(false);
		expect(response.body.dependencies.whatsapp.configured).toBe(false);
		expect(response.body.dependencies.tradingViewMcp.enabled).toBe(false);
	});
});
