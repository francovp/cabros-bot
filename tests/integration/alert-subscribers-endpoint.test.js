'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { alertSubscriberService } = require('../../src/services/subscribers/AlertSubscriberService');

describe('Alert subscribers API integration tests', () => {
	let originalEnv;

	beforeAll(() => {
		originalEnv = { ...process.env };
	});

	beforeEach(() => {
		process.env.WEBHOOK_API_KEY = 'test-secret-key';
		process.env.ENABLE_FIRESTORE_ALERT_SUBSCRIBERS = 'false';
		delete process.env.ALLOW_PRIVATE_CALLBACKS;
		alertSubscriberService.resetForTesting();
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	afterAll(() => {
		process.env = originalEnv;
		alertSubscriberService.resetForTesting();
	});

	describe('Authentication', () => {
		it('rejects unauthenticated requests to GET /api/alert-subscribers with 401', async () => {
			const res = await request(app).get('/api/alert-subscribers');
			expect(res.status).toBe(401);
		});

		it('allows requests with valid x-api-key', async () => {
			const res = await request(app)
				.get('/api/alert-subscribers')
				.set('x-api-key', 'test-secret-key');

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(Array.isArray(res.body.subscribers)).toBe(true);
			expect(res.body.storage).toBeDefined();
		});
	});

	describe('POST /api/alert-subscribers', () => {
		it('returns 400 when url is missing or invalid', async () => {
			const res = await request(app)
				.post('/api/alert-subscribers')
				.set('x-api-key', 'test-secret-key')
				.send({ description: 'No url' });

			expect(res.status).toBe(400);
			expect(res.body.success).toBe(false);
		});

		it('returns 400 when url points to private IP in production', async () => {
			const savedNodeEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = 'production';
			try {
				const res = await request(app)
					.post('/api/alert-subscribers')
					.set('x-api-key', 'test-secret-key')
					.send({ url: 'http://127.0.0.1:8080/callback' });

				expect(res.status).toBe(400);
				expect(res.body.error).toContain('blocked');
			} finally {
				process.env.NODE_ENV = savedNodeEnv;
			}
		});

		it('creates subscriber successfully and redacts secret in response', async () => {
			const res = await request(app)
				.post('/api/alert-subscribers')
				.set('x-api-key', 'test-secret-key')
				.send({
					url: 'https://example.com/alerts/webhook',
					secret: 'very-secret-token',
					description: 'Production Discord/Slack bridge',
					filter: {
						symbols: ['BTCUSDT', 'ETHUSDT'],
						sources: ['webhook-alert'],
					},
					enabled: true,
				});

			expect(res.status).toBe(201);
			expect(res.body.success).toBe(true);
			expect(res.body.subscriber).toBeDefined();
			expect(res.body.subscriber.id).toBeDefined();
			expect(res.body.subscriber.url).toBe('https://example.com/alerts/webhook');
			expect(res.body.subscriber.hasSecret).toBe(true);
			expect(res.body.subscriber.secret).toBeUndefined();
			expect(res.body.subscriber.filter.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
		});
	});

	describe('GET, PATCH, DELETE and TEST workflows', () => {
		it('completes the full lifecycle of an alert subscriber', async () => {
			// 1. Create
			const createRes = await request(app)
				.post('/api/alert-subscribers')
				.set('x-api-key', 'test-secret-key')
				.send({
					url: 'https://example.com/alerts/my-endpoint',
					secret: 'webhook-sec-1',
					description: 'Test Bridge',
				});
			expect(createRes.status).toBe(201);
			const subId = createRes.body.subscriber.id;

			// 2. Get single
			const getRes = await request(app)
				.get(`/api/alert-subscribers/${subId}`)
				.set('x-api-key', 'test-secret-key');
			expect(getRes.status).toBe(200);
			expect(getRes.body.subscriber.id).toBe(subId);
			expect(getRes.body.subscriber.hasSecret).toBe(true);
			expect(getRes.body.subscriber.secret).toBeUndefined();

			// 3. Update
			const patchRes = await request(app)
				.patch(`/api/alert-subscribers/${subId}`)
				.set('x-api-key', 'test-secret-key')
				.send({
					description: 'Updated Test Bridge',
					enabled: false,
				});
			expect(patchRes.status).toBe(200);
			expect(patchRes.body.subscriber.description).toBe('Updated Test Bridge');
			expect(patchRes.body.subscriber.enabled).toBe(false);

			// 4. Test endpoint
			const testRes = await request(app)
				.post(`/api/alert-subscribers/${subId}/test`)
				.set('x-api-key', 'test-secret-key')
				.send();
			expect(testRes.status).toBe(200);
			expect(testRes.body.success).toBe(true);
			expect(testRes.body.delivery).toBeDefined();

			// 5. Delete
			const deleteRes = await request(app)
				.delete(`/api/alert-subscribers/${subId}`)
				.set('x-api-key', 'test-secret-key');
			expect(deleteRes.status).toBe(200);
			expect(deleteRes.body.success).toBe(true);

			// 6. Get after delete -> 404
			const getAfterRes = await request(app)
				.get(`/api/alert-subscribers/${subId}`)
				.set('x-api-key', 'test-secret-key');
			expect(getAfterRes.status).toBe(404);
		});
	});

	describe('/api/status integration', () => {
		it('reports dependencies.alertSubscribers and featureFlags.firestoreAlertSubscribers', async () => {
			const res = await request(app)
				.get('/api/status')
				.set('x-api-key', 'test-secret-key');
			expect(res.status).toBe(200);
			expect(res.body.featureFlags).toHaveProperty('firestoreAlertSubscribers');
			expect(res.body.dependencies).toHaveProperty('alertSubscribers');
			expect(res.body.dependencies.alertSubscribers.collection).toBe('alertSubscribers');
			expect(res.body.dependencies.alertSubscribers.mode).toBe('ephemeral');
			expect(res.body.dependencies.alertSubscribers.backend).toBe('memory');
		});
	});
});
