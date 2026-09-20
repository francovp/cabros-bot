const express = require('express');
const request = require('supertest');
const rateLimiter = require('../../src/lib/rateLimiter');

describe('Webhook rate-limit integration', () => {
	let app;
	let server;
	let savedEnv;

	beforeEach((done) => {
		savedEnv = saveEnv();
		rateLimiter.enableTestMode();
		rateLimiter.reset();
		process.env.RATE_LIMIT_MAX = '2';

		app = express();
		app.use(rateLimiter);
		app.post('/api/webhook/alert', (req, res) => res.sendStatus(204));
		app.post('/api/webhook/message', (req, res) => res.sendStatus(204));
		app.post('/api/webhook/expanded-analysis-alert', (req, res) => res.sendStatus(204));
		app.post('/api/webhook/market-scanner-alert', (req, res) => res.sendStatus(204));
		app.post('/api/webhook/volume-confirmation', (req, res) => res.sendStatus(204));
		app.post('/api/webhook/symbol-analysis', (req, res) => res.sendStatus(204));
		app.post('/api/news-monitor', (req, res) => res.sendStatus(204));
		app.get('/api/other', (req, res) => res.sendStatus(204));

		server = app.listen(0, done);
	});

	afterEach((done) => {
		rateLimiter.disableTestMode();
		restoreEnv(savedEnv);
		if (server && server.listening) {
			server.close(done);
		} else {
			done();
		}
	});

	test.each([
		['/api/webhook/alert'],
		['/api/webhook/message'],
		['/api/webhook/expanded-analysis-alert'],
		['/api/webhook/market-scanner-alert'],
		['/api/webhook/volume-confirmation'],
		['/api/webhook/symbol-analysis'],
		['/api/news-monitor'],
	])('allows a 101-request webhook burst on %s while retaining the ordinary 429 boundary', async (endpoint) => {
		for (let i = 0; i < 101; i++) {
			const response = await request(server).post(endpoint);
			expect(response.status).toBe(204);
		}

		await request(server).get('/api/other');
		await request(server).get('/api/other');
		const blocked = await request(server).get('/api/other');

		expect(blocked.status).toBe(429);
	});

	test('normalizes casing and trailing slashes for newly isolated webhook endpoints', async () => {
		for (let i = 0; i < 10; i++) {
			const res1 = await request(server).post('/API/WEBHOOK/EXPANDED-ANALYSIS-ALERT/');
			expect(res1.status).toBe(204);
			const res2 = await request(server).post('/API/NEWS-MONITOR/');
			expect(res2.status).toBe(204);
		}

		await request(server).get('/api/other');
		await request(server).get('/api/other');
		const blocked = await request(server).get('/api/other');
		expect(blocked.status).toBe(429);
	});

	test('preserves downstream API key authentication error for unauthenticated calls', async () => {
		const { validateApiKey } = require('../../src/lib/auth');
		process.env.WEBHOOK_API_KEY = 'secret-key-123';
		const authApp = express();
		authApp.use(rateLimiter);
		authApp.post('/api/webhook/symbol-analysis', validateApiKey, (req, res) => res.sendStatus(200));

		// Call without api key -> should be rejected by validateApiKey with 401
		const unauthRes = await request(authApp).post('/api/webhook/symbol-analysis');
		expect(unauthRes.status).toBe(401);

		// Call with valid api key -> should succeed
		const authRes = await request(authApp)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'secret-key-123');
		expect(authRes.status).toBe(200);
	});
});
