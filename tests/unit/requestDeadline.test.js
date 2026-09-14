// tests/unit/requestDeadline.test.js
const httpMocks = require('node-mocks-http');
const express = require('express');
const request = require('supertest');
const requestDeadline = require('../../src/lib/requestDeadline');

describe('Request Deadline Middleware (unit)', () => {
	const savedEnv = {};
	const envKeys = ['REQUEST_TIMEOUT_MS', 'REQUEST_DEADLINE_EXEMPT_PATHS'];

	beforeEach(() => {
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		requestDeadline.resetForTests();
	});

	afterEach(() => {
		requestDeadline.disableTestMode();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test('passes through exempt paths without setting a timer', () => {
		process.env.REQUEST_TIMEOUT_MS = '5000';
		const req = httpMocks.createRequest({ method: 'GET', url: '/healthcheck' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(res.getHeader('X-Request-Id')).toBeUndefined();
	});

	test('exempts /ready, /openapi.json, /docs by default', () => {
		process.env.REQUEST_TIMEOUT_MS = '5000';
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
		process.env.REQUEST_TIMEOUT_MS = '5000';
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
		process.env.REQUEST_TIMEOUT_MS = '5000';
		const req = httpMocks.createRequest({ method: 'POST', url: '/api/webhook/alert' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(typeof req.requestId).toBe('string');
		expect(req.requestId.length).toBeGreaterThan(8);
		expect(res.getHeader('X-Request-Id')).toBe(req.requestId);
	});

	test('reuses a valid inbound x-request-id before minting a new id', () => {
		process.env.REQUEST_TIMEOUT_MS = '5000';
		const req = httpMocks.createRequest({
			method: 'POST',
			url: '/api/webhook/alert',
			headers: { 'x-request-id': ' inbound-request-42 ' },
		});
		const res = httpMocks.createResponse();
		requestDeadline(req, res, jest.fn());

		expect(req.requestId).toBe('inbound-request-42');
		expect(res.getHeader('X-Request-Id')).toBe('inbound-request-42');
	});

	test('honors REQUEST_DEADLINE_EXEMPT_PATHS additions', () => {
		process.env.REQUEST_TIMEOUT_MS = '1500';
		process.env.REQUEST_DEADLINE_EXEMPT_PATHS = '/api/exempt, /api/special';
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
		process.env.REQUEST_TIMEOUT_MS = '5000';
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

	test('honors programmatic setTestOverrides', () => {
		requestDeadline.setTestOverrides({
			timeoutMs: 4200,
			exemptPaths: new Set(['/api/custom-exempt']),
		});
		const req = httpMocks.createRequest({ method: 'POST', url: '/api/custom-exempt' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(res.getHeader('X-Request-Id')).toBeUndefined();
	});

	test('does not let a late handler write after the timeout response', async () => {
		requestDeadline.setTestOverrides({ timeoutMs: 20 });
		let lateError;
		const app = express();
		app.use(requestDeadline);
		app.get('/api/slow', (req, res) => {
			setTimeout(() => {
				try {
					res.setHeader('X-Late', 'true');
					res.json({ late: true });
				} catch (error) {
					lateError = error;
				}
			}, 50);
		});

		const response = await request(app).get('/api/slow').expect(408);
		await new Promise((resolve) => setTimeout(resolve, 70));

		expect(response.body.code).toBe('REQUEST_TIMEOUT');
		expect(lateError).toBeUndefined();
	});

	test('stops downstream handlers when parsing outlives the deadline', async () => {
		requestDeadline.setTestOverrides({ timeoutMs: 20 });
		let handlerCalled = false;
		const app = express();
		app.use(requestDeadline);
		app.use((req, res, next) => setTimeout(next, 50));
		app.use(requestDeadline.guard);
		app.get('/api/slow', (req, res) => {
			handlerCalled = true;
			res.json({ late: true });
		});

		await request(app).get('/api/slow').expect(408);
		await new Promise((resolve) => setTimeout(resolve, 70));

		expect(handlerCalled).toBe(false);
	});

	test('starts before body parsers in the main app', () => {
		const app = require('../../app');
		const layerNames = app._router.stack.map((layer) => layer.name);
		const deadlineIndex = layerNames.indexOf('requestDeadline');
		const parserIndexes = ['urlencodedParser', 'textParser', 'jsonParser']
			.map((name) => layerNames.indexOf(name));

		expect(deadlineIndex).toBeGreaterThanOrEqual(0);
		expect(parserIndexes.every((index) => index >= 0 && deadlineIndex < index)).toBe(true);
	});

	test('reads REQUEST_TIMEOUT_MS from RemoteConfigService runtimeConfig when available', () => {
		const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
		remoteConfigService._setRemoteOverridesForTesting({ REQUEST_TIMEOUT_MS: 45000 });
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';

		const req = httpMocks.createRequest({ method: 'POST', url: '/api/test' });
		const res = httpMocks.createResponse();
		const next = jest.fn();
		requestDeadline(req, res, next);
		expect(next).toHaveBeenCalled();

		remoteConfigService._resetForTesting();
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
								error: 'Request Timeout',
								code: 'REQUEST_TIMEOUT',
								deadlineMs: 1500,
							});
							expect(typeof parsed.requestId).toBe('string');
				expect(res.headers['x-request-id']).toBe(parsed.requestId);
				expect(typeof parsed.durationMs).toBe('number');
				expect(parsed.durationMs).toBeGreaterThan(0);
				expect(parsed.durationMs).toBeLessThan(5000);
							server.close(() => done());
						} catch (err) {
							server.close(() => done(err));
						}
					});
				},
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
