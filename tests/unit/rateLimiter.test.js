const rateLimit = require('../../src/lib/rateLimiter');
const nodeMocks = require('node-mocks-http');

describe('Rate Limiter', () => {
    let req, res, next;

    // Reset environment variables before each test
    beforeEach(() => {
        process.env.RATE_LIMIT_WINDOW_MS = '60000'; // 1 minute
        process.env.RATE_LIMIT_MAX = '5'; // 5 requests per minute
        req = nodeMocks.createRequest({
            method: 'GET',
            url: '/api/test',
            ip: '127.0.0.1'
        });
        res = nodeMocks.createResponse();
        next = jest.fn();
    });

    afterEach(() => {
        // Clear environment variables
        delete process.env.RATE_LIMIT_WINDOW_MS;
        delete process.env.RATE_LIMIT_MAX;

        // Clear internal state if possible (we might need to expose a reset method or recreate the module)
        // Since the module exports a middleware function that closes over the state,
        // we might need to modify the module to export the state or a reset function for testing.
        // For now, let's just assume we can't reset it easily without modifying the module.
        // But wait, if we create the module in the test, we can have fresh state.
        // However, require returns the same instance.
        // We will modify the rateLimiter to expose a reset method for testing.
    });

    it('should allow requests below the limit', () => {
        rateLimit.reset();

        for (let i = 0; i < 5; i++) {
            rateLimit(req, res, next);
            expect(next).toHaveBeenCalledTimes(i + 1);
            expect(res.statusCode).toBe(200); // node-mocks-http default
        }
    });

    it('should block requests above the limit', () => {
        rateLimit.reset();

        for (let i = 0; i < 5; i++) {
            rateLimit(req, res, next);
        }

        rateLimit(req, res, next);
        expect(next).toHaveBeenCalledTimes(5); // Next not called for the 6th time
        expect(res.statusCode).toBe(429);
        const data = JSON.parse(res._getData());
        expect(data.error).toBe('Too many requests, please try again later.');
    });

    it('should exempt healthcheck endpoint', () => {
        rateLimit.reset();
        req.path = '/healthcheck';

        for (let i = 0; i < 10; i++) {
            rateLimit(req, res, next);
        }

        expect(next).toHaveBeenCalledTimes(10);
        expect(res.statusCode).toBe(200);
    });

    it('should track different IPs separately', () => {
        rateLimit.reset();

        // IP 1
        req.ip = '127.0.0.1';
        for (let i = 0; i < 5; i++) {
            rateLimit(req, res, next);
        }
        expect(next).toHaveBeenCalledTimes(5);

        // IP 2
        req.ip = '127.0.0.2';
        rateLimit(req, res, next);
        expect(next).toHaveBeenCalledTimes(6);
    });
});
