const request = require('supertest');
const express = require('express');
const { getRoutes } = require('../../src/routes');
const { validateApiKey } = require('../../src/lib/auth');

describe('Centralized API Route Authentication', () => {
	let app;
	const originalEnv = process.env;
	const mockBot = { telegram: { sendMessage: jest.fn() } };

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.WEBHOOK_API_KEY = 'secret-api-key';

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	const routes = [
		{ method: 'post', path: '/api/webhook/alert' },
		{ method: 'post', path: '/api/webhook/message' },
		{ method: 'post', path: '/api/webhook/expanded-analysis-alert' },
		{ method: 'post', path: '/api/webhook/market-scanner-alert' },
		{ method: 'post', path: '/api/webhook/volume-confirmation' },
		{ method: 'get', path: '/api/alerts' },
		{ method: 'get', path: '/api/alerts/summary' },
		{ method: 'get', path: '/api/alerts/export' },
		{ method: 'post', path: '/api/alerts/123/replay' },
		{ method: 'get', path: '/api/alerts/123' },
		{ method: 'post', path: '/api/scanner-presets' },
		{ method: 'get', path: '/api/scanner-presets' },
		{ method: 'get', path: '/api/scanner-presets/123' },
		{ method: 'put', path: '/api/scanner-presets/123' },
		{ method: 'delete', path: '/api/scanner-presets/123' },
		{ method: 'post', path: '/api/scanner-presets/123/run' },
		{ method: 'post', path: '/api/jobs/tradingview-analysis' },
		{ method: 'get', path: '/api/jobs' },
		{ method: 'get', path: '/api/jobs/123' },
		{ method: 'post', path: '/api/jobs/123/cancel' },
		{ method: 'post', path: '/api/jobs/123/retry' },
		{ method: 'post', path: '/api/jobs/123/retry-failed' },
		{ method: 'post', path: '/api/news-monitor' },
		{ method: 'get', path: '/api/news-monitor' },
		{ method: 'get', path: '/api/status' },
		{ method: 'get', path: '/api/capabilities' },
	];

	describe.each(routes)('$method $path', ({ method, path }) => {
		it('should return 401 Unauthorized when x-api-key header is missing', async () => {
			const res = await request(app)[method](path);
			expect(res.status).toBe(401);
			expect(res.body).toEqual({ error: 'Unauthorized: Missing API key' });
		});

		it('should return 403 Forbidden when x-api-key header is invalid', async () => {
			const res = await request(app)[method](path).set('x-api-key', 'wrong-key');
			expect(res.status).toBe(403);
			expect(res.body).toEqual({ error: 'Forbidden: Invalid API key' });
		});

		it('should accept valid API key via x-api-key header and pass auth middleware', async () => {
			const res = await request(app)[method](path).set('x-api-key', 'secret-api-key');
			// Should pass auth check (error should NOT be Unauthorized or Forbidden API key)
			expect(res.body?.error).not.toBe('Unauthorized: Missing API key');
			expect(res.body?.error).not.toBe('Forbidden: Invalid API key');
		});

		it('should accept valid API key via api-key query param and pass auth middleware', async () => {
			const separator = path.includes('?') ? '&' : '?';
			const res = await request(app)[method](`${path}${separator}api-key=secret-api-key`);
			expect(res.body?.error).not.toBe('Unauthorized: Missing API key');
			expect(res.body?.error).not.toBe('Forbidden: Invalid API key');
		});
	});

	describe('validateApiKey Unit Edge Cases', () => {
		it('should return 401 when API key is empty string', async () => {
			const req = { headers: { 'x-api-key': '' }, query: {} };
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateApiKey(req, res, next);

			expect(res.status).toHaveBeenCalledWith(401);
			expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Missing API key' });
			expect(next).not.toHaveBeenCalled();
		});

		it('should return 401 when API key is whitespace only', async () => {
			const req = { headers: { 'x-api-key': '   ' }, query: {} };
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateApiKey(req, res, next);

			expect(res.status).toHaveBeenCalledWith(401);
			expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Missing API key' });
			expect(next).not.toHaveBeenCalled();
		});
	});
});
