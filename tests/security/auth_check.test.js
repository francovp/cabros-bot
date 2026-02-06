const request = require('supertest');

// Mock the alert controller BEFORE requiring app/routes
jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => {
	return {
		postAlert: jest.fn(() => (req, res) => {
			res.status(200).json({ success: true, mocked: true });
		}),
		// We also need these if other parts require them
		initializeNotificationServices: jest.fn(),
		getNotificationManager: jest.fn(),
	};
});

// We also need to mock newsMonitor since we added auth there too
jest.mock('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor', () => {
	return {
		getNewsMonitor: jest.fn(() => ({
			handleRequest: (req, res) => res.status(200).json({ success: true, mocked: true }),
		})),
	};
});

const app = require('../../app');
const { getRoutes } = require('../../src/routes');

// We need to mount routes for the test
app.use('/api', getRoutes());

describe('Security: Authentication', () => {
	const VALID_KEY = 'valid-test-key';

	beforeAll(() => {
		process.env.WEBHOOK_API_KEY = VALID_KEY;
	});

	afterAll(() => {
		delete process.env.WEBHOOK_API_KEY;
	});

	describe('POST /api/webhook/alert', () => {
		it('should return 403 when API key is missing', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.send({ text: 'Test alert' });

			expect(res.status).toBe(403);
			expect(res.body).toEqual({ error: 'Missing API key' });
		});

		it('should return 403 when API key is invalid', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'wrong-key')
				.send({ text: 'Test alert' });

			expect(res.status).toBe(403);
			expect(res.body).toEqual({ error: 'Invalid API key' });
		});

		it('should return 200 when API key is valid', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', VALID_KEY)
				.send({ text: 'Test alert' });

			expect(res.status).toBe(200);
			expect(res.body.mocked).toBe(true);
		});
	});

	describe('POST /api/news-monitor', () => {
		it('should return 403 when API key is missing', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTC'] });

			expect(res.status).toBe(403);
		});

		it('should return 200 when API key is valid', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', VALID_KEY)
				.send({ crypto: ['BTC'] });

			expect(res.status).toBe(200);
		});
	});

	describe('Configuration Safety', () => {
		it('should return 500 if WEBHOOK_API_KEY is not configured', async () => {
			const originalKey = process.env.WEBHOOK_API_KEY;
			delete process.env.WEBHOOK_API_KEY;

			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'any-key')
				.send({ text: 'Test' });

			expect(res.status).toBe(500);
			expect(res.body).toEqual({ error: 'Server configuration error' });

			process.env.WEBHOOK_API_KEY = originalKey;
		});
	});
});
