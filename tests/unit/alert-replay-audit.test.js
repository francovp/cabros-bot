'use strict';

const { replayAlert } = require('../../src/controllers/alerts/alerts');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
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

	beforeEach(() => {
		originalEnv = { ...process.env };
		auditEvents = [];
		_setAuditLogListenerForTest((evt) => auditEvents.push(evt));
		origIsEnabled = alertStorageService.isEnabled;
		origGetAlertById = alertStorageService.getAlertById;
		alertStorageService.isEnabled = jest.fn(() => true);
	});

	afterEach(() => {
		process.env = originalEnv;
		_resetAuditLoggerForTest();
		alertStorageService.isEnabled = origIsEnabled;
		alertStorageService.getAlertById = origGetAlertById;
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

		const replayAudit = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ADMIN_ACTION);
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

		const replayAudit = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ADMIN_ACTION);
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
});
