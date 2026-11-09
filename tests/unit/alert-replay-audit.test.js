'use strict';

const { replayAlert, batchReplayAlerts } = require('../../src/controllers/alerts/alerts');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const alertHandler = require('../../src/controllers/webhooks/handlers/alert/alert');
const {
	_setAuditLogListenerForTest,
	_resetAuditLoggerForTest,
	AUDIT_CATEGORIES,
} = require('../../src/lib/auditLogger');

describe('Alert Replay Audit Logging (GH-740)', () => {
	let originalEnv;
	let auditEvents;
	let origIsEnabled;
	let origGetAlertById;
	let origSaveReplayAttempt;
	let origGetNotificationManager;

	beforeEach(() => {
		originalEnv = { ...process.env };
		auditEvents = [];
		_setAuditLogListenerForTest((evt) => auditEvents.push(evt));
		origIsEnabled = alertStorageService.isEnabled;
		origGetAlertById = alertStorageService.getAlertById;
		origSaveReplayAttempt = alertStorageService.saveReplayAttempt;
		origGetNotificationManager = alertHandler.getNotificationManager;

		alertStorageService.isEnabled = jest.fn(() => true);
	});

	afterEach(() => {
		process.env = originalEnv;
		_resetAuditLoggerForTest();
		alertStorageService.isEnabled = origIsEnabled;
		alertStorageService.getAlertById = origGetAlertById;
		alertStorageService.saveReplayAttempt = origSaveReplayAttempt;
		alertHandler.getNotificationManager = origGetNotificationManager;
	});

	it('audits ADMIN_ACTION on dry-run alert replay', async () => {
		alertStorageService.getAlertById = jest.fn().mockResolvedValue({
			id: 'alert-123',
			text: 'BTC Breakout alert',
			channels: ['telegram'],
		});

		const req = {
			params: { alertId: 'alert-123' },
			body: {
				channels: ['telegram'],
				dryRun: true,
			},
			headers: {
				'x-idempotency-key': 'idemp-replay-1',
				'x-api-key': 'admin-key',
			},
			requestId: 'req-replay-1',
			ip: '127.0.0.1',
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		const handler = replayAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(auditEvents.length).toBeGreaterThanOrEqual(1);

		const replayAudit = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ADMIN_ACTION && e.action === 'alert_replay');
		expect(replayAudit).toMatchObject({
			stream: 'audit',
			category: 'ADMIN_ACTION',
			action: 'alert_replay',
			actor: 'api_key_shared',
			result: 'success',
			requestId: 'req-replay-1',
			details: expect.objectContaining({
				alertId: 'alert-123',
				channels: ['telegram'],
				dryRun: true,
			}),
		});
	});

	it('audits ADMIN_ACTION on live (non-dry-run) alert replay', async () => {
		alertStorageService.getAlertById = jest.fn().mockResolvedValue({
			id: 'alert-456',
			text: 'ETH Breakout alert',
			channels: ['telegram'],
		});
		alertStorageService.saveReplayAttempt = jest.fn().mockResolvedValue('replay-doc-789');

		const mockNotificationManager = {
			sendToChannels: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]),
		};
		alertHandler.getNotificationManager = jest.fn(() => mockNotificationManager);

		const req = {
			params: { alertId: 'alert-456' },
			body: {
				channels: ['telegram'],
				dryRun: false,
			},
			headers: {
				'x-idempotency-key': 'idemp-replay-live-1',
				'x-api-key': 'admin-key',
			},
			requestId: 'req-replay-live-1',
			ip: '127.0.0.1',
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		const handler = replayAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		expect(auditEvents.length).toBeGreaterThanOrEqual(1);

		const replayAudit = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ADMIN_ACTION && e.action === 'alert_replay');
		expect(replayAudit).toMatchObject({
			stream: 'audit',
			category: 'ADMIN_ACTION',
			action: 'alert_replay',
			actor: 'api_key_shared',
			result: 'success',
			requestId: 'req-replay-live-1',
			details: expect.objectContaining({
				alertId: 'alert-456',
				channels: ['telegram'],
				dryRun: false,
				replayId: 'replay-doc-789',
			}),
		});
	});

	it('audits ADMIN_ACTION failure when alert is not found', async () => {
		alertStorageService.getAlertById = jest.fn().mockResolvedValue(null);

		const req = {
			params: { alertId: 'missing-alert' },
			body: {
				channels: ['telegram'],
				dryRun: true,
			},
			headers: {
				'x-idempotency-key': 'idemp-replay-2',
				'x-api-key': 'admin-key',
			},
			requestId: 'req-replay-2',
			ip: '127.0.0.1',
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		const handler = replayAlert();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(auditEvents.length).toBeGreaterThanOrEqual(1);

		const replayAudit = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ADMIN_ACTION && e.action === 'alert_replay');
		expect(replayAudit).toMatchObject({
			stream: 'audit',
			category: 'ADMIN_ACTION',
			action: 'alert_replay',
			actor: 'api_key_shared',
			result: 'failure',
			requestId: 'req-replay-2',
			details: expect.objectContaining({
				alertId: 'missing-alert',
				reason: 'alert_not_found',
			}),
		});
	});

	it('audits ADMIN_ACTION on batch alert replay', async () => {
		alertStorageService.getAlertById = jest.fn().mockResolvedValue({
			id: 'alert-b1',
			text: 'SOL Alert',
			channels: ['telegram'],
		});

		const req = {
			body: {
				alertIds: ['alert-b1'],
				channels: ['telegram'],
				dryRun: true,
			},
			headers: {
				'x-idempotency-key': 'idemp-batch-1',
				'x-api-key': 'admin-key',
			},
			requestId: 'req-batch-1',
			ip: '127.0.0.1',
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		const handler = batchReplayAlerts();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		const batchAudit = auditEvents.find((e) => e.action === 'batch_alert_replay');
		expect(batchAudit).toMatchObject({
			stream: 'audit',
			category: 'ADMIN_ACTION',
			action: 'batch_alert_replay',
			result: 'success',
			requestId: 'req-batch-1',
			details: expect.objectContaining({
				count: 1,
				successCount: 1,
				failureCount: 0,
				channels: ['telegram'],
				dryRun: true,
			}),
		});
	});

	it('audits batch_alert_replay with failure when all requested alerts fail or are missing', async () => {
		alertStorageService.getAlertById = jest.fn().mockResolvedValue(null);

		const req = {
			body: {
				alertIds: ['missing-alert-1', 'missing-alert-2'],
				channels: ['telegram'],
				dryRun: true,
			},
			headers: {
				'x-idempotency-key': 'idemp-batch-2',
				'x-api-key': 'admin-key',
			},
			requestId: 'req-batch-2',
			ip: '127.0.0.1',
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		const handler = batchReplayAlerts();
		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(200);
		const batchAudit = auditEvents.find((e) => e.requestId === 'req-batch-2');
		expect(batchAudit).toMatchObject({
			stream: 'audit',
			category: 'ADMIN_ACTION',
			action: 'batch_alert_replay',
			result: 'failure',
			requestId: 'req-batch-2',
			details: expect.objectContaining({
				count: 2,
				successCount: 0,
				failureCount: 2,
				channels: ['telegram'],
				dryRun: true,
			}),
		});
	});
});
