// tests/unit/requestLogger.test.js
const httpMocks = require('node-mocks-http');
const requestLogger = require('../../src/lib/requestLogger');
const {
	configureLogging,
	_resetLoggingForTests,
} = require('../../src/lib/logging');

const {
	createRequestLogger,
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
		// Real Node initializes `headersSent` to false and flips it once headers
		// are written; `node-mocks-http` declares it as a plain writable `false`
		// and never updates it. The logger relies on it to report 0 for a response
		// that never began, so drive it from the mocked write/end.
		for (const method of ['write', 'end', 'send', 'json']) {
			const original = res[method];
			res[method] = jest.fn((...args) => {
				res.headersSent = true;
				return typeof original === 'function' ? original.apply(res, args) : res;
			});
		}
		res.headersSent = false;
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
		res.end();
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
		res.end();
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
		res.end();
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
		res.end();
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
		res.end();
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
		res.end();
		triggerFinish(res);

		const log = parseLast(output.info);
		expect(log.attributes.clientIp).toBeDefined();
		expect(log.attributes.clientIp).not.toContain('203.0.113.7');
	});

	it('never emits a usable client address for any address family', () => {
		const cases = [
			['203.0.113.7', '203.0.113.x'],
			['127.0.0.1', '127.0.0.x'],
			['::ffff:203.0.113.9', '203.0.113.x'],
			['::1', 'loopback'],
			['2001:db8::1', 'ipv6-redacted'],
		];

		for (const [input, expected] of cases) {
			const middleware = createRequestLogger();
			const res = buildRes();
			middleware(buildReq({ ip: input }), res, jest.fn());
			res.statusCode = 200;
			res.end();
			triggerFinish(res);

			expect(parseLast(output.info).attributes.clientIp).toBe(expected);
		}
	});

	it('records duration in milliseconds within the request span', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		const before = Date.now();
		middleware(req, res, jest.fn());
		res.statusCode = 200;
		res.end();
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

	// `writableEnded` flips when the handler calls res.end(), before the bytes
	// reach the socket. A client that disconnects in that window leaves
	// writableEnded=true but writableFinished=false. Reading writableEnded would
	// report a truncated download as a clean completion with a short duration.
	it('reports an abort when the handler ended but the response was never flushed', () => {
		const middleware = createRequestLogger();
		const req = buildReq({ headers: { 'x-request-id': 'req-truncated-1' } });
		const res = buildRes();
		// Exactly the state Node reports after a mid-download client disconnect.
		res.writableEnded = true;
		res.finished = true;
		res.writableFinished = false;

		middleware(req, res, jest.fn());
		res._closeCb();

		expect(output.info).not.toHaveBeenCalled();
		expect(output.warn).toHaveBeenCalledTimes(1);
		const log = parseLast(output.warn);
		expect(log.message).toBe('Request aborted');
		expect(log.attributes).toEqual(expect.objectContaining({
			requestId: 'req-truncated-1',
			aborted: true,
			outcome: 'aborted',
		}));
	});

	it('reports a completion when close observes an already-flushed response', () => {
		const middleware = createRequestLogger();
		const req = buildReq({ headers: { 'x-request-id': 'req-clean-1' } });
		const res = buildRes();
		res.writableEnded = true;
		res.finished = true;
		res.writableFinished = true;

		middleware(req, res, jest.fn());
		res._closeCb();

		expect(output.warn).not.toHaveBeenCalled();
		const log = parseLast(output.info);
		expect(log.attributes).toEqual(expect.objectContaining({
			requestId: 'req-clean-1',
			aborted: false,
			outcome: 'completed',
		}));
	});

	// Express routing is case-insensitive, so `/HEALTHCHECK` reaches the
	// healthcheck handler and must not re-enter the logs as a way around the
	// probe skip list.
	it('matches the exemption set case-insensitively', () => {
		const middleware = createRequestLogger();

		const probeRes = buildRes();
		middleware(buildReq({ url: '/HEALTHCHECK' }), probeRes, jest.fn());
		triggerFinish(probeRes);
		expect(output.info).not.toHaveBeenCalled();
	});

	// Firestore document ids are mixed case and case-sensitive, so the emitted
	// path must preserve case. Lower-casing it would make /api/alerts/:alertId
	// unsearchable — an operator could not match the log line against the id they
	// saw in a 404 body or a Firestore doc.
	it('preserves path case in the emitted line', () => {
		const middleware = createRequestLogger();
		const res = buildRes();
		middleware(buildReq({ url: '/api/alerts/aB3xK9mQ2pL7zR4tY8wC' }), res, jest.fn());
		triggerFinish(res);

		expect(parseLast(output.info).attributes.path).toBe('/api/alerts/aB3xK9mQ2pL7zR4tY8wC');
	});

	// `/docs` serves a Swagger UI page that then pulls several static assets from
	// the same router. Exempting only `/docs` left every documentation visit
	// producing multiple low-signal records.
	it('stays silent for the whole /docs asset subtree', () => {
		const middleware = createRequestLogger();
		for (const url of [
			'/docs',
			'/docs/swagger-ui.css',
			'/docs/swagger-ui-bundle.js',
			'/docs/swagger-ui-standalone-preset.js',
			'/docs/swagger-initializer.js',
		]) {
			const res = buildRes();
			middleware(buildReq({ url }), res, jest.fn());
			triggerFinish(res);
		}
		expect(output.info).not.toHaveBeenCalled();
	});

	// REQUEST_DEADLINE_EXEMPT_PATHS=/Internal/Ping never matched, because the
	// request was lower-cased and the configured entry was not. Both middlewares
	// would then disagree about what is exempt.
	it('matches a configured exempt path regardless of the case it was declared in', () => {
		const previous = process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
		process.env.REQUEST_DEADLINE_EXEMPT_PATHS = '/Internal/Ping';
		try {
			const deadline = require('../../src/lib/requestDeadline');
			const configured = deadline.resolveExemptPaths();
			// The deadline lower-cases the incoming request, so the set it tests
			// membership against must be lower-cased too.
			expect(configured.has('/internal/ping')).toBe(true);
			expect(configured.has('/Internal/Ping')).toBe(false);

			const middleware = createRequestLogger();
			for (const url of ['/Internal/Ping', '/internal/ping']) {
				const res = buildRes();
				middleware(buildReq({ url }), res, jest.fn());
				triggerFinish(res);
			}
			expect(output.info).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
			else process.env.REQUEST_DEADLINE_EXEMPT_PATHS = previous;
		}
	});

	// A Telegram or WhatsApp chat id is a personal destination and the only
	// parameterized segment that is not an opaque document or job id.
	it('redacts the chatId segment of preference routes', () => {
		const middleware = createRequestLogger();
		for (const url of [
			'/api/preferences/telegram/123456789',
			'/api/preferences/whatsapp/120363422033474991@g.us',
		]) {
			const res = buildRes();
			middleware(buildReq({ url }), res, jest.fn());
			triggerFinish(res);
		}

		for (const call of output.info.mock.calls) {
			const entry = JSON.parse(call[0]);
			expect(entry.attributes.path).not.toMatch(/123456789|120363422033474991/);
		}
		expect(parseLast(output.info).attributes.path).toBe('/api/preferences/whatsapp/:redacted');
	});

	// Masking must not make other routes unsearchable: alert ids are mixed-case
	// Firestore document ids and job ids are UUIDs, both needed during triage.
	it('keeps non-sensitive path parameters intact', () => {
		const middleware = createRequestLogger();
		const res = buildRes();
		middleware(buildReq({ url: '/api/jobs/3f1c8e2a-0b1d-4a7e-9c11-abcdef012345' }), res, jest.fn());
		triggerFinish(res);

		expect(parseLast(output.info).attributes.path).toBe('/api/jobs/3f1c8e2a-0b1d-4a7e-9c11-abcdef012345');
	});

	// Masking must not run before exemption matching, or an operator who
	// configured a concrete preference path would still see it logged: the
	// masked form `:redacted` cannot match the configured entry `/123`.
	it('matches a configured exempt path that contains a masked segment', () => {
		const previous = process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
		process.env.REQUEST_DEADLINE_EXEMPT_PATHS = '/api/preferences/telegram/123';
		try {
			const middleware = createRequestLogger();
			const res = buildRes();
			middleware(buildReq({ url: '/api/preferences/telegram/123' }), res, jest.fn());
			triggerFinish(res);

			expect(output.info).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
			else process.env.REQUEST_DEADLINE_EXEMPT_PATHS = previous;
		}
	});

	// A response that never began must not report Node's default 200.
	it('reports statusCode 0 when no response was ever sent', () => {
		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		middleware(req, res, jest.fn());
		res.headersSent = false;
		res.statusCode = 200;
		res._closeCb();

		const log = parseLast(output.warn);
		expect(log.message).toBe('Request aborted');
		expect(log.attributes).toEqual(expect.objectContaining({
			aborted: true,
			outcome: 'aborted',
			statusCode: 0,
		}));
	});

	it('never lets a throwing log sink escape into the request lifecycle', () => {
		const throwing = jest.fn(() => {
			throw new Error('log sink exploded');
		});
		console.info = throwing;
		console.warn = throwing;
		console.error = throwing;

		const middleware = createRequestLogger();
		const req = buildReq();
		const res = buildRes();

		expect(() => {
			middleware(req, res, jest.fn());
			triggerFinish(res);
		}).not.toThrow();
	});
});
