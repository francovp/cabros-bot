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

	test('emits X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset on successful requests', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '5';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(res.getHeader('X-RateLimit-Limit')).toBe('5');
			expect(res.getHeader('X-RateLimit-Remaining')).toBe('4');
			expect(res.getHeader('X-RateLimit-Reset')).toBe(
				String(Math.ceil((mockTime + 60000) / 1000))
			);
		} finally {
			Date.now = realNow;
		}
	});

	test('emits X-RateLimit-* headers on throttled 429 responses alongside Retry-After', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '1';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);
			expect(resBlocked.getHeader('X-RateLimit-Limit')).toBe('1');
			expect(resBlocked.getHeader('X-RateLimit-Remaining')).toBe('0');
			expect(resBlocked.getHeader('X-RateLimit-Reset')).toBe(
				String(Math.ceil((mockTime + 60000) / 1000))
			);
			expect(resBlocked.getHeader('Retry-After')).toBeDefined();
		} finally {
			Date.now = realNow;
		}
	});

	test('decrements X-RateLimit-Remaining across sequential requests within the window', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '10';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);
			expect(res.getHeader('X-RateLimit-Remaining')).toBe('9');

			const res2 = httpMocks.createResponse();
			rateLimiter(req, res2, jest.fn());
			expect(res2.getHeader('X-RateLimit-Remaining')).toBe('8');

			const res3 = httpMocks.createResponse();
			rateLimiter(req, res3, jest.fn());
			expect(res3.getHeader('X-RateLimit-Remaining')).toBe('7');
		} finally {
			Date.now = realNow;
		}
	});

	test('isolates X-RateLimit-* headers between ordinary and webhook buckets', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '5';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);
			expect(res.getHeader('X-RateLimit-Limit')).toBe('5');
			expect(res.getHeader('X-RateLimit-Remaining')).toBe('4');

			const webhookReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				ip: '127.0.0.1',
			});
			const webhookRes = httpMocks.createResponse();
			rateLimiter(webhookReq, webhookRes, jest.fn());

			expect(webhookRes.getHeader('X-RateLimit-Limit')).toBe('1000');
			expect(webhookRes.getHeader('X-RateLimit-Remaining')).toBe('999');
		} finally {
			Date.now = realNow;
		}
	});
});
