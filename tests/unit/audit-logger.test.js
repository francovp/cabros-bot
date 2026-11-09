'use strict';

const {
	auditLog,
	AUDIT_CATEGORIES,
	isAuditLoggingEnabled,
	_setAuditLoggingEnabledForTest,
	_setAuditLogListenerForTest,
	_resetAuditLoggerForTest,
} = require('../../src/lib/auditLogger');

describe('auditLogger (GH-740)', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		_resetAuditLoggerForTest();
	});

	afterEach(() => {
		process.env = originalEnv;
		_resetAuditLoggerForTest();
	});

	describe('AUDIT_CATEGORIES', () => {
		it('exports the required audit categories as frozen object', () => {
			expect(Object.isFrozen(AUDIT_CATEGORIES)).toBe(true);
			expect(AUDIT_CATEGORIES).toEqual({
				AUTH_FAILURE: 'AUTH_FAILURE',
				ORDER_SUBMITTED: 'ORDER_SUBMITTED',
				ORDER_COMPLETED: 'ORDER_COMPLETED',
				ORDER_REJECTED: 'ORDER_REJECTED',
				ORDER_AMBIGUOUS: 'ORDER_AMBIGUOUS',
				ADMIN_ACTION: 'ADMIN_ACTION',
				CONFIG_CHANGE: 'CONFIG_CHANGE',
			});
		});
	});

	describe('event structure & positional arguments', () => {
		it('builds a conforming audit event with all required fields', () => {
			const req = {
				requestId: 'req-test-123',
				ip: '192.168.1.50',
			};
			const event = auditLog(
				AUDIT_CATEGORIES.ORDER_SUBMITTED,
				'admin@cabros-bot',
				'binance_order',
				{ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', dryRun: false },
				'success',
				req,
			);

			expect(event).toMatchObject({
				stream: 'audit',
				category: 'ORDER_SUBMITTED',
				actor: 'admin@cabros-bot',
				action: 'binance_order',
				details: { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', dryRun: false },
				result: 'success',
				requestId: 'req-test-123',
				ip: '192.168.1.50',
			});
			expect(typeof event.timestamp).toBe('string');
			expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
		});

		it('supports single options object signature', () => {
			const event = auditLog({
				category: AUDIT_CATEGORIES.ADMIN_ACTION,
				actor: 'operator@cabros-bot',
				action: 'alert_replay',
				details: { alertId: 'alert-abc' },
				result: 'success',
				req: {
					headers: { 'x-request-id': 'req-xyz-987' },
					ip: '10.0.0.1',
				},
			});

			expect(event).toMatchObject({
				stream: 'audit',
				category: 'ADMIN_ACTION',
				actor: 'operator@cabros-bot',
				action: 'alert_replay',
				details: { alertId: 'alert-abc' },
				result: 'success',
				requestId: 'req-xyz-987',
				ip: '10.0.0.1',
			});
		});
	});

	describe('actor resolution', () => {
		it('prefers explicit actor over request context', () => {
			const req = {
				adminUser: { email: 'user@domain.com' },
				headers: { 'x-api-key': 'secret-key' },
			};
			const event = auditLog(AUDIT_CATEGORIES.ADMIN_ACTION, 'custom-actor', 'action', {}, 'success', req);
			expect(event.actor).toBe('custom-actor');
		});

		it('resolves actor from req.adminUser.email', () => {
			const req = { adminUser: { email: 'admin@cabros.io' } };
			const event = auditLog(AUDIT_CATEGORIES.ADMIN_ACTION, null, 'action', {}, 'success', req);
			expect(event.actor).toBe('admin@cabros.io');
		});

		it('resolves actor from req.adminUser.uid when email is absent', () => {
			const req = { adminUser: { uid: 'firebase-user-123' } };
			const event = auditLog(AUDIT_CATEGORIES.ADMIN_ACTION, null, 'action', {}, 'success', req);
			expect(event.actor).toBe('firebase-user-123');
		});

		it('resolves actor as api_key_shared when API key is present without adminUser', () => {
			const req = { headers: { 'x-api-key': 'test-key' } };
			const event = auditLog(AUDIT_CATEGORIES.AUTH_FAILURE, null, 'action', {}, 'failure', req);
			expect(event.actor).toBe('api_key_shared');
		});

		it('falls back to anonymous when unauthenticated and no actor provided', () => {
			const req = { headers: {} };
			const event = auditLog(AUDIT_CATEGORIES.AUTH_FAILURE, null, 'action', {}, 'failure', req);
			expect(event.actor).toBe('anonymous');
		});
	});

	describe('details sanitization', () => {
		it('redacts sensitive keys from details object', () => {
			const details = {
				symbol: 'BTCUSDT',
				apiKey: 'super-secret-key',
				authorization: 'Bearer token-value',
				nested: {
					password: 'secret-password',
					normalField: 'ok-value',
				},
				tokens: ['safe', 'another'],
			};
			const event = auditLog(AUDIT_CATEGORIES.AUTH_FAILURE, 'actor', 'action', details, 'failure');
			expect(event.details.symbol).toBe('BTCUSDT');
			expect(event.details.apiKey).toBe('[REDACTED]');
			expect(event.details.authorization).toBe('[REDACTED]');
			expect(event.details.nested.password).toBe('[REDACTED]');
			expect(event.details.nested.normalField).toBe('ok-value');
			// original details was not mutated
			expect(details.apiKey).toBe('super-secret-key');
		});

		it('strips query strings from path and url fields in details', () => {
			const details = {
				path: '/api/webhook/alert?api%2Dkey=operator-secret&test=1',
				url: '/api/admin/events?token=abc',
				normal: 'keep?this',
			};
			const event = auditLog(AUDIT_CATEGORIES.AUTH_FAILURE, 'actor', 'action', details, 'failure');
			expect(event.details.path).toBe('/api/webhook/alert');
			expect(event.details.url).toBe('/api/admin/events');
			expect(event.details.normal).toBe('keep?this');
		});

		it('masks personal destination segments in path and url fields', () => {
			const details = {
				path: '/api/preferences/telegram/123456789?api-key=test',
				url: '/api/preferences/whatsapp/120363422033474991@g.us',
			};
			const event = auditLog(AUDIT_CATEGORIES.AUTH_FAILURE, 'actor', 'action', details, 'failure');
			expect(event.details.path).toBe('/api/preferences/telegram/:redacted');
			expect(event.details.url).toBe('/api/preferences/whatsapp/:redacted');
		});
	});

	describe('feature gating & environment controls', () => {
		it('is enabled by default when ENABLE_AUDIT_LOGGING is unset', () => {
			delete process.env.ENABLE_AUDIT_LOGGING;
			expect(isAuditLoggingEnabled()).toBe(true);
		});

		it('can be disabled via ENABLE_AUDIT_LOGGING=false', () => {
			process.env.ENABLE_AUDIT_LOGGING = 'false';
			expect(isAuditLoggingEnabled()).toBe(false);
			const event = auditLog(AUDIT_CATEGORIES.ORDER_SUBMITTED, 'actor', 'action', {}, 'success');
			expect(event).toBeNull();
		});

		it('does not emit to console during NODE_ENV=test unless test override enabled', () => {
			process.env.NODE_ENV = 'test';
			const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
			auditLog(AUDIT_CATEGORIES.ORDER_SUBMITTED, 'actor', 'action', {}, 'success');
			expect(consoleSpy).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('does not emit to console during NODE_ENV=test even if listener is registered', () => {
			process.env.NODE_ENV = 'test';
			const listener = jest.fn();
			_setAuditLogListenerForTest(listener);
			const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
			auditLog(AUDIT_CATEGORIES.ORDER_SUBMITTED, 'actor', 'action', {}, 'success');
			expect(listener).toHaveBeenCalled();
			expect(consoleSpy).not.toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('emits to listener when test override is enabled', () => {
			const listener = jest.fn();
			_setAuditLogListenerForTest(listener);
			const event = auditLog(AUDIT_CATEGORIES.CONFIG_CHANGE, 'admin', 'pause_trading', { reason: 'maintenance' }, 'success');
			expect(listener).toHaveBeenCalledWith(event);
		});

		it('emits to console when test override is enabled', () => {
			_setAuditLoggingEnabledForTest(true);
			const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
			auditLog(AUDIT_CATEGORIES.ORDER_COMPLETED, 'actor', 'action', {}, 'success');
			expect(consoleSpy).toHaveBeenCalledWith('[audit]', expect.objectContaining({
				category: 'ORDER_COMPLETED',
			}));
			consoleSpy.mockRestore();
		});
	});

	describe('fail-safe resilience', () => {
		it('never throws even with invalid arguments or circular references', () => {
			const circular = {};
			circular.self = circular;

			expect(() => {
				const event = auditLog(null, null, null, circular, null, null);
				expect(event).toBeDefined();
			}).not.toThrow();
		});
	});
});
