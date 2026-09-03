/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');

function saveEnv() {
	const snapshot = {};
	for (const key of Object.keys(process.env)) {
		snapshot[key] = process.env[key];
	}
	return snapshot;
}

function restoreEnv(snapshot) {
	for (const key of Object.keys(process.env)) {
		if (!(key in snapshot)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(snapshot)) {
		process.env[key] = value;
	}
}

describe('GET /api/demo/* - Demo mode endpoints (GH-802)', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'demo-key',
			ENABLE_DEMO_MODE: 'true',
		});
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		jest.clearAllMocks();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('when ENABLE_DEMO_MODE is disabled', () => {
		it('returns 404 FEATURE_DISABLED for /api/demo/alert', async () => {
			process.env.ENABLE_DEMO_MODE = 'false';
			const res = await request(app)
				.get('/api/demo/alert?text=preview')
				.set('x-api-key', 'demo-key');
			expect(res.status).toBe(404);
			expect(res.body).toMatchObject({ error: 'FEATURE_DISABLED' });
		});

		it('returns 404 FEATURE_DISABLED for /api/demo/outcomes', async () => {
			process.env.ENABLE_DEMO_MODE = 'false';
			const res = await request(app)
				.get('/api/demo/outcomes')
				.set('x-api-key', 'demo-key');
			expect(res.status).toBe(404);
		});

		it('returns 404 FEATURE_DISABLED for /api/demo/scanner', async () => {
			process.env.ENABLE_DEMO_MODE = 'false';
			const res = await request(app)
				.get('/api/demo/scanner')
				.set('x-api-key', 'demo-key');
			expect(res.status).toBe(404);
		});
	});

	describe('when ENABLE_DEMO_MODE is enabled', () => {
		it('returns a synthetic alert with demo meta', async () => {
			const res = await request(app)
				.get('/api/demo/alert?text=hello&channels=telegram')
				.set('x-api-key', 'demo-key');
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				success: true,
				meta: expect.objectContaining({ demo: true, synthetic: true }),
				alert: expect.objectContaining({ source: 'demo', text: 'hello' }),
			});
			expect(res.body.alert.delivery.results[0]).toMatchObject({ channel: 'telegram', demo: true });
		});

		it('rejects unauthenticated requests', async () => {
			const res = await request(app).get('/api/demo/alert');
			expect(res.status).toBe(401);
			expect(res.body).toMatchObject({ error: 'Unauthorized: Missing API key' });
		});

		it('returns synthetic outcomes for a query symbol', async () => {
			const res = await request(app)
				.get('/api/demo/outcomes?symbol=BINANCE:ETHUSDT')
				.set('x-api-key', 'demo-key');
			expect(res.status).toBe(200);
			expect(res.body.outcomes.symbol).toBe('BINANCE:ETHUSDT');
			expect(res.body.outcomes.windows).toHaveLength(4);
		});

		it('returns synthetic scanner output for a query exchange', async () => {
			const res = await request(app)
				.get('/api/demo/scanner?exchange=nasdaq')
				.set('x-api-key', 'demo-key');
			expect(res.status).toBe(200);
			expect(res.body.scanner.exchange).toBe('NASDAQ');
			expect(res.body.scanner.items.length).toBeGreaterThan(0);
		});

		it('exposes demo feature flag on /api/status', async () => {
			const res = await request(app)
				.get('/api/status')
				.set('x-api-key', 'demo-key');
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				featureFlags: expect.objectContaining({ demoMode: true }),
				dependencies: expect.objectContaining({
					demo: expect.objectContaining({ enabled: true, status: 'ready' }),
				}),
			});
		});
	});
});