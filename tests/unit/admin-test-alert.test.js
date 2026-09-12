'use strict';

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	saveAlert: jest.fn(),
}));

jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => {
	const original = jest.requireActual('../../src/controllers/webhooks/handlers/alert/alert');
	return {
		...original,
		getNotificationManager: jest.fn(),
		initializeNotificationServices: jest.fn(),
		processEnrichment: jest.fn(),
	};
});

jest.mock('../../src/services/monitoring/SentryService', () => ({
	getActiveSpan: jest.fn().mockReturnValue(null),
}));

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const alertHandler = require('../../src/controllers/webhooks/handlers/alert/alert');
const {
	postTestAlert,
	isTestAlertEnabled,
	getLastRunAt,
	getLastRunStatus,
	getRateLimitState,
	_resetForTesting,
} = require('../../src/controllers/admin/testAlert');

describe('Admin Test Alert Controller Unit Tests', () => {
	let mockNotificationManager;
	let req;
	let res;

	beforeEach(() => {
		_resetForTesting();
		jest.clearAllMocks();
		delete process.env.ENABLE_TEST_ALERT;
		delete process.env.TEST_ALERT_DAILY_LIMIT;

		mockNotificationManager = {
			getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
			sendToChannels: jest.fn().mockResolvedValue([
				{ channel: 'telegram', success: true, messageId: 'tg-100', durationMs: 150, attemptCount: 1 },
			]),
			isChannelEnabled: jest.fn((ch) => ch === 'telegram' || ch === 'whatsapp' || ch === 'discord'),
		};
		alertHandler.getNotificationManager.mockReturnValue(mockNotificationManager);
		alertHandler.initializeNotificationServices.mockResolvedValue(mockNotificationManager);
		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.saveAlert.mockResolvedValue('alert-test-doc-123');

		req = {
			headers: { 'x-api-key': 'valid-operator-key' },
			body: {},
			query: {},
			ip: '127.0.0.1',
		};

		res = {
			statusCode: 200,
			headers: {},
			set: jest.fn(function (key, val) {
				this.headers[key] = val;
				return this;
			}),
			status: jest.fn(function (code) {
				this.statusCode = code;
				return this;
			}),
			json: jest.fn(function (data) {
				this.data = data;
				return this;
			}),
		};
	});

	it('returns 403 when test alert is disabled via ENABLE_TEST_ALERT=false', async () => {
		process.env.ENABLE_TEST_ALERT = 'false';
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(res.data).toEqual({
			error: 'Test alert endpoint is disabled',
			code: 'FEATURE_DISABLED',
		});
	});

	it('enforces 60-second rate limit per admin caller with Retry-After header', async () => {
		const handler = postTestAlert();

		// First call succeeds
		await handler(req, res);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.data.ok).toBe(true);

		// Second call within 60s fails with 429
		const res2 = {
			headers: {},
			set: jest.fn(function (k, v) { this.headers[k] = v; return this; }),
			status: jest.fn(function (c) { this.statusCode = c; return this; }),
			json: jest.fn(function (d) { this.data = d; return this; }),
		};
		await handler(req, res2);
		expect(res2.status).toHaveBeenCalledWith(429);
		expect(res2.data.code).toBe('RATE_LIMITED');
		expect(res2.data.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		expect(res2.headers['Retry-After']).toBeDefined();
	});

	it('tracks rate limits independently for different admin identities', async () => {
		const handler = postTestAlert();

		// Caller 1 succeeds
		req.user = { uid: 'admin-user-1' };
		await handler(req, res);
		expect(res.status).toHaveBeenCalledWith(200);

		// Caller 2 also succeeds immediately
		const req2 = {
			user: { uid: 'admin-user-2' },
			headers: {},
			body: {},
			query: {},
			ip: '127.0.0.2',
		};
		const res2 = {
			headers: {},
			set: jest.fn(),
			status: jest.fn(function (c) { this.statusCode = c; return this; }),
			json: jest.fn(function (d) { this.data = d; return this; }),
		};
		await handler(req2, res2);
		expect(res2.status).toHaveBeenCalledWith(200);
	});

	it('enforces daily rate limit when TEST_ALERT_DAILY_LIMIT is reached', async () => {
		process.env.TEST_ALERT_DAILY_LIMIT = '2';
		const handler = postTestAlert();

		// Call 1
		req.user = { uid: 'admin-1' };
		await handler(req, res);
		expect(res.status).toHaveBeenCalledWith(200);

		// Call 2
		const req2 = { user: { uid: 'admin-2' }, headers: {}, body: {} };
		const res2 = {
			headers: {},
			set: jest.fn(),
			status: jest.fn(function (c) { this.statusCode = c; return this; }),
			json: jest.fn(function (d) { this.data = d; return this; }),
		};
		await handler(req2, res2);
		expect(res2.status).toHaveBeenCalledWith(200);

		// Call 3 exceeds daily limit
		const req3 = { user: { uid: 'admin-3' }, headers: {}, body: {} };
		const res3 = {
			headers: {},
			set: jest.fn(),
			status: jest.fn(function (c) { this.statusCode = c; return this; }),
			json: jest.fn(function (d) { this.data = d; return this; }),
		};
		await handler(req3, res3);
		expect(res3.status).toHaveBeenCalledWith(429);
		expect(res3.data.code).toBe('RATE_LIMITED');
		expect(res3.data.error).toContain('Daily test alert limit reached');
	});

	it('validates channels and returns 400 when invalid channel is provided', async () => {
		req.body = { channels: ['invalid_channel'] };
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.data.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when no channels are enabled', async () => {
		mockNotificationManager.getEnabledChannels.mockReturnValue([]);
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.data.error).toBe('No notification channels are enabled');
		expect(res.data.code).toBe('INVALID_REQUEST');
	});

	it('executes dry-run mode without dispatching or persisting', async () => {
		req.body = {
			dryRun: true,
			text: 'Test probe dry run',
			channels: ['telegram'],
		};
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.data.ok).toBe(true);
		expect(res.data.dryRun).toBe(true);
		expect(res.data.persisted).toBe(false);
		expect(res.data.results).toEqual([]);
		expect(res.data.formatted).toHaveProperty('telegram');
		expect(res.data.formatted.telegram.preview).toBeDefined();
		expect(mockNotificationManager.sendToChannels).not.toHaveBeenCalled();
		expect(alertStorageService.saveAlert).not.toHaveBeenCalled();
		expect(getLastRunStatus()).toBe('dry-run');
	});

	it('executes live alert delivery and persists to Firestore with source test-alert', async () => {
		req.body = {
			text: 'BTCUSDT Bullish Breakout Test',
			channels: ['telegram'],
		};
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.data.ok).toBe(true);
		expect(res.data.dryRun).toBe(false);
		expect(res.data.persisted).toBe(true);
		expect(res.data.alertId).toBe('alert-test-doc-123');
		expect(alertStorageService.saveAlert).toHaveBeenCalledWith(
			expect.objectContaining({
				source: 'test-alert',
				text: 'BTCUSDT Bullish Breakout Test',
				channels: ['telegram'],
			}),
		);
		expect(getLastRunStatus()).toBe('success');
		expect(getLastRunAt()).toBeDefined();
	});

	it('handles partial delivery failure and reflects in lastRunStatus', async () => {
		mockNotificationManager.getEnabledChannels.mockReturnValue(['telegram', 'whatsapp']);
		mockNotificationManager.sendToChannels.mockResolvedValue([
			{ channel: 'telegram', success: true, messageId: 'tg-1' },
			{ channel: 'whatsapp', success: false, error: { message: 'GreenAPI timeout' } },
		]);

		req.body = { channels: ['telegram', 'whatsapp'] };
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.data.ok).toBe(false);
		expect(getLastRunStatus()).toBe('partial');
	});

	it('applies enrichment when includeEnrichment is true', async () => {
		alertHandler.processEnrichment.mockImplementation(async (alert, opts) => {
			alert.enriched = {
				symbol: 'BTCUSDT',
				analysis: 'Test analysis',
			};
			opts.tokenUsage.addUsage({
				inputTokens: 100,
				outputTokens: 50,
			});
			return true;
		});

		req.body = {
			includeEnrichment: true,
			channels: ['telegram'],
		};
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.data.enrichmentApplied).toBe(true);
		expect(res.data.tokenUsage).toMatchObject({
			totalTokens: 150,
		});
	});

	it('keys rate limiting by req.adminUser.uid when present', async () => {
		const handler = postTestAlert();
		req.adminUser = { uid: 'verified-admin-uid-1' };
		delete req.user;
		await handler(req, res);
		expect(res.status).toHaveBeenCalledWith(200);

		// Immediate second call by same adminUser is rate limited
		const req2 = {
			adminUser: { uid: 'verified-admin-uid-1' },
			headers: {},
			body: {},
			query: {},
			ip: '10.0.0.99', // different IP, but same adminUser
		};
		const res2 = {
			headers: {},
			set: jest.fn(),
			status: jest.fn(function (c) { this.statusCode = c; return this; }),
			json: jest.fn(function (d) { this.data = d; return this; }),
		};
		await handler(req2, res2);
		expect(res2.status).toHaveBeenCalledWith(429);
		expect(res2.data.code).toBe('RATE_LIMITED');
	});

	it('handles Firestore persistence error gracefully and returns 200 with persisted: false', async () => {
		alertStorageService.saveAlert.mockRejectedValueOnce(new Error('Firestore connection timeout'));
		req.body = { channels: ['telegram'] };
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.data.ok).toBe(true);
		expect(res.data.persisted).toBe(false);
	});

	it('uses channel formatters for enriched dry-run previews on whatsapp and discord', async () => {
		mockNotificationManager.getEnabledChannels.mockReturnValue(['telegram', 'whatsapp', 'discord']);
		alertHandler.processEnrichment.mockImplementation(async (alert) => {
			alert.enriched = {
				symbol: 'ETHUSDT',
				original_text: 'Ethereum technical analysis breakdown',
				insights: ['Key resistance broken'],
			};
			return true;
		});

		req.body = {
			dryRun: true,
			includeEnrichment: true,
			channels: ['telegram', 'whatsapp', 'discord'],
		};
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.data.dryRun).toBe(true);
		expect(res.data.results).toEqual([]);
		expect(res.data.formatted).toHaveProperty('telegram');
		expect(res.data.formatted).toHaveProperty('whatsapp');
		expect(res.data.formatted).toHaveProperty('discord');
		expect(res.data.formatted.whatsapp.text).toContain('Ethereum');
		expect(res.data.formatted.discord.text).toContain('Ethereum');
	});

	it('rejects invalid or empty string text with 400 Bad Request', async () => {
		req.body = { text: '' };
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.data.code).toBe('INVALID_REQUEST');
		expect(res.data.error).toContain('Alert text is required and must be a string');
	});

	it('omits raw discordWebhookUrl from Firestore persistence to protect credentials', async () => {
		req.body = {
			channels: ['telegram'],
			discordWebhookUrl: 'https://discord.com/api/webhooks/123456789/secret-webhook-token',
		};
		const handler = postTestAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(alertStorageService.saveAlert).toHaveBeenCalledWith(
			expect.not.objectContaining({
				discordWebhookUrl: expect.anything(),
			}),
		);
	});
});
