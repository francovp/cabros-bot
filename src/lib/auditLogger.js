'use strict';

/**
 * Structured Audit Logging for Security-Sensitive Operations (GH-740).
 *
 * Provides a structured audit trail for:
 * - Admin authentication failures (API key & Firebase token)
 * - Binance order submissions, completions, and rejections
 * - Admin actions (e.g. alert replay)
 * - Runtime configuration changes (e.g. pause/resume)
 *
 * Invariants:
 * - Fail-safe: Audit logging never throws or interrupts authorization, trading, or alert delivery.
 * - Non-secret: Passwords, tokens, API keys, and authorization headers in details are redacted.
 * - Test isolation: Audit events are suppressed during NODE_ENV=test unless explicitly enabled.
 * - Opt-in/deshabilitable: ENABLE_AUDIT_LOGGING defaults to true; set to 'false' to disable.
 */

const AUDIT_CATEGORIES = Object.freeze({
	AUTH_FAILURE: 'AUTH_FAILURE',
	ORDER_SUBMITTED: 'ORDER_SUBMITTED',
	ORDER_COMPLETED: 'ORDER_COMPLETED',
	ORDER_REJECTED: 'ORDER_REJECTED',
	ORDER_AMBIGUOUS: 'ORDER_AMBIGUOUS',
	ADMIN_ACTION: 'ADMIN_ACTION',
	CONFIG_CHANGE: 'CONFIG_CHANGE',
});

const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie|dsn|webhookUrl|private[-_]?key)/i;

let testOverrideEnabled = false;
let testListener = null;

function stripQueryFromPath(rawPath) {
	if (typeof rawPath !== 'string' || rawPath.length === 0) return '';
	const qIdx = rawPath.indexOf('?');
	const pathOnly = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
	return pathOnly.replace(/\/+$/, '') || '/';
}

function isAuditLoggingEnabled() {
	if (process.env.ENABLE_AUDIT_LOGGING === 'false') {
		return false;
	}
	return true;
}

function shouldEmitAuditLogs() {
	if (!isAuditLoggingEnabled()) {
		return false;
	}
	if (process.env.NODE_ENV === 'test' && !testOverrideEnabled) {
		return false;
	}
	return true;
}

function getAuditLogLevel() {
	const level = String(process.env.AUDIT_LOG_LEVEL || 'info').trim().toLowerCase();
	return ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
}

function sanitizeDetails(value, seen = new WeakSet()) {
	if (value === null || value === undefined) {
		return {};
	}
	if (typeof value !== 'object') {
		return { value: String(value) };
	}
	if (seen.has(value)) {
		return '[CIRCULAR]';
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => (typeof item === 'object' && item !== null ? sanitizeDetails(item, seen) : item));
	}

	const sanitized = {};
	for (const [key, val] of Object.entries(value)) {
		if (SENSITIVE_KEY_PATTERN.test(key)) {
			sanitized[key] = '[REDACTED]';
			continue;
		}
		if (val && typeof val === 'object') {
			sanitized[key] = sanitizeDetails(val, seen);
		} else if ((key === 'path' || key === 'url') && typeof val === 'string') {
			sanitized[key] = stripQueryFromPath(val);
		} else {
			sanitized[key] = val;
		}
	}
	return sanitized;
}

function resolveActor(actor, req) {
	if (typeof actor === 'string' && actor.trim()) {
		return actor.trim();
	}
	if (req && typeof req === 'object') {
		if (req.adminUser && typeof req.adminUser === 'object') {
			if (typeof req.adminUser.email === 'string' && req.adminUser.email.trim()) {
				return req.adminUser.email.trim();
			}
			if (typeof req.adminUser.uid === 'string' && req.adminUser.uid.trim()) {
				return req.adminUser.uid.trim();
			}
		}
		const hasApiKey = Boolean(req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key']));
		if (hasApiKey) {
			return 'api_key_shared';
		}
	}
	return 'anonymous';
}

function resolveRequestId(req) {
	if (!req || typeof req !== 'object') return null;
	const candidate = req.requestId || req.id || (req.headers && req.headers['x-request-id']);
	return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function resolveIp(req) {
	if (!req || typeof req !== 'object') return null;
	const candidate = req.ip || (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress);
	return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * Logs a security audit event.
 *
 * Supports positional: auditLog(category, actor, action, details, result, req)
 * Supports object: auditLog({ category, actor, action, details, result, req })
 *
 * @returns {object|null} The constructed audit event, or null if disabled.
 */
function auditLog(categoryOrOptions, actor, action, details, result, req) {
	try {
		if (!isAuditLoggingEnabled()) {
			return null;
		}

		let eventCategory;
		let eventActor;
		let eventAction;
		let eventDetails;
		let eventResult;
		let eventReq;

		if (
			categoryOrOptions
			&& typeof categoryOrOptions === 'object'
			&& !Array.isArray(categoryOrOptions)
			&& actor === undefined
		) {
			eventCategory = categoryOrOptions.category;
			eventActor = categoryOrOptions.actor;
			eventAction = categoryOrOptions.action;
			eventDetails = categoryOrOptions.details;
			eventResult = categoryOrOptions.result;
			eventReq = categoryOrOptions.req;
		} else {
			eventCategory = categoryOrOptions;
			eventActor = actor;
			eventAction = action;
			eventDetails = details;
			eventResult = result;
			eventReq = req;
		}

		const resolvedCategory = typeof eventCategory === 'string' ? eventCategory : 'UNKNOWN';
		const resolvedAction = typeof eventAction === 'string' ? eventAction : 'unknown';
		const resolvedResult = typeof eventResult === 'string' ? eventResult : 'unknown';
		const sanitizedDetailsObj = sanitizeDetails(eventDetails);
		const resolvedActorVal = resolveActor(eventActor, eventReq);
		const requestId = resolveRequestId(eventReq);
		const ip = resolveIp(eventReq);

		const auditEvent = {
			timestamp: new Date().toISOString(),
			stream: 'audit',
			category: resolvedCategory,
			actor: resolvedActorVal,
			action: resolvedAction,
			details: sanitizedDetailsObj,
			result: resolvedResult,
			requestId,
			ip,
		};

		if (testListener && typeof testListener === 'function') {
			try {
				testListener(auditEvent);
			} catch (_) {
				// test listener fail-safe
			}
		}

		if (shouldEmitAuditLogs()) {
			const level = getAuditLogLevel();
			const consoleFn = typeof console[level] === 'function' ? console[level].bind(console) : console.info.bind(console);
			consoleFn('[audit]', auditEvent);
		}

		return auditEvent;
	} catch (error) {
		// Fail-safe: never crash caller
		return null;
	}
}

function _setAuditLoggingEnabledForTest(enabled) {
	testOverrideEnabled = Boolean(enabled);
}

function _setAuditLogListenerForTest(listener) {
	testListener = listener;
}

function _resetAuditLoggerForTest() {
	testOverrideEnabled = false;
	testListener = null;
}

module.exports = {
	auditLog,
	AUDIT_CATEGORIES,
	isAuditLoggingEnabled,
	stripQueryFromPath,
	_setAuditLoggingEnabledForTest,
	_setAuditLogListenerForTest,
	_resetAuditLoggerForTest,
};
