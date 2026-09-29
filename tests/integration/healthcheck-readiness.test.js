'use strict';

const request = require('supertest');
const bootstrapReadiness = require('../../src/lib/bootstrapReadiness');
const {
	attachReadinessOverrides,
	resetReadinessService,
} = require('../../src/controllers/readiness');

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

const ALL_FEATURES_OFF = {
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
};

function applyOverrides(app, overrides) {
	resetReadinessService();
	attachReadinessOverrides(app, Object.assign({
		timeoutMs: 1500,
		getTradingViewReadiness: () => ({ status: 'disabled' }),
		isBotEnabled: () => false,
		getBot: () => null,
	}, overrides));
}

describe('healthcheck + dependency readiness', () => {
	let restore;
	let app;

	beforeAll(() => {
		restore = setEnv(ALL_FEATURES_OFF);
		app = require('../../app');
		applyOverrides(app);
	});

	afterAll(() => {
		resetReadinessService();
		if (typeof restore === 'function') {
			restore();
		}
	});

	beforeEach(() => {
		bootstrapReadiness.reset();
	});

	describe('liveness surface (must not regress)', () => {
		it('GET /healthcheck returns the legacy uptime payload', async () => {
			const response = await request(app).get('/healthcheck');
			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty('uptime');
			expect(response.body).not.toHaveProperty('dependencies');
		});

		it('GET /healthcheck?deep=true keeps the master channel-readiness contract', async () => {
			const response = await request(app).get('/healthcheck?deep=true');
			expect([200, 503]).toContain(response.status);
			expect(response.body).toHaveProperty('channels');
			expect(response.body).not.toHaveProperty('dependencies');
		});
	});

	describe('bootstrap gate (must not regress #956)', () => {
		it('GET /ready returns 503 with bootstrap state while pending', async () => {
			bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
			const response = await request(app).get('/ready');
			expect(response.status).toBe(503);
			expect(response.body.status).toBe('pending');
			expect(response.body).toHaveProperty('components');
			// The bootstrap gate must never run external provider probes.
			expect(response.body).not.toHaveProperty('dependencies');
		});

		it('GET /ready returns 200 once required bootstrap components are ready', async () => {
			bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
			bootstrapReadiness.markReady('notificationServices');
			const response = await request(app).get('/ready');
			expect(response.status).toBe(200);
			expect(response.body.status).toBe('ready');
			expect(response.body.ready).toBe(true);
			expect(response.body).not.toHaveProperty('dependencies');
		});
	});

	describe('advisory dependency surface (fails open, always 200)', () => {
		it('GET /healthcheck?depth=readiness reports skipped dependencies and still returns 200', async () => {
			const response = await request(app).get('/healthcheck?depth=readiness');
			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty('ready');
			expect(response.body.failClosed).toBe(false);
			expect(response.body.dependencies.firestore.skipped).toBe(true);
			expect(response.body.dependencies.gemini.skipped).toBe(true);
			expect(response.body.dependencies.tradingViewMcp.skipped).toBe(true);
			expect(response.body.dependencies.binance.skipped).toBe(true);
			expect(response.body.dependencies.telegram.skipped).toBe(true);
		});

		it('GET /healthcheck?depth=readiness stays 200 and reports ready:false when a dependency is degraded', async () => {
			// A flaky provider must never evict a healthy replica from rotation.
			applyOverrides(app, {
				isFirestoreConfigured: () => true,
				getFirestoreClient: () => ({
					listCollections: () => new Promise(() => { /* hangs past the probe timeout */ }),
				}),
			});
			const restoreFlags = setEnv({ ENABLE_FIRESTORE_ALERT_STORAGE: 'true' });
			try {
				const response = await request(app).get('/healthcheck?depth=readiness');
				expect(response.status).toBe(200);
				expect(response.body.ready).toBe(false);
				expect(response.body.failClosed).toBe(false);
				expect(response.body.dependencies.firestore.ready).toBe(false);
				expect(response.body.dependencies.firestore.error).toMatch(/timeout_after_/);
			} finally {
				restoreFlags();
				applyOverrides(app);
			}
		});
	});

	describe('fail-closed dependency surface (traffic gating)', () => {
		it('GET /ready?depth=dependencies returns 503 when no considered dependency is healthy', async () => {
			bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
			bootstrapReadiness.markReady('notificationServices');
			const response = await request(app).get('/ready?depth=dependencies');
			expect(response.status).toBe(503);
			expect(response.body.ready).toBe(false);
			expect(response.body.failClosed).toBe(true);
			expect(response.body).toHaveProperty('latencyMs');
			expect(response.body.dependencies.gemini.skipped).toBe(true);
		});

		it('GET /ready?depth=dependencies returns 200 when a considered dependency reports ready', async () => {
			bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
			bootstrapReadiness.markReady('notificationServices');
			applyOverrides(app, {
				isFirestoreConfigured: () => true,
				getFirestoreClient: () => ({ listCollections: async () => [] }),
			});
			const restoreFlags = setEnv({ ENABLE_FIRESTORE_ALERT_STORAGE: 'true' });
			try {
				const response = await request(app).get('/ready?depth=dependencies');
				expect(response.status).toBe(200);
				expect(response.body.ready).toBe(true);
				expect(response.body.failClosed).toBe(true);
				expect(response.body.dependencies.firestore.ready).toBe(true);
			} finally {
				restoreFlags();
				applyOverrides(app);
			}
		});

		it('GET /ready?depth=report is not a recognized depth and keeps the bootstrap contract', async () => {
			bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
			bootstrapReadiness.markReady('notificationServices');
			const response = await request(app).get('/ready?depth=report');
			expect(response.status).toBe(200);
			expect(response.body.status).toBe('ready');
			expect(response.body).not.toHaveProperty('dependencies');
		});
	});
});
