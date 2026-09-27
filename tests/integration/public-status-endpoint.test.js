const request = require('supertest');
const express = require('express');
const app = require('../../app');
const bootstrapReadiness = require('../../src/lib/bootstrapReadiness');
const { resetPublicStatusCacheForTesting } = require('../../src/controllers/publicStatus');

describe('GET /api/public/status', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		Object.keys(process.env).forEach((key) => {
			delete process.env[key];
		});
		process.env.NODE_ENV = 'test';
		process.env.SERVICE_NAME = 'cabros-bot-test';
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'token';
		process.env.TELEGRAM_CHAT_ID = '123';
		process.env.WEBHOOK_API_KEY = 'status-key';
		bootstrapReadiness.reset();
		resetPublicStatusCacheForTesting();
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		bootstrapReadiness.reset();
		resetPublicStatusCacheForTesting();
	});

	function readyApp() {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		bootstrapReadiness.markDisabled('telegramBot');
		bootstrapReadiness.markDisabled('notificationServices');
		bootstrapReadiness.markDisabled('newsMonitor');
	}

	it('does not require authentication', async () => {
		readyApp();
		const response = await request(app).get('/api/public/status');
		expect(response.status).toBe(200);
		expect(response.body.service).toEqual({
			name: 'cabros-bot-test',
			version: expect.any(String),
		});
		expect(response.body.status.ok).toBe(true);
		expect(typeof response.body.status.uptimeSeconds).toBe('number');
		expect(typeof response.body.status.lastUpdated).toBe('string');
		expect(response.body.channels).toEqual(expect.objectContaining({
			enabled: expect.any(Array),
		}));
		expect(response.body.dependencies).toEqual(expect.objectContaining({
			gemini: expect.objectContaining({ ready: expect.any(Boolean) }),
			tradingview: expect.objectContaining({ ready: expect.any(Boolean) }),
			firestore: expect.objectContaining({ ready: expect.any(Boolean) }),
		}));
	});

	it('does not expose any sensitive field', async () => {
		readyApp();
		const response = await request(app).get('/api/public/status');
		expect(response.status).toBe(200);
		expect(response.body).not.toHaveProperty('featureFlags');
		expect(response.body).not.toHaveProperty('deliveryMetrics');
		expect(response.body).not.toHaveProperty('readiness');
		expect(response.body.service).not.toHaveProperty('commit');
		expect(response.body.service).not.toHaveProperty('environment');
		expect(response.body.dependencies.gemini).not.toHaveProperty('configured');
		expect(response.body.dependencies.firestore).not.toHaveProperty('configured');
		expect(response.body.dependencies.tradingview).not.toHaveProperty('configured');
	});

	it('returns 503 with SERVICE_NOT_READY when the process is still bootstrapping', async () => {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		const response = await request(app).get('/api/public/status');
		expect(response.status).toBe(503);
		expect(response.body.status.ok).toBe(false);
		expect(response.body.code).toBe('SERVICE_NOT_READY');
		expect(response.body.error).toBe('service_not_ready');
	});

	it('is not subject to the global rate limiter', async () => {
		readyApp();
		const before = process.env.ENABLE_TEST_RATE_LIMITER;
		process.env.ENABLE_TEST_RATE_LIMITER = 'true';

		try {
			for (let i = 0; i < 150; i += 1) {
				const response = await request(app).get('/api/public/status');
				if (response.status === 429) {
					throw new Error(`Rate limited at iteration ${i}`);
				}
				expect(response.status).toBe(200);
			}
		} finally {
			if (before === undefined) {
				delete process.env.ENABLE_TEST_RATE_LIMITER;
			} else {
				process.env.ENABLE_TEST_RATE_LIMITER = before;
			}
		}
	});

	it('serves a successful 200 with valid contract regardless of auth header', async () => {
		readyApp();
		const noAuth = await request(app).get('/api/public/status');
		const withHeader = await request(app)
			.get('/api/public/status')
			.set('x-api-key', 'status-key');
		expect(noAuth.status).toBe(200);
		expect(withHeader.status).toBe(200);
		expect(withHeader.body).toEqual(noAuth.body);
	});
});