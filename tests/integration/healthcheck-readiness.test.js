'use strict';

const request = require('supertest');
const { attachReadinessOverrides, resetReadinessService } = require('../../src/controllers/readiness');

function setEnv(map) {
	const previous = {};
	for (const [key, value] of Object.entries(map)) {
		previous[key] = process.env[key];
		if (value === undefined || value === null) {
			delete process.env[key];
		} else {
			process.env[key] = String(value);
		}
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
}

describe('healthcheck + readiness', () => {
	let restore;
	let app;

	beforeAll(() => {
		restore = setEnv({
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
			ENABLE_FIRESTORE_JOB_STORAGE: 'false',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_NEWS_MONITOR: 'false',
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'false',
			ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION: 'false',
			ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT: 'false',
			ENABLE_MARKET_SCANNER: 'false',
			ENABLE_BINANCE_TRADING: 'false',
			ENABLE_BINANCE_PRICE_CHECK: 'false',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
			ENABLE_TELEGRAM_BOT: 'false',
		});
		app = require('../../app');
		attachReadinessOverrides(app, {
			timeoutMs: 1500,
			getTradingViewReadiness: () => ({ status: 'disabled' }),
			isBotEnabled: () => false,
			getBot: () => null,
		});
	});

	afterAll(() => {
		resetReadinessService();
		if (typeof restore === 'function') {
			restore();
		}
	});

	it('GET /healthcheck returns the legacy uptime payload', async () => {
		const response = await request(app).get('/healthcheck');
		expect(response.status).toBe(200);
		expect(response.body).toHaveProperty('uptime');
		expect(response.body).not.toHaveProperty('dependencies');
	});

	it('GET /healthcheck?depth=readiness returns the readiness report', async () => {
		const response = await request(app).get('/healthcheck?depth=readiness');
		expect([200, 503]).toContain(response.status);
		expect(response.body).toHaveProperty('ready');
		expect(response.body).toHaveProperty('dependencies');
		expect(response.body.dependencies.firestore.skipped).toBe(true);
		expect(response.body.dependencies.gemini.skipped).toBe(true);
		expect(response.body.dependencies.tradingViewMcp.skipped).toBe(true);
		expect(response.body.dependencies.binance.skipped).toBe(true);
		expect(response.body.dependencies.telegram.skipped).toBe(true);
	});

	it('GET /ready mirrors the readiness report and returns 503 when no considered deps are healthy', async () => {
		const response = await request(app).get('/ready');
		expect(response.status).toBe(503);
		expect(response.body.ready).toBe(false);
		expect(response.body).toHaveProperty('latencyMs');
	});

	it('GET /ready returns 200 when a considered dependency reports ready', async () => {
		resetReadinessService();
		attachReadinessOverrides(app, {
			timeoutMs: 1500,
			isFirestoreConfigured: () => true,
			getFirestoreClient: () => ({ listCollections: async () => [] }),
			getTradingViewReadiness: () => ({ status: 'disabled' }),
			isBotEnabled: () => false,
			getBot: () => null,
		});
		const restoreFlags = setEnv({
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
		});
		try {
			const response = await request(app).get('/ready');
			expect(response.status).toBe(200);
			expect(response.body.ready).toBe(true);
			expect(response.body.dependencies.firestore.ready).toBe(true);
		} finally {
			restoreFlags();
		}
	});
});
