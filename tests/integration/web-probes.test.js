const request = require('supertest');
const bootstrap = require('../../src/lib/bootstrapReadiness');
const lifecycle = require('../../src/lib/processLifecycle');
const { attachReadinessOverrides, resetReadinessService } = require('../../src/controllers/readiness');
const app = require('../../app');

describe('web liveness and readiness probes (#732)', () => {
	const previousEnv = { ...process.env };
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith('ENABLE_')) process.env[key] = 'false';
		}
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		bootstrap.begin();
		bootstrap.markReady('notificationServices');
		attachReadinessOverrides(app, {
			isFirestoreConfigured: () => true,
			getFirestoreClient: () => ({ listCollections: async () => [] }),
			probeAlertReads: async () => true,
			isBotEnabled: () => false,
		});
	});
	afterEach(() => {
		bootstrap.reset();
		resetReadinessService();
		jest.restoreAllMocks();
		process.env = { ...previousEnv };
	});

	it('keeps liveness independent of bootstrap, dependencies, query variants and drain', async () => {
		bootstrap.reset();
		jest.spyOn(lifecycle, 'isShuttingDownForPublicStatus').mockReturnValue(true);
		const collect = jest.spyOn(require('../../src/controllers/readiness'), 'collectReadiness');
		const response = await request(app).get('/livez?depth=dependencies&deep=true');
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ status: 'alive', uptimeMs: expect.any(Number) });
		expect(response.body.uptimeMs).toBeGreaterThanOrEqual(0);
		expect(collect).not.toHaveBeenCalled();
	});

	it('reports healthy and disabled dependencies without requiring an API key', async () => {
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(200);
		expect(response.body.status).toBe('ready');
		expect(response.body.checks).toEqual(expect.arrayContaining([
			{ name: 'firestore', status: 'ready' },
			{ name: 'telegram', status: 'unconfigured' },
		]));
	});

	it.each(['pending', 'failed'])('rejects %s bootstrap', async (state) => {
		bootstrap.reset();
		if (state === 'failed') bootstrap.fail(new Error('private startup error'));
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(503);
		expect(response.body.checks).toContainEqual({ name: 'bootstrap', status: 'fail' });
		expect(JSON.stringify(response.body)).not.toContain('private');
	});

	it('fails for degraded TradingView using the existing readiness service', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT = 'true';
		attachReadinessOverrides(app, {
			getTradingViewReadiness: () => ({ status: 'degraded' }),
			isFirestoreConfigured: () => false,
			isBotEnabled: () => false,
		});
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(503);
		expect(response.body.checks).toContainEqual({ name: 'tradingViewMcp', status: 'fail' });
		expect(response.body.checks).toContainEqual({ name: 'firestore', status: 'fail' });
	});

	it('fails for missing required Gemini credentials', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		delete process.env.GEMINI_API_KEY;
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(503);
		expect(response.body.checks).toContainEqual({ name: 'gemini', status: 'fail' });
	});

	it.each(['render', 'vercel'])('allows healthy API-only %s previews', async (host) => {
		process.env.ENABLE_API_ONLY_MODE = 'true';
		if (host === 'render') Object.assign(process.env, { RENDER: 'true', IS_PULL_REQUEST: 'true' });
		else process.env.VERCEL_ENV = 'preview';
		expect((await request(app).get('/readyz')).status).toBe(200);
	});

	it('retains the existing fail-closed verdict when all dependencies are disabled', async () => {
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(503);
		expect(response.body.checks).toContainEqual({ name: 'dependencies', status: 'fail' });
	});

	it('fails during drain even when dependency readiness is cached', async () => {
		expect((await request(app).get('/readyz')).status).toBe(200);
		jest.spyOn(lifecycle, 'isShuttingDownForPublicStatus').mockReturnValue(true);
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(503);
		expect(response.body.checks).toContainEqual({ name: 'processLifecycle', status: 'fail' });
	});

	it('rechecks drain after asynchronous dependency collection', async () => {
		let draining = false;
		jest.spyOn(lifecycle, 'isShuttingDownForPublicStatus').mockImplementation(() => draining);
		attachReadinessOverrides(app, {
			isFirestoreConfigured: () => true,
			getFirestoreClient: () => ({ listCollections: async () => { draining = true; return []; } }),
			probeAlertReads: async () => true,
			isBotEnabled: () => false,
		});
		expect((await request(app).get('/readyz')).status).toBe(503);
	});

	it('returns a sanitized failure when readiness collection rejects', async () => {
		jest.spyOn(require('../../src/controllers/readiness'), 'collectReadiness')
			.mockRejectedValue(new Error('private provider configuration'));
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(503);
		expect(response.body.checks).toContainEqual({ name: 'dependencies', status: 'fail' });
		expect(JSON.stringify(response.body)).not.toContain('private');
	});

	it('preserves the readiness contract when dependency probes exceed the API deadline', async () => {
		process.env.REQUEST_TIMEOUT_MS = '1000';
		attachReadinessOverrides(app, {
			isFirestoreConfigured: () => true,
			getFirestoreClient: () => ({ listCollections: () => new Promise((resolve) => setTimeout(resolve, 1200)) }),
			probeAlertReads: async () => true,
			isBotEnabled: () => false,
		});
		const response = await request(app).get('/readyz');
		expect(response.status).toBe(200);
		expect(response.body.status).toBe('ready');
		expect(response.body.checks).toContainEqual({ name: 'firestore', status: 'ready' });
	});

	it('preserves legacy response contracts', async () => {
		expect((await request(app).get('/healthcheck')).body).toEqual({ uptime: expect.any(Number) });
		const response = await request(app).get('/ready');
		expect(response.status).toBe(200);
		expect(response.body.components).toBeDefined();
		expect(response.body.checks).toBeUndefined();
	});
});
