// tests/unit/requestLogger.test.js
const httpMocks = require('node-mocks-http');
const requestLogger = require('../../src/lib/requestLogger');
const {
	configureLogging,
	_resetLoggingForTests,
} = require('../../src/lib/logging');

const {
	createRequestLogger,
	resetRequestLoggerForTests,
} = requestLogger;

describe('Request Logger Middleware', () => {
	let output;
	let savedEnv;

	beforeEach(() => {
		savedEnv = {
			LOG_LEVEL: process.env.LOG_LEVEL,
			SERVICE_NAME: process.env.SERVICE_NAME,
		};
		process.env.LOG_LEVEL = 'debug';
		process.env.SERVICE_NAME = 'cabros-bot-test';

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
	});

	afterEach(() => {
		_resetLoggingForTests();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function parseLast(callMock) {
		const call = callMock.mock.calls[callMock.mock.calls.length - 1];
		expect(call).toBeDefined();
		expect(Array.isArray(call)).toBe(true);
		expect(call.length).toBeGreaterThanOrEqual(1);
		return JSON.parse(call[0]);
	}

	function buildReq(overrides = {}) {
		return httpMocks.createRequest({
			method: overrides.method || 'GET',
			url: overrides.url || '/api/test',
			ip: overrides.ip || '127.0.0.1',
			headers: overrides.headers || {},
		});
	}

	function buildRes() {
		const res = httpMocks.createResponse();
		res.on = jest.fn((event, cb) => {
			if (event === 'finish') res._finishCb = cb;
			if (event === 'close') res._closeCb = cb;
			return res;
		});
		return res;
	}

	function triggerFinish(res) {
		if (typeof res._finishCb === 'function') res._finishCb();
	}

	it('emits an info log with method, path, statusCode, durationMs and requestId', () => {
		const middleware = createRequestLogger();
		const req = buildReq({ headers: { 'x-request-id': 'req-abc' } });
		const res = buildRes();

		middleware(req, res, jest.fn());
		res.statusCode = 200;
		triggerFinish(res);

		const log = parseLast(output.info);
		expect(log.level).toBe('info');
		expect(log.message).toBe('Request completed');
		expect(log.attributes).toEqual(expect.objectContaining({
			method: 'GET',
			path: '/api/test',
			statusCode: 200,
			requestId: 'req-abc',
			durationMs: expect.any(Number),
		}));
		expect(log.attributes.durationMs).toBeGreaterThanOrEqual(0);
		expect(req.requestId).toBe('req-abc');
	});

	it('emits one log when finish and close both fire', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		middleware(req, res, jest.fn());
		res.statusCode = 200;
		triggerFinish(res);
		res._closeCb();

		expect(output.info).toHaveBeenCalledTimes(1);
	});

	it('skips /healthcheck and /openapi.json paths', () => {
		const middleware = createRequestLogger();
		for (const path of ['/healthcheck', '/openapi.json', '/healthcheck/', '/openapi.json?foo=bar']) {
			const req = buildReq({ url: path });
			const res = buildRes();
			middleware(req, res, jest.fn());
			res.statusCode = 200;
			triggerFinish(res);
		}
		expect(output.info).not.toHaveBeenCalled();
		expect(output.warn).not.toHaveBeenCalled();
		expect(output.error).not.toHaveBeenCalled();
	});

	it('uses warn level for 4xx status codes', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		middleware(req, res, jest.fn());
		res.statusCode = 404;
		triggerFinish(res);

		expect(output.warn).toHaveBeenCalled();
		const log = parseLast(output.warn);
		expect(log.level).toBe('warn');
		expect(log.attributes.statusCode).toBe(404);
	});

	it('uses error level for 5xx status codes', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		middleware(req, res, jest.fn());
		res.statusCode = 500;
		triggerFinish(res);

		expect(output.error).toHaveBeenCalled();
		const log = parseLast(output.error);
		expect(log.level).toBe('error');
		expect(log.attributes.statusCode).toBe(500);
	});

	it('generates a UUID requestId when header is missing', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		middleware(req, res, jest.fn());
		res.statusCode = 200;
		triggerFinish(res);

		const log = parseLast(output.info);
		expect(log.attributes.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('sanitizes the clientIp by masking the last octet of IPv4', () => {
		const middleware = createRequestLogger();
		const req = buildReq({ ip: '203.0.113.7' });
		const res = buildRes();

		middleware(req, res, jest.fn());
		res.statusCode = 200;
		triggerFinish(res);

		const log = parseLast(output.info);
		expect(log.attributes.clientIp).toBeDefined();
		expect(log.attributes.clientIp).not.toContain('203.0.113.7');
	});

	it('records duration in milliseconds within the request span', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		const before = Date.now();
		middleware(req, res, jest.fn());
		res.statusCode = 200;
		triggerFinish(res);
		const after = Date.now();

		const log = parseLast(output.info);
		expect(log.attributes.durationMs).toBeGreaterThanOrEqual(0);
		expect(log.attributes.durationMs).toBeLessThanOrEqual(after - before + 5);
	});

	it('does not log if the response never finishes or closes', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = httpMocks.createResponse();
		res.on = jest.fn();

		middleware(req, res, jest.fn());

		expect(output.info).not.toHaveBeenCalled();
		expect(output.warn).not.toHaveBeenCalled();
		expect(output.error).not.toHaveBeenCalled();
	});

	it('emits a warn log with Request aborted when close fires before response finishes', () => {
		const middleware = createRequestLogger();
		const req = buildReq({ headers: { 'x-request-id': 'req-abort-123' } });
		const res = buildRes();
		res.writableEnded = false;
		res.finished = false;

		middleware(req, res, jest.fn());
		res._closeCb();

		expect(output.info).not.toHaveBeenCalled();
		expect(output.warn).toHaveBeenCalledTimes(1);
		const log = parseLast(output.warn);
		expect(log.level).toBe('warn');
		expect(log.message).toBe('Request aborted');
		expect(log.attributes).toEqual(expect.objectContaining({
			method: 'GET',
			path: '/api/test',
			requestId: 'req-abort-123',
			aborted: true,
			outcome: 'aborted',
		}));
	});
});
