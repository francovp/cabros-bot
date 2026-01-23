const httpMocks = require('node-mocks-http');
const { validateApiKey } = require('../../src/lib/auth');

describe('Auth Middleware', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.resetModules();
		process.env = { ...originalEnv };
		// Clear console logs to avoid noise during tests
		jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterAll(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
	});

	test('should call next() when API key is valid', () => {
		process.env.WEBHOOK_API_KEY = 'test-key';
		const req = httpMocks.createRequest({
			headers: { 'x-api-key': 'test-key' },
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		validateApiKey(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(res.statusCode).toBe(200); // Default status
	});

	test('should return 401 when API key is missing', () => {
		process.env.WEBHOOK_API_KEY = 'test-key';
		const req = httpMocks.createRequest({
			headers: {},
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		validateApiKey(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(401);
		expect(res._getJSONData()).toEqual({
			error: 'Unauthorized: Invalid or missing API key',
		});
	});

	test('should return 401 when API key is invalid', () => {
		process.env.WEBHOOK_API_KEY = 'test-key';
		const req = httpMocks.createRequest({
			headers: { 'x-api-key': 'wrong-key' },
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		validateApiKey(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(401);
	});

	test('should return 500 when WEBHOOK_API_KEY is not configured', () => {
		delete process.env.WEBHOOK_API_KEY;
		const req = httpMocks.createRequest({
			headers: { 'x-api-key': 'any-key' },
		});
		const res = httpMocks.createResponse();
		const next = jest.fn();

		validateApiKey(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(500);
		expect(res._getJSONData()).toEqual({
			error: 'Server configuration error: Authentication not configured',
		});
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('WEBHOOK_API_KEY is not configured')
		);
	});
});
