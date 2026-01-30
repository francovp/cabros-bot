const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');

// Mock controllers to avoid running actual logic
jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
	postAlert: () => (req, res) => res.status(200).json({ success: true, mocked: true }),
	initializeNotificationServices: jest.fn(),
}));

jest.mock('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor', () => ({
	getNewsMonitor: () => ({
		handleRequest: (req, res) => res.status(200).json({ success: true, mocked: true }),
	}),
}));

describe('Webhook Authentication Security', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'correct-secret-key',
		};
		// Re-mount routes for each test to ensure fresh env vars
		jest.resetModules();
		app.use('/api', getRoutes());
	});

	afterEach(() => {
		process.env = originalEnv;
		// Clean up routes
		if (app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('Authentication Middleware', () => {
		const endpoints = [
			{ method: 'post', url: '/api/webhook/alert' },
			{ method: 'post', url: '/api/news-monitor' },
			{ method: 'get', url: '/api/news-monitor' },
		];

		endpoints.forEach(({ method, url }) => {
			it(`should return 401 when API key is missing for ${method.toUpperCase()} ${url}`, async () => {
				const req = request(app)[method](url);
				const res = await req.expect(401);
				expect(res.body.error).toBe('Missing x-api-key header');
			});

			it(`should return 403 when API key is invalid for ${method.toUpperCase()} ${url}`, async () => {
				const req = request(app)[method](url).set('x-api-key', 'wrong-key');
				const res = await req.expect(403);
				expect(res.body.error).toBe('Invalid API key');
			});

			it(`should return 200 when API key is correct for ${method.toUpperCase()} ${url}`, async () => {
				const req = request(app)[method](url).set('x-api-key', 'correct-secret-key');
				const res = await req.expect(200);
				expect(res.body.success).toBe(true);
			});
		});

		it('should return 500 if WEBHOOK_API_KEY is not configured', async () => {
			delete process.env.WEBHOOK_API_KEY;

			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'any-key')
				.expect(500);

			expect(res.body.error).toBe('Server configuration error');
		});
	});
});
