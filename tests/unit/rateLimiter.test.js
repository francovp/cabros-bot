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

	describe('API-key aware rate limiting (issue #692)', () => {
		beforeEach(() => {
			process.env.RATE_LIMIT_MAX = '2';
			delete process.env.RATE_LIMIT_API_KEY_MAX;
		});

		test('separates ordinary buckets by API-key hash when WEBHOOK_API_KEY is configured', () => {
			process.env.WEBHOOK_API_KEY = 'super-secret';

			const apiReq1 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'super-secret' },
			});
			const apiReq2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.99',
				headers: { 'x-api-key': 'super-secret' },
			});
			const unauthReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
			});

			// Two authenticated requests from the SAME api-key (different IPs) share a bucket.
			rateLimiter(apiReq1, httpMocks.createResponse(), next);
			rateLimiter(apiReq2, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(apiReq1, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// Unauthenticated request from the same IP as the original blocked api-key caller
			// must still be allowed (separate bucket).
			const resOk = httpMocks.createResponse();
			const nextOk = jest.fn();
			rateLimiter(unauthReq, resOk, nextOk);
			expect(nextOk).toHaveBeenCalled();
		});

		test('separates buckets by API-key identity when multiple keys are configured', () => {
			process.env.WEBHOOK_API_KEYS = 'key-one,key-two';

			const apiReq1 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'key-one' },
			});
			const apiReq2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'key-two' },
			});

			rateLimiter(apiReq1, httpMocks.createResponse(), next);
			rateLimiter(apiReq1, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(apiReq1, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// key-two from the SAME IP must still be allowed (different bucket).
			const resOk = httpMocks.createResponse();
			const nextOk = jest.fn();
			rateLimiter(apiReq2, resOk, nextOk);
			expect(nextOk).toHaveBeenCalled();
		});

		test('uses User-Agent fingerprint when no API key is present and TRUST_PROXY is enabled', () => {
			process.env.TRUST_PROXY = '1';

			const browserReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'Mozilla/5.0 test-browser' },
			});
			const botReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'curl/8.4.0' },
			});

			rateLimiter(browserReq, httpMocks.createResponse(), next);
			rateLimiter(browserReq, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(browserReq, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// Bot from same IP but different UA must still be allowed (separate bucket).
			const resOk = httpMocks.createResponse();
			const nextOk = jest.fn();
			rateLimiter(botReq, resOk, nextOk);
			expect(nextOk).toHaveBeenCalled();
		});

		test('falls back to IP-only key when TRUST_PROXY is disabled (no API key awareness change)', () => {
			process.env.TRUST_PROXY = 'false';
			delete process.env.WEBHOOK_API_KEY;
			delete process.env.WEBHOOK_API_KEYS;

			const reqA = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'Mozilla/5.0 test-browser' },
			});
			const reqB = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'curl/8.4.0' },
			});

			// With TRUST_PROXY=false and no API keys configured, both requests share the
			// IP-only bucket to preserve legacy single-replica behavior.
			rateLimiter(reqA, httpMocks.createResponse(), next);
			rateLimiter(reqB, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(reqA, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);
		});

		test('honors RATE_LIMIT_API_KEY_MAX override for authenticated callers', () => {
			process.env.WEBHOOK_API_KEY = 'super-secret';
			process.env.RATE_LIMIT_API_KEY_MAX = '1';

			const authReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'super-secret' },
			});
			const unauthReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
			});

			// Authenticated bucket limited to RATE_LIMIT_API_KEY_MAX=1.
			rateLimiter(authReq, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(authReq, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// Unauthenticated bucket has its own RATE_LIMIT_MAX=2 budget — fill it then block.
			rateLimiter(unauthReq, httpMocks.createResponse(), next);
			rateLimiter(unauthReq, httpMocks.createResponse(), next);
			const resUnauthBlocked = httpMocks.createResponse();
			rateLimiter(unauthReq, resUnauthBlocked, jest.fn());
			expect(resUnauthBlocked.statusCode).toBe(429);
		});

		test('rejects invalid RATE_LIMIT_API_KEY_MAX with safe default', () => {
			process.env.WEBHOOK_API_KEY = 'super-secret';
			process.env.RATE_LIMIT_API_KEY_MAX = 'not-a-number';

			const authReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'super-secret' },
			});

			// Invalid RATE_LIMIT_API_KEY_MAX falls back to RATE_LIMIT_MAX=2 for authenticated callers.
			for (let i = 0; i < 2; i++) {
				rateLimiter(authReq, httpMocks.createResponse(), next);
			}
			const resBlocked = httpMocks.createResponse();
			rateLimiter(authReq, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);
		});
	});
});
