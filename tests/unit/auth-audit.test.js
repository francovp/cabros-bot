'use strict';

const admin = require('firebase-admin');
const { validateApiKey } = require('../../src/lib/auth');
const { validateAdminAccess, validateBinanceTradingAccess } = require('../../src/lib/adminAuth');
const {
	_setAuditLogListenerForTest,
	_resetAuditLoggerForTest,
	AUDIT_CATEGORIES,
} = require('../../src/lib/auditLogger');

describe('Authentication Audit Logging (GH-740)', () => {
	let originalEnv;
	let auditEvents;
	let origAdminAuth;
	let origAdminApps;

	beforeEach(() => {
		originalEnv = { ...process.env };
		auditEvents = [];
		_setAuditLogListenerForTest((evt) => auditEvents.push(evt));
		origAdminAuth = admin.auth;
		origAdminApps = admin.apps;
		process.env.WEBHOOK_API_KEY = 'correct-webhook-key';
		process.env.ADMIN_API_KEY = 'correct-admin-key';
	});

	afterEach(() => {
		process.env = originalEnv;
		_resetAuditLoggerForTest();
		admin.auth = origAdminAuth;
		admin.apps = origAdminApps;
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

		it('strips query strings from path before auditing auth failure', () => {
			const req = {
				headers: { 'x-api-key': 'wrong-key' },
				query: { 'api-key': 'operator-password-123' },
				url: '/api/webhook/alert?api%2Dkey=operator-password-123&foo=bar',
				originalUrl: '/api/webhook/alert?api%2Dkey=operator-password-123&foo=bar',
				requestId: 'req-auth-leak',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateApiKey(req, res, next);

			expect(auditEvents).toHaveLength(1);
			expect(auditEvents[0].details.path).toBe('/api/webhook/alert');
			expect(JSON.stringify(auditEvents[0])).not.toContain('operator-password-123');
		});

		it('masks personal destination in /api/preferences/:channel/:chatId on auth failure', () => {
			const req = {
				headers: { 'x-api-key': 'wrong-key' },
				url: '/api/preferences/telegram/987654321',
				originalUrl: '/api/preferences/telegram/987654321',
				requestId: 'req-pref-mask',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateApiKey(req, res, next);

			expect(auditEvents).toHaveLength(1);
			expect(auditEvents[0].details.path).toBe('/api/preferences/telegram/:redacted');
			expect(JSON.stringify(auditEvents[0])).not.toContain('987654321');
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

		it('audits AUTH_FAILURE on invalid Firebase ID token', async () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			admin.apps = [{ name: '[DEFAULT]' }];
			const verifyIdToken = jest.fn().mockRejectedValue(new Error('Firebase ID token has expired'));
			admin.auth = jest.fn(() => ({ verifyIdToken }));

			const req = {
				headers: { authorization: 'Bearer expired-firebase-token' },
				query: {},
				url: '/api/admin/events',
				requestId: 'req-auth-fb-1',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			await validateAdminAccess(req, res, next);

			expect(res.status).toHaveBeenCalledWith(401);
			const authFailure = auditEvents.find((e) => e.action === 'verify_firebase_token');
			expect(authFailure).toMatchObject({
				stream: 'audit',
				category: AUDIT_CATEGORIES.AUTH_FAILURE,
				action: 'verify_firebase_token',
				result: 'failure',
				requestId: 'req-auth-fb-1',
				details: expect.objectContaining({
					reason: 'invalid_token',
				}),
			});
		});

		it('audits AUTH_FAILURE when Firebase user lacks admin role claims', async () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			admin.apps = [{ name: '[DEFAULT]' }];
			const verifyIdToken = jest.fn().mockResolvedValue({
				uid: 'user-without-role',
				email: 'viewer@cabros.io',
				roles: [],
			});
			admin.auth = jest.fn(() => ({ verifyIdToken }));

			const req = {
				headers: { authorization: 'Bearer valid-token-no-roles' },
				query: {},
				url: '/api/admin/events',
				requestId: 'req-auth-fb-2',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			await validateAdminAccess(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			const authFailure = auditEvents.find((e) => e.action === 'verify_admin_role');
			expect(authFailure).toMatchObject({
				stream: 'audit',
				category: AUDIT_CATEGORIES.AUTH_FAILURE,
				action: 'verify_admin_role',
				actor: 'viewer@cabros.io',
				result: 'failure',
				requestId: 'req-auth-fb-2',
				details: expect.objectContaining({
					reason: 'admin_role_required',
				}),
			});
		});
	});

	describe('validateBinanceTradingAccess', () => {
		it('audits AUTH_FAILURE when trading API key is missing', () => {
			process.env.BINANCE_TRADING_API_KEY = 'valid-trading-key';
			const req = {
				headers: {},
				query: {},
				url: '/api/trading/binance/orders',
				requestId: 'req-auth-trade-1',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateBinanceTradingAccess(req, res, next);

			expect(res.status).toHaveBeenCalledWith(401);
			expect(next).not.toHaveBeenCalled();
			const authFailure = auditEvents.find((e) => e.action === 'validate_binance_trading_api_key');
			expect(authFailure).toMatchObject({
				stream: 'audit',
				category: AUDIT_CATEGORIES.AUTH_FAILURE,
				action: 'validate_binance_trading_api_key',
				result: 'failure',
				requestId: 'req-auth-trade-1',
				details: expect.objectContaining({
					reason: 'missing_api_key',
				}),
			});
		});

		it('audits AUTH_FAILURE when trading API key is invalid', () => {
			process.env.BINANCE_TRADING_API_KEY = 'valid-trading-key';
			const req = {
				headers: { 'x-api-key': 'wrong-trading-key' },
				query: {},
				url: '/api/trading/binance/orders',
				requestId: 'req-auth-trade-2',
				ip: '127.0.0.1',
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn(),
			};
			const next = jest.fn();

			validateBinanceTradingAccess(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
			const authFailure = auditEvents.find((e) => e.action === 'validate_binance_trading_api_key');
			expect(authFailure).toMatchObject({
				stream: 'audit',
				category: AUDIT_CATEGORIES.AUTH_FAILURE,
				action: 'validate_binance_trading_api_key',
				result: 'failure',
				requestId: 'req-auth-trade-2',
				details: expect.objectContaining({
					reason: 'invalid_api_key',
				}),
			});
		});
	});
});
