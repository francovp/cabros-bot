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

// `/api/preferences/:channel/:chatId` carries a Telegram or WhatsApp chat
// identifier — a personal destination, and the one parameterized route segment
// that is not an opaque document or job id. The centralized logger does not
// redact it, because the attribute is named `path` and ordinary numeric or
// `@g.us` values do not match its secret patterns. Mask it so personally
// identifying destinations never reach stdout or Sentry. The other `:id`
// segments are UUIDs (alertId, jobId) or operator-chosen preset names, which
// stay intact so a path remains searchable.
const SENSITIVE_PATH_SEGMENTS = [
	{ pattern: /(\/api\/preferences\/[^/]+\/)[^/]+(?=\/|$)/i, replacement: '$1:redacted' },
];

function normalizeRequestPath(rawPath) {
	if (typeof rawPath !== 'string' || rawPath.length === 0) {
		return '';
	}
	const queryIndex = rawPath.indexOf('?');
	const pathOnly = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
	// Case is preserved for the emitted line: Firestore document ids are mixed
	// case and case-sensitive, so lower-casing here would make `/api/alerts/:id`
	// unsearchable — an operator could not match the logged path against the id
	// they saw in a 404 body. Exemption matching lower-cases separately.
	return pathOnly.replace(/\/+$/, '') || '/';
}

/**
 * Applied only to the value that reaches the log, never before exemption
 * matching, so a configured exempt path is still recognizable as exempt.
 */
function maskSensitivePathSegments(path) {
	let masked = path;
	for (const { pattern, replacement } of SENSITIVE_PATH_SEGMENTS) {
		masked = masked.replace(pattern, replacement);
	}
	return masked;
}

/**
 * Express routing is case-insensitive by default, so `/HEALTHCHECK` reaches the
 * healthcheck handler. Match the exemption set case-insensitively (mirroring
 * `requestDeadline.normalizePath`) or a probe could flood the logs by varying
 * one character per request.
 */
/**
 * `/docs` serves a Swagger UI page that then pulls `swagger-ui.css`,
 * `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`, and
 * `swagger-initializer.js` from the same router. Exact set membership exempts
 * none of those, so every documentation visit produced several low-signal
 * records despite `/docs` being documented as a probe route. Treat these static
 * asset roots as subtrees.
 */
const EXEMPT_SUBTREES = ['/docs'];

function matchesExemptPath(path, exemptPaths) {
	const lower = path.toLowerCase();
	if (exemptPaths.has(lower)) return true;
	for (const prefix of EXEMPT_SUBTREES) {
		if (lower === prefix || lower.startsWith(`${prefix}/`)) return true;
	}
	return false;
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
	return matchesExemptPath(path, requestDeadline.resolveExemptPaths());
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
	// Only reachable for IPv6: the IPv4 pattern above already consumed
	// `127.0.0.1` (as `127.0.0.x`), so naming it here would be dead code.
	if (stripped === '::1') {
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
		const rawPath = normalizeRequestPath(req.originalUrl || req.url || req.path || '');
		// Exemption is decided on the unmasked path. Masking first would rewrite
		// `/api/preferences/telegram/123` to `:redacted` and an operator who
		// configured that exact path as exempt would still see it logged.
		if (isExemptPath(rawPath)) {
			return next();
		}
		const path = maskSensitivePathSegments(rawPath);

		const requestId = resolveRequestId(req);
		req.requestId = requestId;
		const clientIp = sanitizeClientIp(req.ip || (req.socket && req.socket.remoteAddress));
		let finalized = false;

		const finalize = (aborted = false) => {
			if (finalized) return;
			finalized = true;
			const durationMs = Math.max(0, Date.now() - startTime);
			// Node initializes `res.statusCode` to 200 even when nothing was ever
			// written, so an early client disconnect would otherwise be logged as a
			// phantom success. Report 0 when no response actually began, so a
			// dashboard grouping by status does not invent 200s.
			const statusCode = res.headersSent && typeof res.statusCode === 'number'
				? res.statusCode
				: 0;
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
