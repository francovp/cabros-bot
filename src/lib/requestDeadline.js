// src/lib/requestDeadline.js
//
// Global request-deadline middleware: enforces a per-request server-side
// budget so any /api handler that exceeds `API_REQUEST_DEADLINE_MS` returns a
// structured 504 REQUEST_DEADLINE_EXCEEDED response before the reverse-proxy
// kills the connection. The middleware is mounted in `app.js` between the rate
// limiter and the route mount so it covers every mounted /api/* operation
// without interfering with /healthcheck, /ready, /openapi.json, or /docs.
//
// Fail-open semantics:
//   * When Sentry is disabled or `sentryService.captureRuntimeError` throws,
//     the middleware still emits a structured `console.warn` line and sends
//     the 504 response. Sentry failures never block the deadline.
//   * When the timer fires after `res.end`/`res.close`, the middleware no-ops
//     the response write to avoid double-send; it still logs the dead timer.
//   * When the handler already enforces a per-call timeout (per-endpoint
//     abort), this middleware is the absolute backstop - whichever fires first
//     wins. The per-endpoint error code is preserved via `res.locals.innerCode`
//     so an outer REQUEST_DEADLINE_EXCEEDED wraps an existing
//     EXPANDED_ANALYSIS_ALERT_TIMEOUT as `innerCode`.

'use strict';

const { randomUUID } = require('crypto');
const sentryService = require('../services/monitoring/SentryService');

const DEFAULT_DEADLINE_MS = 120000;
const HARD_CAP_MS = 600000;
const MIN_MS = 1000;

const invalidConfigWarnings = new Set();

// In-memory active-timer counter so /api/status can report the live load.
// Bounded to a single integer; no per-request data is retained.
let activeTimers = 0;

function readPositiveInteger(name, fallback) {
	const rawValue = process.env[name];
	if (rawValue === undefined || rawValue === '') return fallback;

	const trimmed = String(rawValue).trim();
	if (!/^-?\d+$/.test(trimmed)) {
		if (!invalidConfigWarnings.has(name)) {
			invalidConfigWarnings.add(name);
			console.warn(`[RequestDeadline] Invalid ${name}; using the safe default.`);
		}
		return fallback;
	}

	const value = Number(trimmed);
	if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
		if (!invalidConfigWarnings.has(name)) {
			invalidConfigWarnings.add(name);
			console.warn(`[RequestDeadline] Invalid ${name}; using the safe default.`);
		}
		return fallback;
	}

	return value;
}

function resolveDeadlineMs(env) {
	const raw = readPositiveInteger('API_REQUEST_DEADLINE_MS', DEFAULT_DEADLINE_MS);
	if (raw < MIN_MS) {
		console.warn(`[RequestDeadline] API_REQUEST_DEADLINE_MS=${raw} below minimum ${MIN_MS}; clamping.`);
		return MIN_MS;
	}
	if (raw > HARD_CAP_MS) {
		console.warn(`[RequestDeadline] API_REQUEST_DEADLINE_MS=${raw} above hard cap ${HARD_CAP_MS}; clamping.`);
		return HARD_CAP_MS;
	}
	return raw;
}

// Paths exempt from the global deadline. /healthcheck, /ready, /openapi.json
// and /docs are intentionally non-deadlined because they are probes, the
// public contract, or long-lived browsing surfaces.
const DEFAULT_EXEMPT_PATHS = new Set([
	'/healthcheck',
	'/ready',
	'/openapi.json',
	'/docs',
]);

function readExemptPaths() {
	const raw = process.env.API_REQUEST_DEADLINE_EXEMPT_PATHS;
	if (!raw || typeof raw !== 'string') return DEFAULT_EXEMPT_PATHS;
	const tokens = raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (tokens.length === 0) return DEFAULT_EXEMPT_PATHS;
	return new Set(tokens.map((entry) => entry.toLowerCase()));
}

function isExempt(req, exemptPaths) {
	const requestPath = String(req.originalUrl || req.url || req.path || '')
		.split('?')[0]
		.replace(/\/+$/, '')
		.toLowerCase();
	if (exemptPaths.has(requestPath)) return true;
	for (const exempt of exemptPaths) {
		if (requestPath === exempt || requestPath.startsWith(`${exempt}/`)) {
			return true;
		}
	}
	return false;
}

function readPerRequestDeadlineHeader(req) {
	const headerValue = req.headers && req.headers['x-cabros-request-deadline-ms'];
	if (headerValue === undefined || headerValue === null || headerValue === '') {
		return null;
	}
	const trimmed = String(headerValue).trim();
	if (!/^-?\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) return null;
	return parsed;
}

function clamp(value, minimum, maximum) {
	return Math.max(minimum, Math.min(maximum, value));
}

function mintRequestId(req) {
	if (req.headers && typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim().length > 0) {
		return req.headers['x-request-id'].trim();
	}
	return randomUUID();
}

function requestDeadline(options = {}) {
	const enabled = options.enabled !== false;
	const env = options.env || process.env;
	const deadlineMs = resolveDeadlineMs(env);
	const exemptPaths = readExemptPaths();

	return function requestDeadlineMiddleware(req, res, next) {
		if (!enabled) {
			req.apiRequestDeadline = null;
			return next();
		}

		if (isExempt(req, exemptPaths)) {
			req.apiRequestDeadline = null;
			return next();
		}

		const requestId = mintRequestId(req);
		req.apiRequestDeadline = {
			requestId,
			deadlineMs,
			exceeded: false,
			signal: null,
		};
		res.setHeader('X-Request-Id', requestId);

		const headerDeadline = readPerRequestDeadlineHeader(req);
		const effectiveDeadlineMs = headerDeadline !== null
			? clamp(headerDeadline, MIN_MS, HARD_CAP_MS)
			: deadlineMs;
		req.apiRequestDeadline.deadlineMs = effectiveDeadlineMs;
		req.apiRequestDeadline.headerDeadlineMs = headerDeadline;

		activeTimers += 1;
		const controller = new AbortController();
		req.apiRequestDeadline.signal = controller.signal;

		const startedAt = Date.now();
		const timer = setTimeout(() => {
			if (res.writableEnded || res.headersSent) {
				return;
			}
			const durationMs = Date.now() - startedAt;
			req.apiRequestDeadline.exceeded = true;

			const innerCode = res.locals && typeof res.locals.innerCode === 'string'
				? res.locals.innerCode
				: null;
			const payload = {
				error: 'Request deadline exceeded',
				code: 'REQUEST_DEADLINE_EXCEEDED',
				requestId,
				deadlineMs: effectiveDeadlineMs,
				durationMs,
			};
			if (innerCode) payload.innerCode = innerCode;

			try {
				res.status(504).json(payload);
			} catch (writeError) {
				console.warn('[RequestDeadline] Failed to send 504 response:', writeError.message);
			}

			try {
				if (typeof sentryService.captureRuntimeError === 'function') {
					sentryService.captureRuntimeError({
						channel: 'api',
						error: new Error(`Request deadline exceeded after ${durationMs}ms`),
						feature: 'api-request-deadline',
						http: {
							method: req.method,
							path: req.path || req.url,
							durationMs,
						},
						extra: {
							requestId,
							deadlineMs: effectiveDeadlineMs,
							innerCode: innerCode || undefined,
							tags: {
								endpoint: req.path || req.url,
								method: req.method,
							},
						},
					});
				}
			} catch (sentryError) {
				console.warn('[RequestDeadline] Sentry capture failed:', sentryError.message);
			}
		}, effectiveDeadlineMs);

		const finalize = () => {
			clearTimeout(timer);
			activeTimers = Math.max(0, activeTimers - 1);
			res.off('finish', finalize);
			res.off('close', finalize);
		};
		res.once('finish', finalize);
		res.once('close', finalize);

		next();
	};
}

requestDeadline.getStatus = function getStatus() {
	const deadlineMs = resolveDeadlineMs(process.env);
	const exemptPaths = readExemptPaths();
	return {
		enabled: true,
		defaultMs: deadlineMs,
		hardCapMs: HARD_CAP_MS,
		minMs: MIN_MS,
		activeTimers,
		exemptPaths: Array.from(exemptPaths),
	};
};

requestDeadline.resetActiveTimers = function resetActiveTimers() {
	activeTimers = 0;
};

requestDeadline.clearInvalidConfigCache = function clearInvalidConfigCache() {
	invalidConfigWarnings.clear();
};

module.exports = requestDeadline;
module.exports.DEFAULT_DEADLINE_MS = DEFAULT_DEADLINE_MS;
module.exports.HARD_CAP_MS = HARD_CAP_MS;
module.exports.MIN_MS = MIN_MS;
