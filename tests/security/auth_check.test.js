const request = require('supertest');
const express = require('express');
const { validateApiKey } = require('../../src/lib/auth');

describe('Security: API Key Validation', () => {
	let app;

	beforeEach(() => {
		app = express();
		process.env.WEBHOOK_API_KEY = 'valid-api-key';
		app.use(express.json());
		app.post('/protected', validateApiKey, (req, res) => {
			res.status(200).json({ success: true });
		});
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

	it('should handle missing WEBHOOK_API_KEY env var', async () => {
		delete process.env.WEBHOOK_API_KEY;
		// Suppress console.error during this test
		const originalConsoleError = console.error;
		console.error = jest.fn();

		const res = await request(app)
			.post('/protected')
			.set('x-api-key', 'some-key')
			.send({});

		expect(res.status).toBe(500);
		expect(res.body.error).toBe('Server configuration error');

		console.error = originalConsoleError;
	});
});
