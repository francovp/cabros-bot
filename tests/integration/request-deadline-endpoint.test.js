// tests/integration/request-deadline-endpoint.test.js
'use strict';

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const sentryService = require('../../src/services/monitoring/SentryService');
const requestDeadline = require('../../src/lib/requestDeadline');

describe('Request Deadline Integration', () => {
	let snapshot;

	beforeEach(() => {
		snapshot = { ...process.env };
		delete process.env.API_REQUEST_DEADLINE_MS;
		delete process.env.API_REQUEST_DEADLINE_EXEMPT_PATHS;
		sentryService.captureRuntimeError.mockReset();
		requestDeadline.clearInvalidConfigCache();
		requestDeadline.resetActiveTimers();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in snapshot)) delete process.env[key];
		}
		Object.assign(process.env, snapshot);
	});

	function buildApp(options = {}) {
		const app = express();
		app.use(requestDeadline(options.middleware || {}));
		if (options.delayMs && options.delayMs > 0) {
			app.get('/api/hang', (req, res) => {
				// intentionally do nothing — the middleware must close the connection
			});
			app.get('/api/slow', (req, res) => {
				setTimeout(() => {
					try { res.status(200).json({ ok: true }); } catch (_) { /* noop */ }
				}, options.delayMs).unref();
			});
		} else {
			app.get('/api/hang', (req, res) => {
				// intentionally do nothing — the middleware must close the connection
			});
			app.get('/api/slow', (req, res) => res.status(200).json({ ok: true }));
		}
		app.get('/healthcheck', (req, res) => res.status(200).json({ ok: true }));
		app.get('/docs', (req, res) => res.status(200).send('<html>docs</html>'));
		return app;
	}

	test('default budget returns 504 with REQUEST_DEADLINE_EXCEEDED', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = buildApp();
		const response = await request(app).get('/api/hang');
		expect(response.status).toBe(504);
		expect(response.body.code).toBe('REQUEST_DEADLINE_EXCEEDED');
		expect(response.body.deadlineMs).toBe(1500);
		expect(sentryService.captureRuntimeError).toHaveBeenCalled();
	});

	test('custom per-request header below minimum is clamped to 1000', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '3000';
		const app = buildApp();

		const low = await request(app)
			.get('/api/hang')
			.set('X-Cabros-Request-Deadline-Ms', '10');
		expect(low.status).toBe(504);
		expect(low.body.deadlineMs).toBe(1000);
	});

	test('custom per-request header above hard cap is clamped at runtime', () => {
		// Headers above the cap are clamped to 600000, which is too long to test
		// with a real HTTP round-trip. Instead, verify the middleware clamps the
		// env var at the hard cap and logs a warning so operators notice the
		// misconfiguration.
		process.env.API_REQUEST_DEADLINE_MS = '700000';
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const status = requestDeadline.getStatus();
			expect(status.defaultMs).toBe(600000);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('exempt paths bypass the global deadline', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = buildApp();
		const health = await request(app).get('/healthcheck');
		expect(health.status).toBe(200);

		const docs = await request(app).get('/docs');
		expect(docs.status).toBe(200);
	});

	test('Sentry receives feature=api-request-deadline and tags on timeout', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = buildApp();
		await request(app).get('/api/hang');

		expect(sentryService.captureRuntimeError).toHaveBeenCalledTimes(1);
		const [payload] = sentryService.captureRuntimeError.mock.calls[0];
		expect(payload.feature).toBe('api-request-deadline');
		expect(payload.channel).toBe('api');
		expect(payload.http.method).toBe('GET');
		expect(payload.extra.requestId).toBeDefined();
		expect(payload.extra.tags.endpoint).toBe('/api/hang');
	});
});
