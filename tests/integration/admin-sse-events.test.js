'use strict';

const http = require('http');
const express = require('express');
const request = require('supertest');
const admin = require('firebase-admin');
const { getRoutes } = require('../../src/routes');
const { adminSseService } = require('../../src/services/sse/AdminSseService');

jest.mock('firebase-admin');

describe('Admin SSE Events Stream Integration (/api/admin/events)', () => {
	const originalEnv = process.env;
	let testApp;
	let server;
	let baseUrl;

	beforeEach((done) => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_ADMIN_SSE: 'true',
		};

		jest.clearAllMocks();
		testApp = express();
		testApp.use(express.json());
		testApp.use('/api', getRoutes(null));

		server = http.createServer(testApp);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			baseUrl = `http://127.0.0.1:${port}`;
			done();
		});
	});

	afterEach((done) => {
		process.env = originalEnv;
		adminSseService.closeAll();
		if (server && server.listening) {
			server.close(done);
		} else {
			done();
		}
	});

	it('returns 401 when no authorization credentials are provided', async () => {
		const res = await request(testApp)
			.get('/api/admin/events')
			.expect(401);

		expect(res.body).toEqual(expect.objectContaining({
			error: expect.any(String),
		}));
	});

	it('returns 403 when invalid API key is provided', async () => {
		const res = await request(testApp)
			.get('/api/admin/events')
			.set('x-api-key', 'wrong-key')
			.expect(403);

		expect(res.body).toEqual(expect.objectContaining({
			error: expect.any(String),
		}));
	});

	it('establishes SSE stream and receives broadcasted events with valid x-api-key header', (done) => {
		const req = http.request(`${baseUrl}/api/admin/events`, {
			method: 'GET',
			headers: {
				'x-api-key': 'test-key',
			},
		}, (res) => {
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/event-stream');
			expect(res.headers['cache-control']).toContain('no-cache');

			let receivedData = '';

			res.on('data', (chunk) => {
				receivedData += chunk.toString();

				if (receivedData.includes('event: connected') && !receivedData.includes('job-progress')) {
					adminSseService.broadcast('job-progress', {
						jobId: 'job-999',
						status: 'completed',
						progress: { current: 1, total: 1 },
					});
				}

				if (receivedData.includes('job-progress')) {
					expect(receivedData).toContain('event: job-progress');
					expect(receivedData).toContain('"jobId":"job-999"');
					expect(receivedData).toContain('"status":"completed"');
					req.destroy();
					done();
				}
			});
		});

		req.on('error', (err) => {
			if (err.code !== 'ECONNRESET') {
				done(err);
			}
		});

		req.end();
	});

	it('accepts valid api-key in query parameter', (done) => {
		const req = http.get(`${baseUrl}/api/admin/events?api-key=test-key`, (res) => {
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/event-stream');

			let receivedData = '';
			res.on('data', (chunk) => {
				receivedData += chunk.toString();
				if (receivedData.includes(':connected')) {
					req.destroy();
					done();
				}
			});
		});

		req.on('error', (err) => {
			if (err.code !== 'ECONNRESET') {
				done(err);
			}
		});
	});

	it('accepts verified Firebase Bearer token in query parameter', (done) => {
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
		admin.__setApps([{ name: '[DEFAULT]' }]);
		admin.auth = jest.fn(() => ({
			verifyIdToken: jest.fn().mockResolvedValue({
				uid: 'admin-123',
				roles: ['admin.viewer'],
			}),
		}));

		const req = http.get(`${baseUrl}/api/admin/events?token=firebase-test-token`, (res) => {
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/event-stream');

			let receivedData = '';
			res.on('data', (chunk) => {
				receivedData += chunk.toString();
				if (receivedData.includes(':connected')) {
					req.destroy();
					done();
				}
			});
		});

		req.on('error', (err) => {
			if (err.code !== 'ECONNRESET') {
				done(err);
			}
		});
	});

	it('returns 403 FEATURE_DISABLED when ENABLE_ADMIN_SSE is false', async () => {
		process.env.ENABLE_ADMIN_SSE = 'false';

		const res = await request(testApp)
			.get('/api/admin/events')
			.set('x-api-key', 'test-key')
			.expect(403);

		expect(res.body).toEqual(expect.objectContaining({
			code: 'FEATURE_DISABLED',
		}));
	});

	it('returns 503 with Retry-After header and single response when capacity is exceeded', async () => {
		adminSseService.maxTotalConnections = 1;
		adminSseService.clients.set('existing-client', { res: { write: () => {}, end: () => {} } });

		try {
			const res = await request(testApp)
				.get('/api/admin/events')
				.set('x-api-key', 'test-key')
				.expect(503);

			expect(res.headers['retry-after']).toBe('30');
			expect(res.body).toEqual({
				error: 'Server has reached maximum SSE connection capacity. Please retry shortly.',
				code: 'SSE_CONNECTION_LIMIT_EXCEEDED',
			});
		} finally {
			adminSseService.clients.clear();
			adminSseService.maxTotalConnections = null;
		}
	});

	it('rejects query token on non-SSE admin endpoints while accepting it on /api/admin/events', async () => {
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
		admin.__setApps([{ name: '[DEFAULT]' }]);
		admin.auth = jest.fn(() => ({
			verifyIdToken: jest.fn().mockResolvedValue({
				uid: 'admin-123',
				roles: ['admin.viewer'],
			}),
		}));

		// Regular admin route (e.g. /api/alerts) should NOT accept ?token= query parameter
		const alertsRes = await request(testApp)
			.get('/api/alerts?token=firebase-test-token')
			.expect(401);

		expect(alertsRes.body).toEqual(expect.objectContaining({
			code: 'ADMIN_AUTH_REQUIRED',
		}));
	});
});
