const express = require('express');
const request = require('supertest');
const rateLimiter = require('../../src/lib/rateLimiter');

describe('Webhook rate-limit integration', () => {
	let app;
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		rateLimiter.enableTestMode();
		rateLimiter.reset();
		process.env.RATE_LIMIT_MAX = '2';

		app = express();
		app.use(rateLimiter);
		app.post('/api/webhook/alert', (req, res) => res.sendStatus(204));
		app.get('/api/other', (req, res) => res.sendStatus(204));
	});

	afterEach(() => {
		rateLimiter.disableTestMode();
		restoreEnv(savedEnv);
	});

	test('enforces the standard webhook tier while retaining the ordinary 429 boundary', async () => {
		for (let i = 0; i < 30; i++) {
			const response = await request(app).post('/api/webhook/alert');
			expect(response.status).toBe(204);
		}
		expect((await request(app).post('/api/webhook/alert')).status).toBe(429);

		await request(app).get('/api/other');
		await request(app).get('/api/other');
		const blocked = await request(app).get('/api/other');

		expect(blocked.status).toBe(429);
	});
});
