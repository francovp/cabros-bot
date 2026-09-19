'use strict';

const request = require('supertest');
const express = require('express');
const { generateKeyPairSync } = require('crypto');
const admin = require('firebase-admin');
const { getRoutes } = require('../../src/routes');
const { resetNewsMonitorPauseStateForTest } = require('../../src/controllers/webhooks/handlers/newsMonitor/pauseState');

jest.mock('firebase-admin');

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});

describe('News Monitor Pause/Resume Endpoints', () => {
	let app;
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		process.env.WEBHOOK_API_KEY = 'secret-api-key';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		resetNewsMonitorPauseStateForTest();

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => null));
	});

	afterEach(() => {
		resetNewsMonitorPauseStateForTest();
		restoreEnv(savedEnv);
	});

	describe('Authentication & Authorization', () => {
		it('rejects POST /api/news-monitor/pause without authentication', async () => {
			const res = await request(app)
				.post('/api/news-monitor/pause')
				.send({ reason: 'Outage' });

			expect(res.status).toBe(401);
		});

		it('rejects POST /api/news-monitor/resume without authentication', async () => {
			const res = await request(app)
				.post('/api/news-monitor/resume');

			expect(res.status).toBe(401);
		});

		it('rejects GET /api/news-monitor/status without authentication', async () => {
			const res = await request(app)
				.get('/api/news-monitor/status');

			expect(res.status).toBe(401);
		});

		it('accepts valid API key on pause, resume, and status endpoints', async () => {
			const statusRes = await request(app)
				.get('/api/news-monitor/status')
				.set('x-api-key', 'secret-api-key');
			expect(statusRes.status).toBe(200);
			expect(statusRes.body).toEqual({
				paused: false,
				pausedAt: null,
				reason: null,
			});

			const pauseRes = await request(app)
				.post('/api/news-monitor/pause')
				.set('x-api-key', 'secret-api-key')
				.send({ reason: 'Gemini quota event' });
			expect(pauseRes.status).toBe(200);
			expect(pauseRes.body).toMatchObject({
				message: 'News monitor analysis paused',
				paused: true,
				reason: 'Gemini quota event',
			});

			const resumeRes = await request(app)
				.post('/api/news-monitor/resume')
				.set('x-api-key', 'secret-api-key');
			expect(resumeRes.status).toBe(200);
			expect(resumeRes.body).toMatchObject({
				message: 'News monitor analysis resumed',
				paused: false,
			});
		});

		describe('Firebase Admin Auth Roles', () => {
			beforeEach(() => {
				process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
				process.env.FIREBASE_PROJECT_ID = 'test-project';
				process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
					type: 'service_account',
					project_id: 'test-project',
					client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
					private_key: privateKey,
				});
				admin.__resetApps();
			});

			it('allows admin.viewer to read status but denies pause and resume', async () => {
				admin.auth = jest.fn(() => ({
					verifyIdToken: jest.fn().mockResolvedValue({
						uid: 'viewer-1',
						roles: ['admin.viewer'],
					}),
				}));

				const statusRes = await request(app)
					.get('/api/news-monitor/status')
					.set('Authorization', 'Bearer viewer-token');
				expect(statusRes.status).toBe(200);

				const pauseRes = await request(app)
					.post('/api/news-monitor/pause')
					.set('Authorization', 'Bearer viewer-token')
					.send({ reason: 'Operator action' });
				expect(pauseRes.status).toBe(403);
				expect(pauseRes.body.code).toBe('ADMIN_ROLE_REQUIRED');

				const resumeRes = await request(app)
					.post('/api/news-monitor/resume')
					.set('Authorization', 'Bearer viewer-token');
				expect(resumeRes.status).toBe(403);
				expect(resumeRes.body.code).toBe('ADMIN_ROLE_REQUIRED');
			});

			it('allows admin.operator to pause and resume', async () => {
				admin.auth = jest.fn(() => ({
					verifyIdToken: jest.fn().mockResolvedValue({
						uid: 'operator-1',
						roles: ['admin.operator'],
					}),
				}));

				const pauseRes = await request(app)
					.post('/api/news-monitor/pause')
					.set('Authorization', 'Bearer operator-token')
					.send({ reason: 'Incident response' });
				expect(pauseRes.status).toBe(200);
				expect(pauseRes.body.paused).toBe(true);

				const resumeRes = await request(app)
					.post('/api/news-monitor/resume')
					.set('Authorization', 'Bearer operator-token');
				expect(resumeRes.status).toBe(200);
				expect(resumeRes.body.paused).toBe(false);
			});
		});
	});

	describe('Pause / Resume Lifecycle & Impact on News Monitor', () => {
		it('surfaces pause state in GET /api/news-monitor/status and /api/status', async () => {
			// Initially not paused
			let statusRes = await request(app)
				.get('/api/news-monitor/status')
				.set('x-api-key', 'secret-api-key');
			expect(statusRes.status).toBe(200);
			expect(statusRes.body.paused).toBe(false);

			// Pause it
			const pauseRes = await request(app)
				.post('/api/news-monitor/pause')
				.set('x-api-key', 'secret-api-key')
				.send({ reason: 'External provider outage' });
			expect(pauseRes.status).toBe(200);
			expect(pauseRes.body.paused).toBe(true);
			expect(pauseRes.body.reason).toBe('External provider outage');
			expect(pauseRes.body.pausedAt).toEqual(expect.any(String));

			// Check /api/news-monitor/status
			statusRes = await request(app)
				.get('/api/news-monitor/status')
				.set('x-api-key', 'secret-api-key');
			expect(statusRes.status).toBe(200);
			expect(statusRes.body).toEqual({
				paused: true,
				pausedAt: pauseRes.body.pausedAt,
				reason: 'External provider outage',
			});

			// Check /api/status
			const apiStatusRes = await request(app)
				.get('/api/status')
				.set('x-api-key', 'secret-api-key');
			expect(apiStatusRes.status).toBe(200);
			expect(apiStatusRes.body.featureFlags.newsMonitorPaused).toBe(true);
			expect(apiStatusRes.body.dependencies.newsMonitor).toEqual(expect.objectContaining({
				enabled: true,
				paused: true,
				reason: 'External provider outage',
				pausedAt: pauseRes.body.pausedAt,
			}));
			expect(apiStatusRes.body.dependencies.newsMonitorScheduler.paused).toBe(true);

			// Calling /api/news-monitor returns 503 NEWS_MONITOR_PAUSED
			const newsPostRes = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'secret-api-key')
				.send({ crypto: ['BTCUSDT'] });
			expect(newsPostRes.status).toBe(503);
			expect(newsPostRes.body).toMatchObject({
				code: 'NEWS_MONITOR_PAUSED',
				paused: true,
				reason: 'External provider outage',
				pausedAt: pauseRes.body.pausedAt,
				requestId: expect.any(String),
			});
			expect(newsPostRes.body.error).toContain('temporarily paused: External provider outage');

			// Calling GET /api/news-monitor also returns 503
			const newsGetRes = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT')
				.set('x-api-key', 'secret-api-key');
			expect(newsGetRes.status).toBe(503);
			expect(newsGetRes.body.code).toBe('NEWS_MONITOR_PAUSED');

			// Resume it
			const resumeRes = await request(app)
				.post('/api/news-monitor/resume')
				.set('x-api-key', 'secret-api-key');
			expect(resumeRes.status).toBe(200);
			expect(resumeRes.body).toMatchObject({
				message: 'News monitor analysis resumed',
				paused: false,
				resumedAt: expect.any(String),
			});

			// Status is back to unpaused
			statusRes = await request(app)
				.get('/api/news-monitor/status')
				.set('x-api-key', 'secret-api-key');
			expect(statusRes.status).toBe(200);
			expect(statusRes.body.paused).toBe(false);
			expect(statusRes.body.pausedAt).toBeNull();
			expect(statusRes.body.reason).toBeNull();

			// /api/status is back to unpaused
			const resumedApiStatusRes = await request(app)
				.get('/api/status')
				.set('x-api-key', 'secret-api-key');
			expect(resumedApiStatusRes.status).toBe(200);
			expect(resumedApiStatusRes.body.featureFlags.newsMonitorPaused).toBe(false);
			expect(resumedApiStatusRes.body.dependencies.newsMonitor.paused).toBe(false);
		});
	});
});
