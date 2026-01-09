// tests/unit/rateLimiter.test.js
const rateLimiter = require('../../src/lib/rateLimiter');
const httpMocks = require('node-mocks-http');

describe('Rate Limiter Middleware', () => {
	let req, res, next;

	beforeEach(() => {
		req = httpMocks.createRequest({
			method: 'GET',
			url: '/api/test',
			ip: '127.0.0.1',
		});
		res = httpMocks.createResponse();
		next = jest.fn();

		// Reset process.env for each test (though we can't easily reset the module-level consts)
		// Since the module is already loaded, we can't easily change the constants inside it.
		// We will test the logic based on default values or values assumed by the module.
	});

	test('should allow requests under the limit', () => {
		rateLimiter(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(res.statusCode).toBe(200);
	});

	test('should block requests over the limit', () => {
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
});
