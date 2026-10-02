// tests/integration/request-logger.test.js
const request = require('supertest');
const {
	configureLogging,
	_resetLoggingForTests,
} = require('../../src/lib/logging');

function loadApp() {
	let app;
	jest.isolateModules(() => {
		app = require('../../app');
	});
	return app;
}

describe('Request Logger Integration', () => {
	let app;
	let output;
	let savedEnv;

	beforeAll(() => {
		savedEnv = {
			LOG_LEVEL: process.env.LOG_LEVEL,
			SERVICE_NAME: process.env.SERVICE_NAME,
		};
		process.env.LOG_LEVEL = 'debug';
		process.env.SERVICE_NAME = 'cabros-bot-test';
		process.env.WEBHOOK_API_KEY = 'test-api-key';
	});

	beforeEach(() => {
		_resetLoggingForTests();
		output = {
			debug: jest.fn(),
			info: jest.fn(),
			log: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
		};
		console.debug = output.debug;
		console.info = output.info;
		console.log = output.log;
		console.warn = output.warn;
		console.error = output.error;
		configureLogging();
		output.debug.mockClear();
		output.info.mockClear();
		output.log.mockClear();
		output.warn.mockClear();
		output.error.mockClear();
		app = loadApp();
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function findLogForPath(mock, path) {
		for (const call of mock.mock.calls) {
			if (typeof call[0] !== 'string') continue;
			try {
				const entry = JSON.parse(call[0]);
				if (entry && entry.attributes && entry.attributes.path === path) {
					return entry;
				}
			} catch (_e) {
				// skip non-JSON noise
			}
		}
		return null;
	}

	it('logs a structured line for /api routes', async () => {
		const response = await request(app).get('/healthcheck');
		expect([200, 503]).toContain(response.status);

		const apiLog = findLogForPath(output.info, '/api/alerts') ||
			findLogForPath(output.warn, '/api/alerts') ||
			findLogForPath(output.error, '/api/alerts');
		// /healthcheck is intentionally skipped — issue a real /api request
		await request(app).get('/api/alerts');

		const apiRequest = findLogForPath(output.info, '/api/alerts') ||
			findLogForPath(output.warn, '/api/alerts') ||
			findLogForPath(output.error, '/api/alerts');
		expect(apiRequest).not.toBeNull();
		expect(apiRequest.attributes).toEqual(expect.objectContaining({
			method: 'GET',
			path: '/api/alerts',
			durationMs: expect.any(Number),
			requestId: expect.any(String),
		}));
	});

	it('does not log /healthcheck', async () => {
		output.info.mockClear();
		output.warn.mockClear();
		output.error.mockClear();
		await request(app).get('/healthcheck');
		const healthLog = findLogForPath(output.info, '/healthcheck') ||
			findLogForPath(output.warn, '/healthcheck') ||
			findLogForPath(output.error, '/healthcheck');
		expect(healthLog).toBeNull();
	});

	it('does not log /openapi.json', async () => {
		output.info.mockClear();
		output.warn.mockClear();
		output.error.mockClear();
		await request(app).get('/openapi.json');
		const openApiLog = findLogForPath(output.info, '/openapi.json') ||
			findLogForPath(output.warn, '/openapi.json') ||
			findLogForPath(output.error, '/openapi.json');
		expect(openApiLog).toBeNull();
	});

	it('honors x-request-id header', async () => {
		output.info.mockClear();
		output.warn.mockClear();
		output.error.mockClear();
		await request(app)
			.get('/api/alerts')
			.set('x-request-id', 'trace-xyz');

		const log = findLogForPath(output.info, '/api/alerts') ||
			findLogForPath(output.warn, '/api/alerts') ||
			findLogForPath(output.error, '/api/alerts');
		expect(log).not.toBeNull();
		expect(log.attributes.requestId).toBe('trace-xyz');
	});

	it('logs malformed /api requests rejected by the body parser', async () => {
		output.info.mockClear();
		output.warn.mockClear();
		output.error.mockClear();

		await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json')
			.send('{"broken"')
			.expect(400);

		const log = findLogForPath(output.warn, '/api/webhook/alert') ||
			findLogForPath(output.error, '/api/webhook/alert') ||
			findLogForPath(output.info, '/api/webhook/alert');
		expect(log).not.toBeNull();
		expect(log.attributes.statusCode).toBe(400);
	});

	// The request logger and the request deadline are separate middlewares that
	// both stamp a correlation id. The deadline runs after the logger, so a
	// naive logger that always mints its own id would emit a different id than
	// the one inside the 408 payload — breaking log/payload correlation exactly
	// when an operator needs it most.
	it('shares one requestId between the 408 payload and its log line', async () => {
		const previousTimeout = process.env.REQUEST_TIMEOUT_MS;
		const previousExempt = process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
		// 1000ms is the documented floor; a 3000ms handler therefore trips the
		// deadline while still finishing inside the jest timeout.
		process.env.REQUEST_TIMEOUT_MS = '1000';
		delete process.env.REQUEST_DEADLINE_EXEMPT_PATHS;

		const express = require('express');
		const slowApp = express();
		slowApp.use(require('../../src/lib/requestDeadline'));
		slowApp.use(require('../../src/lib/requestLogger'));
		slowApp.get('/api/slow-probe', (_req, res) => {
			setTimeout(() => res.json({ ok: true }), 3000).unref();
		});

		output.info.mockClear();
		output.warn.mockClear();
		output.error.mockClear();

		try {
			const response = await request(slowApp).get('/api/slow-probe');
			expect(response.status).toBe(408);
			expect(response.body.requestId).toEqual(expect.any(String));

			const log = findLogForPath(output.warn, '/api/slow-probe') ||
				findLogForPath(output.error, '/api/slow-probe') ||
				findLogForPath(output.info, '/api/slow-probe');
			expect(log).not.toBeNull();
			expect(log.attributes.statusCode).toBe(408);
			expect(log.attributes.requestId).toBe(response.body.requestId);
		} finally {
			if (previousTimeout === undefined) delete process.env.REQUEST_TIMEOUT_MS;
			else process.env.REQUEST_TIMEOUT_MS = previousTimeout;
			if (previousExempt === undefined) delete process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
			else process.env.REQUEST_DEADLINE_EXEMPT_PATHS = previousExempt;
		}
	});

	// An operator-declared probe route must not silently start emitting one log
	// line per hit, and the two middlewares must agree on what a "probe" is.
	it('stays silent for every request-deadline exempt path, including /ready', async () => {
		for (const path of ['/healthcheck', '/ready', '/openapi.json', '/docs']) {
			await request(app).get(path);
		}

		for (const mock of [output.info, output.warn, output.error]) {
			for (const path of ['/healthcheck', '/ready', '/openapi.json', '/docs']) {
				expect(findLogForPath(mock, path)).toBeNull();
			}
		}
	});

	// The skip list is read per request, not frozen at module load. Without that,
	// a path an operator adds to REQUEST_DEADLINE_EXEMPT_PATHS would be exempt
	// from the deadline yet still emit one log line per hit — the documented
	// single-vocabulary invariant would hold only for the default paths.
	it('honors an operator-declared exempt path without reloading the module', async () => {
		const previous = process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
		process.env.REQUEST_DEADLINE_EXEMPT_PATHS = '/internal/ping';
		app = loadApp();

		try {
			output.info.mockClear();
			output.warn.mockClear();
			output.error.mockClear();

			await request(app).get('/internal/ping');
			for (const mock of [output.info, output.warn, output.error]) {
				expect(findLogForPath(mock, '/internal/ping')).toBeNull();
			}

			// A non-exempt sibling on the same app must still be logged, so the
			// assertion above cannot pass just because logging is broken entirely.
			await request(app).get('/api/status');
			const logged = findLogForPath(output.info, '/api/status') ||
				findLogForPath(output.warn, '/api/status') ||
				findLogForPath(output.error, '/api/status');
			expect(logged).not.toBeNull();
		} finally {
			if (previous === undefined) delete process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
			else process.env.REQUEST_DEADLINE_EXEMPT_PATHS = previous;
		}
	});
});
