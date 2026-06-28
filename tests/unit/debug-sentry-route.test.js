const express = require('express');
const request = require('supertest');

const { registerDebugSentryRoute } = require('../../src/lib/debugSentryRoute');

function createApp() {
	const app = express();

	registerDebugSentryRoute(app);

	app.use((err, req, res, next) => {
		res.status(500).json({ message: err.message });
	});

	return app;
}

describe('registerDebugSentryRoute', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('returns 404 by default when the debug route is disabled', async () => {
		delete process.env.ENABLE_SENTRY_DEBUG_ROUTE;
		const app = createApp();

		const response = await request(app).get('/debug-sentry').expect(404);

		expect(response.status).toBe(404);
	});

	it('mounts the debug route only when explicitly enabled', async () => {
		process.env.ENABLE_SENTRY_DEBUG_ROUTE = 'true';
		const app = createApp();

		const response = await request(app).get('/debug-sentry').expect(500);

		expect(response.body).toEqual({ message: 'Sentry debug test error!' });
	});
});
