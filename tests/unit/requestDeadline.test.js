// tests/unit/requestDeadline.test.js
'use strict';

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const sentryService = require('../../src/services/monitoring/SentryService');
const requestDeadline = require('../../src/lib/requestDeadline');

function saveEnv() {
	const snapshot = {};
	for (const key of [
		'API_REQUEST_DEADLINE_MS',
		'API_REQUEST_DEADLINE_EXEMPT_PATHS',
	]) {
		snapshot[key] = process.env[key];
	}
	return snapshot;
}

function restoreEnv(snapshot) {
	for (const key of Object.keys(snapshot)) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key];
	}
}

function buildApp(handler, middlewareOptions = {}) {
	const app = express();
	app.use(requestDeadline(middlewareOptions));
	app.get('/api/test', handler);
	app.get('/api/slow', handler);
	app.get('/healthcheck', (req, res) => res.status(200).json({ ok: true }));
	app.get('/docs', (req, res) => res.status(200).send('<html>docs</html>'));
	return app;
}

// Handler that intentionally never responds. The middleware should always win
// and the test should observe the deadline response.
const NEVER_RESPOND = () => {
	// intentionally empty
};

describe('Request Deadline Middleware', () => {
	let snapshot;

	beforeEach(() => {
		snapshot = saveEnv();
		delete process.env.API_REQUEST_DEADLINE_MS;
		delete process.env.API_REQUEST_DEADLINE_EXEMPT_PATHS;
		sentryService.captureRuntimeError.mockReset();
		requestDeadline.clearInvalidConfigCache();
		requestDeadline.resetActiveTimers();
	});

	afterEach(() => {
		restoreEnv(snapshot);
	});

	test('passes through when the handler responds before the deadline', async () => {
		const app = buildApp((req, res) => res.status(200).json({ ok: true }));
		const response = await request(app).get('/api/test');
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ ok: true });
		expect(response.headers['x-request-id']).toMatch(/[0-9a-f-]{8,}/i);
	});

	test('returns 504 REQUEST_DEADLINE_EXCEEDED when the handler exceeds the deadline', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = buildApp(NEVER_RESPOND);
		const response = await request(app).get('/api/slow');
		expect(response.status).toBe(504);
		expect(response.body.code).toBe('REQUEST_DEADLINE_EXCEEDED');
		expect(response.body.error).toMatch(/deadline/i);
		expect(response.body.requestId).toBe(response.headers['x-request-id']);
		expect(response.body.deadlineMs).toBe(1500);
		expect(response.body.durationMs).toBeGreaterThanOrEqual(0);
		expect(sentryService.captureRuntimeError).toHaveBeenCalledTimes(1);
		const [payload] = sentryService.captureRuntimeError.mock.calls[0];
		expect(payload.feature).toBe('api-request-deadline');
		expect(payload.http.method).toBe('GET');
		expect(payload.extra.deadlineMs).toBe(1500);
	});

	test('does not deadline exempt paths', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = buildApp((req, res) => res.status(200).json({ ok: true }));
		const response = await request(app).get('/healthcheck');
		expect(response.status).toBe(200);
	});

	test('does not deadline /docs', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = buildApp((req, res) => res.status(200).send('<html>docs</html>'));
		const response = await request(app).get('/docs');
		expect(response.status).toBe(200);
	});

	test('honors X-Cabros-Request-Deadline-Ms header within bounds', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '3000';
		const app = buildApp(NEVER_RESPOND);
		const response = await request(app)
			.get('/api/slow')
			.set('X-Cabros-Request-Deadline-Ms', '1500');
		expect(response.status).toBe(504);
		expect(response.body.deadlineMs).toBe(1500);
	});

	test('clamps X-Cabros-Request-Deadline-Ms header below minimum to 1000', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '3000';
		const app = buildApp(NEVER_RESPOND);
		const response = await request(app)
			.get('/api/slow')
			.set('X-Cabros-Request-Deadline-Ms', '50');
		expect(response.status).toBe(504);
		expect(response.body.deadlineMs).toBe(1000);
	});

	test('clamps X-Cabros-Request-Deadline-Ms header above hard cap to 600000', () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = buildApp(NEVER_RESPOND);
		const middleware = requestDeadline();
		const req = {
			headers: { 'x-cabros-request-deadline-ms': '999999' },
			url: '/api/slow',
			originalUrl: '/api/slow',
			path: '/api/slow',
		};
		const res = {
			setHeader: jest.fn(),
			writableEnded: false,
			headersSent: false,
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
			once: jest.fn(),
			locals: {},
		};
		middleware(req, res, jest.fn());
		expect(req.apiRequestDeadline.deadlineMs).toBe(600000);
		expect(req.apiRequestDeadline.headerDeadlineMs).toBe(999999);
	});

	test('falls back to default deadline when env value is invalid', () => {
		process.env.API_REQUEST_DEADLINE_MS = 'not-a-number';
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const status = requestDeadline.getStatus();
			expect(status.defaultMs).toBe(120000);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('getStatus returns enabled, defaultMs, hardCapMs, minMs, activeTimers, and exempt paths', () => {
		process.env.API_REQUEST_DEADLINE_MS = '30000';
		const status = requestDeadline.getStatus();
		expect(status.enabled).toBe(true);
		expect(status.defaultMs).toBe(30000);
		expect(status.hardCapMs).toBe(600000);
		expect(status.minMs).toBe(1000);
		expect(status.activeTimers).toBe(0);
		expect(status.exemptPaths).toEqual(expect.arrayContaining(['/healthcheck', '/ready', '/openapi.json', '/docs']));
	});

	test('API_REQUEST_DEADLINE_EXEMPT_PATHS extends the exempt path list', () => {
		process.env.API_REQUEST_DEADLINE_EXEMPT_PATHS = '/api/slow,/healthcheck';
		const status = requestDeadline.getStatus();
		expect(status.exemptPaths).toEqual(expect.arrayContaining(['/api/slow']));
	});

	test('survives Sentry failures and still sends the 504 response', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		sentryService.captureRuntimeError.mockImplementation(() => {
			throw new Error('sentry-down');
		});
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const app = buildApp(NEVER_RESPOND);
			const response = await request(app).get('/api/slow');
			expect(response.status).toBe(504);
			expect(response.body.code).toBe('REQUEST_DEADLINE_EXCEEDED');
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('wraps an existing innerCode with REQUEST_DEADLINE_EXCEEDED', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '1500';
		const app = express();
		app.use(requestDeadline());
		app.use((req, res, next) => {
			res.locals.innerCode = 'EXPANDED_ANALYSIS_ALERT_TIMEOUT';
			next();
		});
		app.get('/api/test', NEVER_RESPOND);
		const response = await request(app).get('/api/test');
		expect(response.status).toBe(504);
		expect(response.body.code).toBe('REQUEST_DEADLINE_EXCEEDED');
		expect(response.body.innerCode).toBe('EXPANDED_ANALYSIS_ALERT_TIMEOUT');
	});

	test('reuses the X-Request-Id header value when supplied by the caller', async () => {
		const app = buildApp((req, res) => res.status(200).json({ ok: true }));
		const response = await request(app)
			.get('/api/test')
			.set('X-Request-Id', 'caller-supplied-id-123');
		expect(response.headers['x-request-id']).toBe('caller-supplied-id-123');
	});

	test('decrements activeTimers when response finishes', async () => {
		process.env.API_REQUEST_DEADLINE_MS = '60000';
		const app = buildApp((req, res) => res.status(200).json({ ok: true }));
		await request(app).get('/api/test');
		expect(requestDeadline.getStatus().activeTimers).toBe(0);
	});

	test('disabled middleware short-circuits without setting deadline metadata', () => {
		const middleware = requestDeadline({ enabled: false });
		const req = { headers: {}, url: '/api/test' };
		const res = { setHeader: jest.fn(), once: jest.fn() };
		const next = jest.fn();
		middleware(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(req.apiRequestDeadline).toBeNull();
	});

	test('clamps API_REQUEST_DEADLINE_MS below minimum to 1000', () => {
		process.env.API_REQUEST_DEADLINE_MS = '500';
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const status = requestDeadline.getStatus();
			expect(status.defaultMs).toBe(1000);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('clamps API_REQUEST_DEADLINE_MS above hard cap to 600000', () => {
		process.env.API_REQUEST_DEADLINE_MS = '999999';
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const status = requestDeadline.getStatus();
			expect(status.defaultMs).toBe(600000);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});
