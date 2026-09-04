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
});
