const request = require('supertest');
const express = require('express');
const { validateApiKey } = require('../../src/lib/auth');

describe('Security: API Key Validation', () => {
	let app;
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		app = express();
		process.env.WEBHOOK_API_KEY = 'valid-api-key';
		app.use(express.json());
		app.post('/protected', validateApiKey, (req, res) => {
			res.status(200).json({ success: true });
		});
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	it('should reject requests without x-api-key header', async () => {
		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(401);
		expect(res.body.error).toBe('Unauthorized: Missing API key');
	});

	it('should reject requests with invalid API key', async () => {
		const res = await request(app)
			.post('/protected')
			.set('x-api-key', 'invalid-key')
			.send({});

		expect(res.status).toBe(403);
		expect(res.body.error).toBe('Forbidden: Invalid API key');
	});

	it('should accept requests with valid API key', async () => {
		const res = await request(app)
			.post('/protected')
			.set('x-api-key', 'valid-api-key')
			.send({});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
	});

	it('should allow requests (insecure mode) when WEBHOOK_API_KEY is not set in development or test mode', async () => {
		delete process.env.WEBHOOK_API_KEY;
		process.env.NODE_ENV = 'development';

		// Suppress console.warn during this test
		const originalConsoleWarn = console.warn;
		console.warn = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('insecure'));

		console.warn = originalConsoleWarn;
	});

	it.each([
		['NODE_ENV=production', { NODE_ENV: 'production' }],
		['RENDER=true', { NODE_ENV: '', RENDER: 'true', IS_PULL_REQUEST: 'false' }],
		['VERCEL_ENV=production', { NODE_ENV: '', VERCEL_ENV: 'production' }],
		['RAILWAY_ENVIRONMENT_NAME=production', { NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'production' }],
	])('should reject requests with 503 when WEBHOOK_API_KEY is unset in production-like environment (%s)', async (_, envVars) => {
		delete process.env.WEBHOOK_API_KEY;
		Object.assign(process.env, envVars);

		const originalConsoleError = console.error;
		console.error = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(503);
		expect(res.body.code).toBe('WEBHOOK_API_KEY_UNSET');
		expect(res.body.error).toContain('WEBHOOK_API_KEY is not set in production');
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ERROR: WEBHOOK_API_KEY is not set in production environment'));

		console.error = originalConsoleError;
	});

	it.each([
		['VERCEL_ENV=preview', { NODE_ENV: '', VERCEL_ENV: 'preview' }],
		['RENDER preview PR', { NODE_ENV: '', RENDER: 'true', IS_PULL_REQUEST: 'true' }],
		['Railway PR number', { NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_GIT_PULL_REQUEST_NUMBER: '42' }],
		['Railway PR env name', { NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'pr-42' }],
	])('should allow bypass when WEBHOOK_API_KEY is unset in preview environment (%s)', async (_, envVars) => {
		delete process.env.WEBHOOK_API_KEY;
		Object.assign(process.env, envVars);

		const originalConsoleWarn = console.warn;
		console.warn = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);

		console.warn = originalConsoleWarn;
	});

	it('should capture a Sentry error event when WEBHOOK_API_KEY is unset in production', async () => {
		delete process.env.WEBHOOK_API_KEY;
		process.env.NODE_ENV = 'production';

		const sentryService = require('../../src/services/monitoring/SentryService');
		const spy = jest.spyOn(sentryService, 'captureRuntimeError').mockImplementation(() => ({ captured: true }));

		const originalConsoleError = console.error;
		console.error = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(503);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({
			channel: 'api',
			feature: 'auth',
			http: expect.objectContaining({ statusCode: 503 }),
			extra: expect.objectContaining({ type: 'auth-fail-open' }),
		}));

		spy.mockRestore();
		console.error = originalConsoleError;
	});
});
