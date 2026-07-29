// tests/unit/rateLimiter.test.js
const rateLimiter = require('../../src/lib/rateLimiter');
const httpMocks = require('node-mocks-http');

describe('Rate Limiter Middleware', () => {
	let req, res, next;

	afterAll(() => {
		rateLimiter.disableTestMode();
	});

	beforeEach(() => {
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
	});

	test('should allow requests under the limit', () => {
		rateLimiter(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(res.statusCode).toBe(200);
	});

	test('should block requests over the limit and set Retry-After metadata', () => {
		// Mock a new IP
		req.ip = '10.0.0.1';

		// Exhaust the limit (default 100)
		for (let i = 0; i < 100; i++) {
			rateLimiter(req, res, next);
		}

		// The 101st request should be blocked
		const nextBlocked = jest.fn();
		const resBlocked = httpMocks.createResponse();
		rateLimiter(req, resBlocked, nextBlocked);

		expect(nextBlocked).not.toHaveBeenCalled();
		expect(resBlocked.statusCode).toBe(429);
		const data = JSON.parse(resBlocked._getData());
		expect(data.error).toBe('Too many requests, please try again later.');
		expect(typeof data.retryAfterSeconds).toBe('number');
		expect(data.retryAfterSeconds).toBeGreaterThan(0);
		expect(resBlocked.getHeader('Retry-After')).toBe(String(data.retryAfterSeconds));
	});

	test('should track different IPs separately', () => {
		req.ip = '10.0.0.2';
		rateLimiter(req, res, next);
		expect(next).toHaveBeenCalled();

		req.ip = '10.0.0.3';
		const next2 = jest.fn();
		rateLimiter(req, res, next2);
		expect(next2).toHaveBeenCalled();
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
});
