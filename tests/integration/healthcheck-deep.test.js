const request = require('supertest');
const express = require('express');
const { getDeepHealthcheckHandler } = require('../../src/controllers/healthcheck');

function buildApp() {
	const app = express();
	app.use(getDeepHealthcheckHandler());
	return app;
}

function mockStatus(overrides = {}) {
	const mod = require('../../src/controllers/status');
	const original = mod.getStatus;
	const telegram = overrides.telegram || { ready: true, enabled: false, configured: false, status: 'disabled' };
	const whatsapp = overrides.whatsapp || { ready: true, enabled: false, configured: false, status: 'disabled' };
	const discord = overrides.discord || { ready: true, enabled: false, configured: false, status: 'disabled' };
	mod.getStatus = () => ({
		dependencies: { telegram, whatsapp, discord },
	});
	return () => {
		mod.getStatus = original;
	};
}

describe('GET /healthcheck deep-readiness endpoint', () => {
	let restore;

	afterEach(() => {
		if (restore) {
			restore();
			restore = undefined;
		}
	});

	it('returns 200 with uptime JSON when no channels are enabled (default behavior)', async () => {
		const app = buildApp();
		restore = mockStatus();

		const res = await request(app).get('/healthcheck');
		expect(res.status).toBe(200);
		expect(res.body).toEqual(expect.objectContaining({ uptime: expect.any(Number) }));
	});

	it('returns 200 with status=healthy and channel readiness when all enabled channels are ready', async () => {
		const app = buildApp();
		restore = mockStatus({
			telegram: { ready: true, enabled: true, configured: true, status: 'ready' },
		});

		const res = await request(app).get('/healthcheck?deep=true');
		expect(res.status).toBe(200);
		expect(res.body.status).toBe('healthy');
		expect(res.body).toHaveProperty('uptime');
		expect(res.body.channels).toEqual(
			expect.objectContaining({
				telegram: expect.objectContaining({ status: 'ready', ready: true }),
			}),
		);
	});

	it('returns 503 with status=degraded when any enabled channel reports an error', async () => {
		const app = buildApp();
		restore = mockStatus({
			telegram: {
				ready: false,
				enabled: true,
				configured: true,
				status: 'error',
				error: 'Missing BOT_TOKEN',
			},
		});

		const res = await request(app).get('/healthcheck?deep=true');
		expect(res.status).toBe(503);
		expect(res.body.status).toBe('degraded');
		expect(res.body.channels.telegram).toEqual(
			expect.objectContaining({ status: 'error', ready: false }),
		);
	});

	it('does not require an API key (no auth-gated path)', async () => {
		const app = buildApp();
		restore = mockStatus({
			whatsapp: {
				ready: false,
				enabled: true,
				configured: true,
				status: 'error',
			},
		});

		const res = await request(app)
			.get('/healthcheck?deep=true')
			.set('x-api-key', 'should-be-ignored');
		expect(res.status).toBe(503);
		expect(res.body.status).toBe('degraded');
	});

	it('treats disabled channels as healthy (they are not required)', async () => {
		const app = buildApp();
		restore = mockStatus({
			discord: { ready: true, enabled: false, configured: false, status: 'disabled' },
		});

		const res = await request(app).get('/healthcheck?deep=true');
		expect(res.status).toBe(200);
		expect(res.body.status).toBe('healthy');
	});

	it('returns 503 when any one of multiple enabled channels is degraded', async () => {
		const app = buildApp();
		restore = mockStatus({
			telegram: { ready: true, enabled: true, configured: true, status: 'ready' },
			whatsapp: { ready: false, enabled: true, configured: true, status: 'error' },
			discord: { ready: true, enabled: false, configured: false, status: 'disabled' },
		});

		const res = await request(app).get('/healthcheck?deep=true');
		expect(res.status).toBe(503);
		expect(res.body.status).toBe('degraded');
		expect(res.body.channels.whatsapp.status).toBe('error');
	});
});