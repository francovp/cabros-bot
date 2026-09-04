'use strict';

/**
 * Structured request-logging middleware.
 *
 * Emits one structured JSON line per completed HTTP request via the existing
 * `console.*` → `src/lib/logging.js` pipeline. Captures method, path,
 * status code, duration in milliseconds, and a per-request correlation id.
 *
 * Routes that are intentionally skipped (`/healthcheck`, `/openapi.json`)
 * are high-frequency, low-signal probes — they are excluded to keep
 * production logs focused on real traffic.
 */

const { randomUUID } = require('crypto');

const SKIPPED_PATHS = new Set(['/healthcheck', '/openapi.json', '/docs']);
const REQUEST_ID_PATTERN = /^[\x21-\x7E]+$/;
const REQUEST_ID_MAX_LENGTH = 128;
const IPV4_PATTERN = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/;

function normalizeRequestPath(rawPath) {
	if (typeof rawPath !== 'string' || rawPath.length === 0) {
		return '';
	}
	const queryIndex = rawPath.indexOf('?');
	const pathOnly = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
	return pathOnly.replace(/\/+$/, '') || '/';
}

function resolveRequestId(req) {
	const headers = req && req.headers ? req.headers : {};
	const raw = headers['x-request-id'] || headers['X-Request-Id'] || headers['X-Request-ID'];
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (
			trimmed.length > 0 &&
			trimmed.length <= REQUEST_ID_MAX_LENGTH &&
			REQUEST_ID_PATTERN.test(trimmed)
		) {
			return trimmed;
		}
	}
	return randomUUID();
}

function sanitizeClientIp(ip) {
	if (typeof ip !== 'string' || ip.length === 0) {
		return 'unknown';
	}
	const stripped = ip.replace(/^::ffff:/, '');
	const match = stripped.match(IPV4_PATTERN);
	if (match) {
		return `${match[1]}.x`;
	}
	if (stripped === '::1' || stripped === '127.0.0.1') {
		return 'loopback';
	}
	if (stripped.includes(':')) {
		return 'ipv6-redacted';
	}
	return 'unknown';
}

function resolveLogLevel(statusCode) {
	if (typeof statusCode !== 'number' || !Number.isFinite(statusCode)) {
		return 'info';
	}
	if (statusCode >= 500) {
		return 'error';
	}
	if (statusCode >= 400) {
		return 'warn';
	}
	return 'info';
}

function emit(method, level, attributes) {
	const message = attributes.aborted ? 'Request aborted' : 'Request completed';
	if (level === 'error') {
		console.error(message, { ...attributes, method, path: attributes.path });
	} else if (level === 'warn') {
		console.warn(message, { ...attributes, method, path: attributes.path });
	} else {
		console.info(message, { ...attributes, method, path: attributes.path });
	}
}

function createRequestLogger(options = {}) {
	const skippedPaths = options.skippedPaths || SKIPPED_PATHS;
	const now = options.now || (() => Date.now());

	return function requestLogger(req, res, next) {
		const startTime = now();
		const path = normalizeRequestPath(req.originalUrl || req.url || req.path || '');
		if (skippedPaths.has(path)) {
			return next();
		}

		const requestId = resolveRequestId(req);
		req.requestId = requestId;
		const clientIp = sanitizeClientIp(req.ip || (req.socket && req.socket.remoteAddress));
		let finalized = false;

		const finalize = (aborted = false) => {
			if (finalized) return;
			finalized = true;
			const durationMs = Math.max(0, now() - startTime);
			const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 0;
			const level = aborted ? 'warn' : resolveLogLevel(statusCode);
			emit(req.method, level, {
				method: req.method,
				path,
				statusCode,
				durationMs,
				requestId,
				clientIp,
				aborted,
				outcome: aborted ? 'aborted' : 'completed',
			});
		};

		res.on('finish', () => finalize(false));
		res.on('close', () => {
			const finished = Boolean(res.writableEnded || res.finished);
			finalize(!finished);
		});
		return next();
	};
}

function resetRequestLoggerForTests() {
	// No module-level mutable state currently; kept for parity with logging.js.
}

const middleware = createRequestLogger();

module.exports = middleware;
module.exports.createRequestLogger = createRequestLogger;
module.exports.normalizeRequestPath = normalizeRequestPath;
module.exports.resolveRequestId = resolveRequestId;
module.exports.sanitizeClientIp = sanitizeClientIp;
module.exports.resolveLogLevel = resolveLogLevel;
module.exports.SKIPPED_PATHS = SKIPPED_PATHS;
module.exports.resetRequestLoggerForTests = resetRequestLoggerForTests;
