const { validateApiKey } = require('../../src/middleware/auth');
const httpMocks = require('node-mocks-http');

describe('Auth Middleware', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.resetModules();
		process.env = { ...originalEnv };
		process.env.WEBHOOK_API_KEY = 'test-api-key';
	});

	afterAll(() => {
		process.env = originalEnv;
	});

	test('should allow request with correct API key', () => {
		const req = httpMocks.createRequest({
			headers: {
				'x-api-key': 'test-api-key',
			},
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		validateApiKey(req, res, next);

		expect(next).toHaveBeenCalled();
		// Default status
		expect(res.statusCode).toBe(200);
	});

	test('should block request with incorrect API key', () => {
		const req = httpMocks.createRequest({
			headers: {
				'x-api-key': 'wrong-key',
			},
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		validateApiKey(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(401);
		expect(res._getJSONData()).toEqual({
			error: 'Unauthorized',
			message: 'Invalid or missing API key',
		});
	});

	test('should block request with missing API key', () => {
		const req = httpMocks.createRequest({
			headers: {},
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		validateApiKey(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(401);
		expect(res._getJSONData()).toEqual({
			error: 'Unauthorized',
			message: 'Invalid or missing API key',
		});
	});

	test('should return 500 if WEBHOOK_API_KEY is not configured', () => {
		delete process.env.WEBHOOK_API_KEY;

		const req = httpMocks.createRequest({
			headers: {
				'x-api-key': 'any-key',
			},
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		// Mock console.error to avoid polluting test output
		const originalConsoleError = console.error;
		console.error = jest.fn();

		validateApiKey(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(500);
		expect(res._getJSONData()).toEqual({
			error: 'Server configuration error',
			message: 'Authentication not configured',
		});

		console.error = originalConsoleError;
	});
});
