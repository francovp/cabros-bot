// tests/unit/rateLimiter.test.js
const rateLimiter = require('../../src/lib/rateLimiter');
const httpMocks = require('node-mocks-http');

describe('Rate Limiter Middleware', () => {
	let req, res, next;
	let savedRateLimitEnv;

	afterAll(() => {
		rateLimiter.disableTestMode();
	});

	beforeEach(() => {
		savedRateLimitEnv = {
			RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
			RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
		};
		rateLimiter.enableTestMode();
		rateLimiter.reset();

		req = httpMocks.createRequest({
			method: 'GET',
			url: '/api/test',
			ip: '127.0.0.1',
			headers: { 'user-agent': 'test-agent/1.0' },
		});
		res = httpMocks.createResponse();
		next = jest.fn();
	});

	afterEach(() => {
		rateLimiter.disableTestMode();
		for (const [key, value] of Object.entries(savedRateLimitEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test('should fallback to req.socket.remoteAddress if req.ip is undefined', () => {
		delete req.ip;
		req.socket = { remoteAddress: '192.168.1.50' };
		rateLimiter(req, res, next);
		expect(next).toHaveBeenCalled();
	});

	test('should reset count after window expiration', () => {
		req.ip = '10.0.0.4';
		const realNow = Date.now;
		let mockTime = 1000000;
		Date.now = jest.fn(() => mockTime);

		try {
			for (let i = 0; i < 100; i++) {
				rateLimiter(req, res, next);
			}

			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);
			expect(resBlocked.statusCode).toBe(429);

			// Advance time past the 15-minute (900,000ms) window
			mockTime += 900001;

			const resAfterWindow = httpMocks.createResponse();
			const nextAfterWindow = jest.fn();
			rateLimiter(req, resAfterWindow, nextAfterWindow);
			expect(nextAfterWindow).toHaveBeenCalled();
			expect(resAfterWindow.statusCode).toBe(200);
		} finally {
			Date.now = realNow;
		}
	});

	test('falls back to safe defaults and warns once per invalid setting', () => {
		process.env.RATE_LIMIT_MAX = 'not-a-number';
		process.env.RATE_LIMIT_WINDOW_MS = 'also-invalid';
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			for (let i = 0; i < 100; i++) {
				rateLimiter(req, res, next);
			}

			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);

			expect(nextBlocked).not.toHaveBeenCalled();
			expect(resBlocked.statusCode).toBe(429);
			expect(JSON.parse(resBlocked._getData()).retryAfterSeconds).toBeGreaterThan(0);
			expect(warnSpy).toHaveBeenCalledTimes(2);
			expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('not-a-number');
			expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('also-invalid');
		} finally {
			warnSpy.mockRestore();
		}
	});

	test.each(['', '0', '-1', 'NaN', 'Infinity', '1.5', '100abc'])
		('uses the safe max default for invalid RATE_LIMIT_MAX=%s', (value) => {
			process.env.RATE_LIMIT_MAX = value;

			for (let i = 0; i < 100; i++) {
				rateLimiter(req, res, next);
			}

			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);

			expect(nextBlocked).not.toHaveBeenCalled();
			expect(resBlocked.statusCode).toBe(429);
		});

	test.each(['', '0', '-1', 'NaN', 'Infinity', '1.5', '100abc'])
		('uses the safe window default for invalid RATE_LIMIT_WINDOW_MS=%s', (value) => {
			const realNow = Date.now;
			let mockTime = 1000000;
			Date.now = jest.fn(() => mockTime);
			process.env.RATE_LIMIT_MAX = '1';
			process.env.RATE_LIMIT_WINDOW_MS = value;

			try {
				rateLimiter(req, res, next);
				const resBlocked = httpMocks.createResponse();
				const nextBlocked = jest.fn();
				rateLimiter(req, resBlocked, nextBlocked);

				expect(nextBlocked).not.toHaveBeenCalled();
				expect(resBlocked.statusCode).toBe(429);
				expect(JSON.parse(resBlocked._getData()).retryAfterSeconds).toBe(900);
			} finally {
				Date.now = realNow;
			}
		});

	test('preserves valid custom max and window settings', () => {
		const realNow = Date.now;
		let mockTime = 1000000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '2';
		process.env.RATE_LIMIT_WINDOW_MS = '5000';

		try {
			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);

			expect(nextBlocked).not.toHaveBeenCalled();
			expect(resBlocked.statusCode).toBe(429);
			expect(JSON.parse(resBlocked._getData()).retryAfterSeconds).toBe(5);
		} finally {
			Date.now = realNow;
		}
	});

	test.each(['/api/webhook/alert', '/api/webhook/alert/', '/API/WEBHOOK/MESSAGE/'])('uses a separate high-capacity bucket for %s', (url) => {
		process.env.RATE_LIMIT_MAX = '2';
		req.method = 'POST';
		req.url = url;
		req.originalUrl = url;

		for (let i = 0; i < 101; i++) {
			rateLimiter(req, res, next);
		}

		expect(next).toHaveBeenCalledTimes(101);
	});

	test('keeps the ordinary bucket isolated and rate limited', () => {
		process.env.RATE_LIMIT_MAX = '2';

		rateLimiter(req, res, next);
		rateLimiter(req, res, next);
		const resBlocked = httpMocks.createResponse();
		rateLimiter(req, resBlocked, jest.fn());

		expect(resBlocked.statusCode).toBe(429);

		req.method = 'POST';
		req.url = '/api/webhook/alert';
		req.originalUrl = req.url;
		rateLimiter(req, res, next);

		expect(next).toHaveBeenCalledTimes(3);
	});

	describe('API key-based rate limiting', () => {
		test('uses API key hash as bucket key when x-api-key header is present', () => {
			process.env.RATE_LIMIT_MAX = '2';
			req.headers['x-api-key'] = 'test-api-key-123';

			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);

			// Different API key should get a different bucket
			const req2 = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '127.0.0.1',
				headers: { 'user-agent': 'test-agent/1.0', 'x-api-key': 'different-key-456' },
			});
			const res2 = httpMocks.createResponse();
			rateLimiter(req2, res2, next);
			rateLimiter(req2, res2, next);
			const res2Blocked = httpMocks.createResponse();
			rateLimiter(req2, res2Blocked, jest.fn());
			expect(res2Blocked.statusCode).toBe(429);
		});

		test('uses API key hash as bucket key when api-key query param is present', () => {
			process.env.RATE_LIMIT_MAX = '2';
			req.query = { 'api-key': 'query-api-key-789' };

			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);
		});

		test('falls back to IP+UA fingerprint when no API key is present', () => {
			process.env.RATE_LIMIT_MAX = '2';
			delete req.headers['x-api-key'];
			delete req.query;

			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);

			// Same IP but different User-Agent should get different bucket
			const req2 = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '127.0.0.1',
				headers: { 'user-agent': 'different-agent/2.0' },
			});
			const res2 = httpMocks.createResponse();
			rateLimiter(req2, res2, next);
			rateLimiter(req2, res2, next);
			const res2Blocked = httpMocks.createResponse();
			rateLimiter(req2, res2Blocked, jest.fn());
			expect(res2Blocked.statusCode).toBe(429);
		});

		test('webhook ingest paths use API key aware bucket key', () => {
			process.env.RATE_LIMIT_MAX = '2';
			req.method = 'POST';
			req.url = '/api/webhook/alert';
			req.originalUrl = '/api/webhook/alert';
			req.headers['x-api-key'] = 'webhook-key';

			// Should not hit limit at 101 requests (webhook max is 1000)
			for (let i = 0; i < 101; i++) {
				rateLimiter(req, res, next);
			}
			expect(next).toHaveBeenCalledTimes(101);

			// Different API key on webhook should be separate
			const req2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				originalUrl: '/api/webhook/alert',
				ip: '127.0.0.1',
				headers: { 'user-agent': 'test-agent/1.0', 'x-api-key': 'webhook-key-2' },
			});
			const res2 = httpMocks.createResponse();
			for (let i = 0; i < 101; i++) {
				rateLimiter(req2, res2, next);
			}
			expect(next).toHaveBeenCalledTimes(202);
		});
	});
});
