/* global jest, describe, it, beforeEach, afterEach, expect, saveEnv, restoreEnv */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');

describe('GET /api/metrics - Process health endpoint', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'false',
			ENABLE_FIREBASE_ADMIN_AUTH: 'false',
		});
		jest.clearAllMocks();
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	it('returns 401 without an API key when WEBHOOK_API_KEY is configured', async () => {
		const res = await request(app).get('/api/metrics');
		expect(res.status).toBe(401);
		expect(res.body).toHaveProperty('error');
	});

	it('returns 403 with an invalid API key when WEBHOOK_API_KEY is configured', async () => {
		const res = await request(app)
			.get('/api/metrics')
			.set('x-api-key', 'definitely-not-the-key');
		expect(res.status).toBe(403);
		expect(res.body).toHaveProperty('error');
	});

	it('returns a process snapshot when the API key is valid', async () => {
		const res = await request(app)
			.get('/api/metrics')
			.set('x-api-key', 'test-key');

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);

		// Memory snapshot
		expect(res.body.memory).toBeTruthy();
		expect(res.body.memory).toHaveProperty('rss');
		expect(res.body.memory).toHaveProperty('heapUsed');
		expect(res.body.memory).toHaveProperty('heapTotal');
		expect(res.body.memory).toHaveProperty('external');
		expect(res.body.memory).toHaveProperty('arrayBuffers');
		expect(res.body.memory.rss).toBeGreaterThan(0);

		// CPU snapshot
		expect(res.body.cpu).toBeTruthy();
		expect(res.body.cpu).toHaveProperty('user');
		expect(res.body.cpu).toHaveProperty('system');
		expect(typeof res.body.cpu.user).toBe('number');
		expect(typeof res.body.cpu.system).toBe('number');

		// Event-loop probe
		expect(res.body.eventLoop).toBeTruthy();
		expect(res.body.eventLoop).toHaveProperty('lagMs');
		expect(res.body.eventLoop).toHaveProperty('maxLagMs');
		expect(res.body.eventLoop).toHaveProperty('samples');
		expect(res.body.eventLoop.samples).toBeGreaterThanOrEqual(0);

		// Process metadata
		expect(res.body.process).toBeTruthy();
		expect(res.body.process.pid).toBe(process.pid);
		expect(res.body.process.nodeVersion).toBe(process.version);

		// Uptime and node
		expect(typeof res.body.uptime === 'number' || res.body.uptime === null).toBe(true);
		expect(res.body.node).toBe(process.version);
	});

	it('accepts the api-key query parameter as a legacy fallback', async () => {
		const res = await request(app).get('/api/metrics?api-key=test-key');
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
	});
});
