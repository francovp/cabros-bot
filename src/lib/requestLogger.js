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
 * `GET /api/admin/events` streams events for the admin console. The response is
 * held open for the life of the subscription, so it never reaches
 * `writableFinished` and its `close` is a normal end of stream.
 */
const SSE_PATHS = ['/api/admin/events'];
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

function isSsePath(path) {
	const lower = path.toLowerCase();
	return SSE_PATHS.some((candidate) => lower === candidate || lower.startsWith(`${candidate}/`));
}

/**
 * Whether a server-sent-events response actually began.
 *
 * This asks the *response* what it became rather than asking the path what it
 * looks like. Keying on the path alone conflated a stream the admin console
 * closed on purpose with a client that vanished before the stream ever opened —
 * the second is a real failure, and recording it as a completion buried it.
 *
 * The content type must be captured at handshake time, not read later from
 * `res.getHeader()`: `writeHead()` serializes headers into its own buffer and
 * leaves the live header store empty, so a read in the `close` handler returns
 * `undefined` unless some *earlier* `setHeader` happened to run first. That made
 * the answer depend on an unrelated middleware — exempting the route via
 * `REQUEST_DEADLINE_EXEMPT_PATHS`, or disabling `x-powered-by`, was enough to
 * turn every routine console teardown into a warn-level abort.
 */
function trackEventStream(res) {
	const state = { established: false };
	const originalWriteHead = res.writeHead;
	if (typeof originalWriteHead !== 'function') return state;

	res.writeHead = function(...args) {
		// The header map is the 2nd argument when `writeHead(status, headers)` is
		// used; it can also arrive via setHeader beforehand, so both are consulted
		// at the moment the status line is actually committed.
		const declared = args[1];
		const contentType = (declared && typeof declared === 'object' && declared['Content-Type'])
			|| res.getHeader('Content-Type');
		if (typeof contentType === 'string'
			&& contentType.toLowerCase().split(';')[0].trim() === EVENT_STREAM_CONTENT_TYPE) {
			state.established = true;
		}
		return originalWriteHead.apply(this, args);
	};
	return state;
}

/**
 * Reusing the deadline's matcher keeps a single validation rule for the
 * correlation id across the request lifecycle, so the structured log line and
 * any 408 payload always agree. It already prefers `req.requestId` over the
 * inbound header, which is what makes the ids match.
 */
function resolveRequestId(req) {
	return requestDeadline.resolveRequestId(req);
}

/**
 * The deadline's exemption predicate is the single vocabulary for "probe
 * route" — the same `normalizeExemptPath` rule (lower-case, no trailing slash)
 * and the same `/docs` subtree treatment. It is read per request rather than
 * captured once at module load, so an operator who adds a path to
 * `REQUEST_DEADLINE_EXEMPT_PATHS` exempts it from the deadline and from request
 * logging at the same time, and the two middlewares cannot drift.
 */
function isExemptPath(path) {
	return requestDeadline.isExemptPath(path, requestDeadline.resolveExemptPaths());
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

		// Stamp the correlation id BEFORE the exemption check. An operator can
		// exempt an API route through REQUEST_DEADLINE_EXEMPT_PATHS, and
		// `requestDeadline` skips that route too — so it never sets
		// `X-Request-Id`. Handlers still return a `requestId` in their body, and
		// the OpenAPI contract promises the header, so resolving the id here keeps
		// `req.requestId`, the response header, and the body in agreement even when
		// the request itself is never logged. On a non-exempt path the deadline
		// resolves the same id from `req.requestId`, so this only fills a gap.
		const requestId = resolveRequestId(req);
		req.requestId = requestId;

		// Exemption is decided on the unmasked path. Masking first would rewrite
		// `/api/preferences/telegram/123` to `:redacted` and an operator who
		// configured that exact path as exempt would still see it logged.
		if (isExemptPath(rawPath)) {
			return next();
		}
		const path = maskSensitivePathSegments(rawPath);

		const clientIp = sanitizeClientIp(req.ip || (req.socket && req.socket.remoteAddress));
		// A server-sent-events response is deliberately held open and never
		// reaches `writableFinished`, so `close` is its normal termination. The
		// admin console aborts the controller on teardown and on stream
		// replacement, so without this every routine disconnect would land in the
		// aborted bucket and drown the signal that a real client failure produces.
		// The path only selects the candidate — `eventStream.established` still has
		// to confirm the stream really started.
		const isEventStream = isSsePath(rawPath);
		const eventStream = isEventStream ? trackEventStream(res) : { established: false };
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
			// An event stream that the client closes is the expected end of that
			// response, not a failed request: report it as a completion at the
			// stream's own duration instead of inflating the abort counter. This
			// applies only once the stream was genuinely established.
			const treatAsAborted = aborted && !eventStream.established;
			const level = treatAsAborted ? 'warn' : resolveLogLevel(statusCode);
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
					aborted: treatAsAborted,
					outcome: treatAsAborted ? 'aborted' : 'completed',
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
module.exports.isSsePath = isSsePath;
