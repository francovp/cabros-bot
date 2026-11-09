'use strict';

const { validateApiKey } = require('../../src/lib/auth');
const { validateAdminAccess } = require('../../src/lib/adminAuth');
const {
	_setAuditLogListenerForTest,
	_resetAuditLoggerForTest,
	AUDIT_CATEGORIES,
} = require('../../src/lib/auditLogger');

describe('Authentication Audit Logging (GH-740)', () => {
	let originalEnv;
	let auditEvents;

	beforeEach(() => {
		originalEnv = { ...process.env };
		auditEvents = [];
		_setAuditLogListenerForTest((evt) => auditEvents.push(evt));
		process.env.WEBHOOK_API_KEY = 'correct-webhook-key';
		process.env.ADMIN_API_KEY = 'correct-admin-key';
	});

	afterEach(() => {
		process.env = originalEnv;
		_resetAuditLoggerForTest();
	});

	describe('validateApiKey', () => {
		it('audits AUTH_FAILURE on missing API key', () => {
			const req = {
				headers: {},
				query: {},
				url: '/api/webhook/alert',
				requestId: 'req-auth-1',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateApiKey(req, res, next);

			expect(res.status).toHaveBeenCalledWith(401);
			expect(next).not.toHaveBeenCalled();
			expect(auditEvents).toHaveLength(1);
			expect(auditEvents[0]).toMatchObject({
				stream: 'audit',
				category: AUDIT_CATEGORIES.AUTH_FAILURE,
				action: 'validate_api_key',
				result: 'failure',
				requestId: 'req-auth-1',
				details: expect.objectContaining({
					reason: 'missing_api_key',
				}),
			});
		});

		it('audits AUTH_FAILURE on invalid API key', () => {
			const req = {
				headers: { 'x-api-key': 'wrong-key' },
				query: {},
				url: '/api/webhook/alert',
				requestId: 'req-auth-2',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateApiKey(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
			expect(auditEvents).toHaveLength(1);
			expect(auditEvents[0]).toMatchObject({
				stream: 'audit',
				category: AUDIT_CATEGORIES.AUTH_FAILURE,
				action: 'validate_api_key',
				result: 'failure',
				requestId: 'req-auth-2',
				details: expect.objectContaining({
					reason: 'invalid_api_key',
				}),
			});
		});
	});

	describe('validateAdminAccess', () => {
		it('audits AUTH_FAILURE on invalid admin API key', async () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'false';
			const req = {
				headers: { 'x-api-key': 'bad-admin-key' },
				query: {},
				url: '/api/admin/events',
				requestId: 'req-auth-3',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			await validateAdminAccess(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(auditEvents.length).toBeGreaterThanOrEqual(1);
			const authFailure = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.AUTH_FAILURE);
			expect(authFailure).toMatchObject({
				stream: 'audit',
				category: AUDIT_CATEGORIES.AUTH_FAILURE,
				result: 'failure',
				requestId: 'req-auth-3',
				details: expect.objectContaining({
					reason: 'invalid_api_key',
				}),
			});
		});
	});
});
