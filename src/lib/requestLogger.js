'use strict';

/**
 * Structured request-logging middleware.
 *
 * Emits one structured JSON line per completed HTTP request via the existing
 * `console.*` → `src/lib/logging.js` pipeline. Captures method, path,
 * status code, duration in milliseconds, and a per-request correlation id.
 *
 * High-frequency, low-signal probes are excluded so production logs stay
 * focused on real traffic. The skip set is the request deadline's own
 * exemption list (`REQUEST_DEADLINE_EXEMPT_PATHS` plus its defaults), read per
 * request, so a route an operator declares exempt from the deadline is also
 * exempt from request logging — the two middlewares cannot drift apart.
 */

const requestDeadline = require('./requestDeadline');

const IPV4_PATTERN = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/;

function normalizeRequestPath(rawPath) {
	if (typeof rawPath !== 'string' || rawPath.length === 0) {
		return '';
	}
	const queryIndex = rawPath.indexOf('?');
	const pathOnly = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
	// Lower-cased to match `requestDeadline.normalizePath`. Express routing is
	// case-insensitive by default, so without this `/HEALTHCHECK` would be
	// deadline-exempt yet still logged — letting a probe flood the log with one
	// character of variation per request.
	return pathOnly.replace(/\/+$/, '').toLowerCase() || '/';
}

/**
 * Reusing the deadline's resolver keeps a single validation rule for the
 * correlation id across the request lifecycle, so the structured log line and
 * any 408 payload always agree. It already prefers `req.requestId` over the
 * inbound header, which is what makes the ids match.
 */
function resolveRequestId(req) {
	return requestDeadline.resolveRequestId(req);
}

/**
 * The deadline's exemption list is the single vocabulary for "probe route".
 * It is read per request rather than captured once at module load, so an
 * operator who adds a path to `REQUEST_DEADLINE_EXEMPT_PATHS` exempts it from
 * request logging at the same time, with no reload.
 */
function isExemptPath(path) {
	return requestDeadline.resolveExemptPaths().has(path);
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

function emit(level, attributes) {
	const message = attributes.aborted ? 'Request aborted' : 'Request completed';
	if (level === 'error') {
		console.error(message, attributes);
	} else if (level === 'warn') {
		console.warn(message, attributes);
	} else {
		console.info(message, attributes);
	}
}

function createRequestLogger() {
	return function requestLogger(req, res, next) {
		const startTime = Date.now();
		const path = normalizeRequestPath(req.originalUrl || req.url || req.path || '');
		if (isExemptPath(path)) {
			return next();
		}

		const requestId = resolveRequestId(req);
		req.requestId = requestId;
		const clientIp = sanitizeClientIp(req.ip || (req.socket && req.socket.remoteAddress));
		let finalized = false;

		const finalize = (aborted = false) => {
			if (finalized) return;
			finalized = true;
			const durationMs = Math.max(0, Date.now() - startTime);
			const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 0;
			const level = aborted ? 'warn' : resolveLogLevel(statusCode);
			// Fail open: `console.*` is globally replaceable (the logging wrapper,
			// Sentry, or a test double), and this runs from a Node event emitter
			// outside Express's try/catch. A throwing sink must never take down
			// the process on an observability path.
			try {
				emit(level, {
					method: req.method,
					path,
					statusCode,
					durationMs,
					requestId,
					clientIp,
					aborted,
					outcome: aborted ? 'aborted' : 'completed',
				});
			} catch (_) {
				// Observability is never allowed to break a response.
			}
		};

		res.on('finish', () => finalize(false));
		res.on('close', () => {
			// `writableEnded` flips the moment the handler calls res.end(), which
			// is before the bytes reach the socket. A client that disconnects in
			// that window leaves `writableEnded === true` but `writableFinished ===
			// false`, so reading `writableEnded` here would report a truncated
			// download as a clean completion with an understated duration.
			// `finish` always wins the race for a clean response, so `close`
			// observing `writableFinished === true` implies `finish` never fired.
			finalize(!res.writableFinished);
		});
		return next();
	};
}

const middleware = createRequestLogger();

module.exports = middleware;
module.exports.createRequestLogger = createRequestLogger;
module.exports.normalizeRequestPath = normalizeRequestPath;
module.exports.resolveRequestId = resolveRequestId;
module.exports.sanitizeClientIp = sanitizeClientIp;
module.exports.resolveLogLevel = resolveLogLevel;
