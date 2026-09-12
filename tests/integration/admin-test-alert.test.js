'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	saveAlert: jest.fn(),
	listAlerts: jest.fn(),
	getAlertById: jest.fn(),
	getLatestReplayForAlert: jest.fn(),
	parseAlertPaginationCursor: jest.fn(),
}));

jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => {
	const original = jest.requireActual('../../src/controllers/webhooks/handlers/alert/alert');
	return {
		...original,
		getNotificationManager: jest.fn(),
		initializeNotificationServices: jest.fn(),
	};
});

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const alertHandler = require('../../src/controllers/webhooks/handlers/alert/alert');
const { _resetForTesting } = require('../../src/controllers/admin/testAlert');
const { getRoutes } = require('../../src/routes');

describe('POST /api/admin/test-alert Integration', () => {
	let app;
	let mockNotificationManager;
	let savedEnv;

	beforeEach(() => {
		_resetForTesting();
		jest.clearAllMocks();
		savedEnv = { ...process.env };
		process.env.WEBHOOK_API_KEY = 'secret-operator-key';
		process.env.ENABLE_TEST_ALERT = 'true';
		delete process.env.TEST_ALERT_DAILY_LIMIT;

		mockNotificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
			sendToChannels: jest.fn().mockResolvedValue([
				{ channel: 'telegram', success: true, messageId: '12345', durationMs: 80, attemptCount: 1 },
			]),
			isChannelEnabled: jest.fn((ch) => ch === 'telegram' || ch === 'whatsapp' || ch === 'discord'),
		};
		alertHandler.getNotificationManager.mockReturnValue(mockNotificationManager);
		alertHandler.initializeNotificationServices.mockResolvedValue(mockNotificationManager);
		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.saveAlert.mockImplementation(async (alert) => {
			return 'stored-test-alert-id';
		});

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	it('rejects requests without an API key with 401 Unauthorized', async () => {
		const res = await request(app)
			.post('/api/admin/test-alert')
			.send({ text: 'Smoke probe test' });

		expect(res.status).toBe(401);
		expect(res.body.error).toContain('Unauthorized');
	});

	it('rejects requests with an invalid API key with 403 Forbidden', async () => {
		const res = await request(app)
			.post('/api/admin/test-alert')
			.set('x-api-key', 'wrong-key')
			.send({ text: 'Smoke probe test' });

		expect(res.status).toBe(403);
		expect(res.body.error).toContain('Forbidden');
	});

	it('returns 403 when test alert is disabled via ENABLE_TEST_ALERT=false', async () => {
		process.env.ENABLE_TEST_ALERT = 'false';

		const res = await request(app)
			.post('/api/admin/test-alert')
			.set('x-api-key', 'secret-operator-key')
			.send({ text: 'Smoke probe test' });

		expect(res.status).toBe(403);
		expect(res.body).toEqual({
			error: 'Test alert endpoint is disabled',
			code: 'FEATURE_DISABLED',
		});
	});

	it('executes dry-run mode returning formatted preview without side effects', async () => {
		const res = await request(app)
			.post('/api/admin/test-alert')
			.set('x-api-key', 'secret-operator-key')
			.send({
				dryRun: true,
				text: 'Dry run test alert content',
				channels: ['telegram'],
			});

		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.dryRun).toBe(true);
		expect(res.body.persisted).toBe(false);
		expect(res.body.results).toEqual([]);
		expect(res.body.formatted).toHaveProperty('telegram');
		expect(res.body.formatted.telegram.length).toBeGreaterThan(0);
		expect(mockNotificationManager.sendToChannels).not.toHaveBeenCalled();
		expect(alertStorageService.saveAlert).not.toHaveBeenCalled();
	});

	it('executes live probe alert, persists with source test-alert, and returns delivery results', async () => {
		const res = await request(app)
			.post('/api/admin/test-alert')
			.set('x-api-key', 'secret-operator-key')
			.send({
				text: 'Live probe alert message',
				channels: ['telegram'],
			});

		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.dryRun).toBe(false);
		expect(res.body.persisted).toBe(true);
		expect(res.body.alertId).toBe('stored-test-alert-id');
		expect(res.body.results).toEqual([
			{ channel: 'telegram', success: true, messageId: '12345', durationMs: 80, attemptCount: 1 },
		]);

		expect(alertStorageService.saveAlert).toHaveBeenCalledWith(
			expect.objectContaining({
				source: 'test-alert',
				text: 'Live probe alert message',
				channels: ['telegram'],
			}),
		);
	});

	it('enforces 60-second rate limiting on consecutive probe requests', async () => {
		// First call succeeds
		const firstRes = await request(app)
			.post('/api/admin/test-alert')
			.set('x-api-key', 'secret-operator-key')
			.send({ text: 'First probe' });

		expect(firstRes.status).toBe(200);

		// Immediate second call fails with 429
		const secondRes = await request(app)
			.post('/api/admin/test-alert')
			.set('x-api-key', 'secret-operator-key')
			.send({ text: 'Second probe' });

		expect(secondRes.status).toBe(429);
		expect(secondRes.body.code).toBe('RATE_LIMITED');
		expect(secondRes.headers['retry-after']).toBeDefined();
	});

	it('rejects invalid channel selections with 400 Bad Request', async () => {
		const res = await request(app)
			.post('/api/admin/test-alert')
			.set('x-api-key', 'secret-operator-key')
			.send({
				channels: ['unsupported_channel'],
			});

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});
});
