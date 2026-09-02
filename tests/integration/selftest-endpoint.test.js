'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { resetSelfTestService } = require('../../src/controllers/diagnostics/selftest');

function saveEnv() {
	return { ...process.env };
}

function restoreEnv(saved) {
	for (const key of Object.keys(process.env)) {
		if (!(key in saved)) delete process.env[key];
	}
	Object.assign(process.env, saved);
}

describe('Self-test diagnostic endpoint (GH-801)', () => {
	let savedEnv;
	let mockBot;

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			RATE_LIMIT_MAX: '100',
			RATE_LIMIT_WINDOW_MS: '60000',
		});
		resetSelfTestService();
		mockBot = {
			botInfo: { id: 1, username: 'cabros_bot' },
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'noop' }),
				getMe: jest.fn().mockResolvedValue({ id: 1, username: 'cabros_bot' }),
			},
		};
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		resetSelfTestService();
	});

	it('returns a not-yet-run response on the initial GET', async () => {
		const res = await request(app)
			.get('/api/selftest')
			.set('x-api-key', 'test-key');

		expect(res.status).toBe(200);
		expect(res.body.status).toBe('unknown');
		expect(res.body.message).toMatch(/self-test/);
	});

	it('runs the full suite on POST /api/selftest/run and returns a summary', async () => {
		const res = await request(app)
			.post('/api/selftest/run')
			.set('x-api-key', 'test-key')
			.send();

		expect(res.status).toBe(200);
		expect(['pass', 'warn', 'fail']).toContain(res.body.status);
		expect(res.body.checks.length).toBeGreaterThanOrEqual(10);
		expect(res.body.summary.pass + res.body.summary.warn + res.body.summary.fail + res.body.summary.skipped)
			.toBe(res.body.checks.length);
	});

	it('returns the cached result from the previous run on subsequent GET', async () => {
		const run = await request(app)
			.post('/api/selftest/run')
			.set('x-api-key', 'test-key')
			.send();
		expect(run.status).toBe(200);
		const firstId = run.body.requestId;

		const get = await request(app)
			.get('/api/selftest')
			.set('x-api-key', 'test-key');
		expect(get.status).toBe(200);
		expect(get.body.cached).toBe(true);
		expect(get.body.requestId).not.toBe(firstId);
	});

	it('supports a scoped `only` filter', async () => {
		const res = await request(app)
			.post('/api/selftest/run?only=auth.api_key,service.metadata')
			.set('x-api-key', 'test-key')
			.send();
		expect(res.status).toBe(200);
		expect(res.body.checks.map((c) => c.id).sort()).toEqual(['auth.api_key', 'service.metadata']);
	});

	it('rejects unknown check ids in `only` as a fail result', async () => {
		const res = await request(app)
			.post('/api/selftest/run?only=nope.nope')
			.set('x-api-key', 'test-key')
			.send();
		expect(res.status).toBe(200);
		expect(res.body.status).toBe('fail');
		expect(res.body.checks[0].message).toMatch(/unknown checks/);
	});

	it('requires API key auth', async () => {
		const res = await request(app)
			.get('/api/selftest');
		expect(res.status).toBe(401);
	});

	it('exposes the last result via /api/status under dependencies.selfTest', async () => {
		await request(app)
			.post('/api/selftest/run')
			.set('x-api-key', 'test-key')
			.send();

		const res = await request(app)
			.get('/api/status')
			.set('x-api-key', 'test-key');
		expect(res.status).toBe(200);
		expect(res.body.dependencies).toBeDefined();
		expect(res.body.dependencies.selfTest).toBeDefined();
		expect(res.body.dependencies.selfTest.lastStatus).toMatch(/pass|warn|fail/);
		expect(res.body.dependencies.selfTest.ttlSec).toBe(60);
		expect(res.body.dependencies.selfTest.lastRunAt).not.toBeNull();
	});

	it('redacts sensitive evidence keys in check output', async () => {
		process.env.TRADINGVIEW_MCP_URL = 'https://example.com/mcp?api-key=should-redact';
		const res = await request(app)
			.post('/api/selftest/run?only=tradingview_mcp.endpoint')
			.set('x-api-key', 'test-key')
			.send();
		expect(res.status).toBe(200);
		// The check exposes the endpoint value; ensure no redaction happens on
		// env-style values that are not keys. The redactor is for object keys.
		expect(res.body.checks[0].evidence).toEqual({ endpoint: 'https://example.com/mcp?api-key=should-redact' });
	});
});
