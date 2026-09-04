// tests/unit/requestDeadline.test.js
const httpMocks = require('node-mocks-http');
const express = require('express');
const request = require('supertest');
const requestDeadline = require('../../src/lib/requestDeadline');

describe('Request Deadline Middleware (unit)', () => {
	const savedEnv = {};
	const envKeys = ['REQUEST_TIMEOUT_MS', 'REQUEST_DEADLINE_EXEMPT_PATHS', 'REQUEST_TIMEOUT_MS_TEST', 'REQUEST_DEADLINE_EXEMPT_PATHS_TEST'];

	beforeEach(() => {
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		requestDeadline.resetForTests();
		requestDeadline.enableTestMode();
	});

	afterEach(() => {
		requestDeadline.disableTestMode();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test('passes through exempt paths without setting a timer', () => {
		process.env.REQUEST_TIMEOUT_MS_TEST = '5000';
		const req = httpMocks.createRequest({ method: 'GET', url: '/healthcheck' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(res.getHeader('X-Request-Id')).toBeUndefined();
	});

	test('exempts /ready, /openapi.json, /docs by default', () => {
		process.env.REQUEST_TIMEOUT_MS_TEST = '5000';
		for (const path of ['/ready', '/openapi.json', '/docs']) {
			const req = httpMocks.createRequest({ method: 'GET', url: path });
			const res = httpMocks.createResponse();
			const next = jest.fn();
			requestDeadline(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.getHeader('X-Request-Id')).toBeUndefined();
		}
	});

	test('reuses req.requestId stamped upstream and exposes X-Request-Id', () => {
		process.env.REQUEST_TIMEOUT_MS_TEST = '5000';
		const req = httpMocks.createRequest({ method: 'POST', url: '/api/webhook/alert' });
		req.requestId = 'preset-request-id';
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(req.requestId).toBe('preset-request-id');
		expect(res.getHeader('X-Request-Id')).toBe('preset-request-id');
	});

	test('mints a request id when none is provided', () => {
		process.env.REQUEST_TIMEOUT_MS_TEST = '5000';
		const req = httpMocks.createRequest({ method: 'POST', url: '/api/webhook/alert' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(typeof req.requestId).toBe('string');
		expect(req.requestId.length).toBeGreaterThan(8);
		expect(res.getHeader('X-Request-Id')).toBe(req.requestId);
	});

	test('honors REQUEST_DEADLINE_EXEMPT_PATHS additions', () => {
		process.env.REQUEST_TIMEOUT_MS_TEST = '1500';
		process.env.REQUEST_DEADLINE_EXEMPT_PATHS_TEST = '/api/exempt, /api/special';
		const req = httpMocks.createRequest({ method: 'POST', url: '/api/exempt' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(res.getHeader('X-Request-Id')).toBeUndefined();
	});

	test('exposes documented bounds via constants export', () => {
		const { constants } = requestDeadline;
		expect(constants.DEFAULT_TIMEOUT_MS).toBe(30000);
		expect(constants.MIN_TIMEOUT_MS).toBe(1000);
		expect(constants.MAX_TIMEOUT_MS).toBe(120000);
		expect(constants.DEFAULT_EXEMPT_PATHS.has('/healthcheck')).toBe(true);
		expect(constants.DEFAULT_EXEMPT_PATHS.has('/ready')).toBe(true);
		expect(constants.DEFAULT_EXEMPT_PATHS.has('/openapi.json')).toBe(true);
		expect(constants.DEFAULT_EXEMPT_PATHS.has('/docs')).toBe(true);
	});

	test('falls back to default when REQUEST_TIMEOUT_MS is below MIN_TIMEOUT_MS', () => {
		requestDeadline.disableTestMode();
		process.env.REQUEST_TIMEOUT_MS = '50';
		requestDeadline.resetForTests();
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const req = httpMocks.createRequest({ method: 'POST', url: '/api/webhook/alert' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		delete process.env.REQUEST_TIMEOUT_MS;
		requestDeadline.resetForTests();
	});

	test('falls back to default when REQUEST_TIMEOUT_MS is non-numeric', () => {
		requestDeadline.disableTestMode();
		process.env.REQUEST_TIMEOUT_MS = 'abc';
		requestDeadline.resetForTests();
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const req = httpMocks.createRequest({ method: 'POST', url: '/api/webhook/alert' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		delete process.env.REQUEST_TIMEOUT_MS;
		requestDeadline.resetForTests();
	});

	test('normalizes path with query strings and lowercase', () => {
		process.env.REQUEST_TIMEOUT_MS_TEST = '5000';
		const req = httpMocks.createRequest({
			method: 'GET',
			url: '/HealthCheck?probe=1',
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(res.getHeader('X-Request-Id')).toBeUndefined();
	});
});

describe('Request Deadline Middleware (supertest)', () => {
	const savedEnv = {};

	beforeEach(() => {
		for (const key of ['REQUEST_TIMEOUT_MS', 'REQUEST_DEADLINE_EXEMPT_PATHS']) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function buildApp(timeoutMs) {
		process.env.REQUEST_TIMEOUT_MS = String(timeoutMs);
		const app = express();
		app.use(requestDeadline);
		app.post('/api/slow', (req, res) => {
			// never respond within the deadline
		});
		app.post('/api/fast', (req, res) => {
			res.status(200).json({ ok: true });
		});
		return app;
	}

	test('returns 408 REQUEST_TIMEOUT when handler exceeds deadline', (done) => {
		const app = buildApp(1500);
		const server = app.listen(0, () => {
			const { port } = server.address();
			const http = require('http');
			const start = Date.now();
			const req = http.request(
				{
					host: '127.0.0.1',
					port,
					path: '/api/slow',
					method: 'POST',
					headers: { 'content-length': '0' },
				},
				(res) => {
					let body = '';
					res.on('data', (chunk) => (body += chunk));
					res.on('end', () => {
						try {
							expect(res.statusCode).toBe(408);
							const parsed = JSON.parse(body);
							expect(parsed).toMatchObject({
								error: 'Request timeout exceeded',
								code: 'REQUEST_TIMEOUT',
								deadlineMs: 1500,
							});
							expect(typeof parsed.requestId).toBe('string');
							expect(res.headers['x-request-id']).toBe(parsed.requestId);
							expect(typeof parsed.durationMs).toBe('number');
							expect(parsed.durationMs).toBeGreaterThanOrEqual(1500);
							expect(parsed.durationMs).toBeLessThan(5000);
							server.close(() => done());
						} catch (err) {
							server.close(() => done(err));
						}
					});
				}
			);
			req.on('error', (err) => {
				server.close(() => done(err));
			});
			req.end();
		});
	});

	test('does not enforce deadline on /healthcheck even with low timeout', async () => {
		process.env.REQUEST_TIMEOUT_MS = '1000';
		const app = express();
		app.get('/healthcheck', (req, res) => res.json({ ok: true }));
		app.use(requestDeadline);
		const response = await request(app).get('/healthcheck').expect(200);
		expect(response.body).toEqual({ ok: true });
	});

	test('allows fast handlers to finish before deadline', async () => {
		const app = buildApp(2000);
		const response = await request(app).post('/api/fast').expect(200);
		expect(response.body).toEqual({ ok: true });
		expect(response.headers['x-request-id']).toBeDefined();
	});

	test('emits x-request-id header on successful response', async () => {
		const app = buildApp(2000);
		const response = await request(app).post('/api/fast').expect(200);
		expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{8,}/i);
	});

	test('uses REQUEST_DEADLINE_EXEMPT_PATHS to opt specific routes out', async () => {
		process.env.REQUEST_TIMEOUT_MS = '1500';
		process.env.REQUEST_DEADLINE_EXEMPT_PATHS = '/api/exempt';
		const app = express();
		app.use(requestDeadline);
		app.post('/api/exempt', (req, res) => {
			setTimeout(() => res.json({ ok: true }), 100).unref();
		});
		const response = await request(app).post('/api/exempt').expect(200);
		expect(response.body).toEqual({ ok: true });
	});
});
