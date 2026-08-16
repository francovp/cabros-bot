// tests/integration/trust-proxy-rate-limiter.test.js
const request = require('supertest');
const express = require('express');
const { setupTrustProxy } = require('../../src/lib/trustProxy');
const rateLimiter = require('../../src/lib/rateLimiter');

describe('Trust Proxy and Rate Limiter Integration', () => {
	let app;
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		rateLimiter.enableTestMode();
		process.env.RATE_LIMIT_MAX = '5';
		rateLimiter.reset();

		app = express();
		app.use(express.json());
	});

	afterEach(() => {
		rateLimiter.disableTestMode();
		restoreEnv(savedEnv);
	});

	describe('When TRUST_PROXY is enabled (1 hop / Render)', () => {
		beforeEach(() => {
			setupTrustProxy(app, { TRUST_PROXY: '1', RENDER: 'false' });
			app.use('/healthcheck', (req, res) => res.status(200).send('OK'));
			app.use(rateLimiter);
			app.get('/api/test', (req, res) => res.status(200).json({ ip: req.ip }));
		});

		test('should separate rate-limit buckets by forwarded client IP address', async () => {
			const clientA = '203.0.113.195';
			const clientB = '198.51.100.42';

			// Exhaust limit for Client A (5 requests)
			for (let i = 0; i < 5; i++) {
				await request(app)
					.get('/api/test')
					.set('X-Forwarded-For', clientA);
			}

			// Client A request 6 should be blocked (429)
			const resA = await request(app)
				.get('/api/test')
				.set('X-Forwarded-For', clientA);
			expect(resA.status).toBe(429);
			expect(resA.headers['retry-after']).toMatch(/^\d+$/);
			expect(resA.body).toEqual({
				error: 'Too many requests, please try again later.',
			retryAfterSeconds: Number(resA.headers['retry-after']),
		});

			// Client B request 1 should be allowed (200) because it is in a separate bucket
			const resB = await request(app)
				.get('/api/test')
				.set('X-Forwarded-For', clientB);
			expect(resB.status).toBe(200);
			expect(resB.body.ip).toBe(clientB);
		});

		test('healthcheck endpoint remains exempt from rate limiting', async () => {
			const clientA = '203.0.113.195';

			// Exhaust limit for Client A
			for (let i = 0; i < 5; i++) {
				await request(app)
					.get('/api/test')
					.set('X-Forwarded-For', clientA);
			}

			// Healthcheck should still succeed (200)
			const res = await request(app)
				.get('/healthcheck')
				.set('X-Forwarded-For', clientA);
			expect(res.status).toBe(200);
		});
	});

	describe('When TRUST_PROXY is disabled (direct deployment)', () => {
		beforeEach(() => {
			setupTrustProxy(app, { TRUST_PROXY: 'false', RENDER: 'false' });
			app.use(rateLimiter);
			app.get('/api/test', (req, res) => res.status(200).json({ ip: req.ip }));
		});

		test('spoofed X-Forwarded-For header is ignored and does not split rate-limit buckets', async () => {
			// All requests come from socket IP (127.0.0.1) despite sending different X-Forwarded-For
			for (let i = 0; i < 3; i++) {
				await request(app)
					.get('/api/test')
					.set('X-Forwarded-For', '203.0.113.1');
			}
			for (let i = 0; i < 2; i++) {
				await request(app)
					.get('/api/test')
					.set('X-Forwarded-For', '203.0.113.2');
			}

			// 6th request from same socket IP should be blocked (429), even with a new spoofed header
			const res = await request(app)
				.get('/api/test')
				.set('X-Forwarded-For', '203.0.113.3');
			expect(res.status).toBe(429);
		});
	});
});
