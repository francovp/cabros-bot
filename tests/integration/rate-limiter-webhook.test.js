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
		app.post('/api/trading/binance/orders/preview', (req, res) => res.sendStatus(204));
		app.route('/api/trading/binance/orders')
			.get((req, res) => res.sendStatus(204))
			.post((req, res) => res.sendStatus(204))
			.delete((req, res) => res.sendStatus(204));
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
		['/api/webhook/expanded-analysis-alert', 5],
		['/api/webhook/market-scanner-alert', 5],
		['/api/webhook/symbol-analysis', 5],
		['/api/webhook/volume-confirmation', 30],
		['/api/news-monitor', 5],
		['/api/trading/binance/orders', 10],
		['/api/trading/binance/orders/preview', 10],
	])('enforces the endpoint tier for %s', async (endpoint, maxRequests) => {
		const method = endpoint === '/api/trading/binance/orders' ? 'get' : 'post';
		for (let i = 0; i < maxRequests; i++) {
			const response = await request(server)[method](endpoint);
			expect(response.status).toBe(204);
		}

		const blockedResponse = await request(server)[method](endpoint);
		expect(blockedResponse.status).toBe(429);
		expect(blockedResponse.body.code).toBe('RATE_LIMITED');
		expect(blockedResponse.body.retryable).toBe(true);
		expect(blockedResponse.body.retryAfterSeconds).toBeGreaterThan(0);

		await request(server).get('/api/other');
		await request(server).get('/api/other');
		const ordinaryBlocked = await request(server).get('/api/other');
		expect(ordinaryBlocked.status).toBe(429);
	});

	test.each(['/api/webhook/alert', '/api/webhook/message'])(
		'keeps ordinary webhook ingest on its separate high-capacity bucket: %s',
		async (endpoint) => {
			for (let i = 0; i < 101; i++) {
				const response = await request(server).post(endpoint);
				expect(response.status).toBe(204);
			}

			await request(server).get('/api/other');
			await request(server).get('/api/other');
			const blocked = await request(server).get('/api/other');
			expect(blocked.status).toBe(429);
		},
	);

	test('shares the Binance order tier across read and write methods', async () => {
		for (let i = 0; i < 5; i++) {
			expect((await request(server).get('/api/trading/binance/orders')).status).toBe(204);
		}
		for (let i = 0; i < 5; i++) {
			expect((await request(server).post('/api/trading/binance/orders')).status).toBe(204);
		}
		const blocked = await request(server).delete('/api/trading/binance/orders');
		expect(blocked.status).toBe(429);
	});

	test('normalizes casing, trailing slashes, and query strings for endpoint tiers', async () => {
		for (let i = 0; i < 5; i++) {
			const res1 = await request(server).post('/API/WEBHOOK/EXPANDED-ANALYSIS-ALERT/?source=test');
			expect(res1.status).toBe(204);
			const res2 = await request(server).post('/API/NEWS-MONITOR/');
			expect(res2.status).toBe(204);
		}

		expect((await request(server).post('/api/webhook/expanded-analysis-alert')).status).toBe(429);
		expect((await request(server).post('/api/news-monitor')).status).toBe(429);
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
	test('exposes X-RateLimit-* headers on both webhook and ordinary responses', async () => {
		const webhook = await request(server).post('/api/webhook/alert');
		expect(webhook.status).toBe(204);
		expect(webhook.headers['x-ratelimit-limit']).toBe('1000');
		expect(webhook.headers['x-ratelimit-remaining']).toBe('999');
		expect(Number(webhook.headers['x-ratelimit-reset'])).toBeGreaterThan(0);

		const other = await request(server).get('/api/other');
		expect(other.status).toBe(204);
		expect(other.headers['x-ratelimit-limit']).toBe('2');
		expect(other.headers['x-ratelimit-remaining']).toBe('1');
	});

	test('429 responses still include X-RateLimit-* headers and the original error JSON', async () => {
		await request(server).get('/api/other');
		await request(server).get('/api/other');
		const blocked = await request(server).get('/api/other');

		expect(blocked.status).toBe(429);
		expect(blocked.headers['x-ratelimit-limit']).toBe('2');
		expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
		expect(blocked.headers['retry-after']).toBeDefined();
		expect(blocked.body.error).toMatch(/too many requests/i);
		expect(blocked.body.code).toBe('RATE_LIMITED');
		expect(blocked.body.retryable).toBe(true);
		expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
	});

});
