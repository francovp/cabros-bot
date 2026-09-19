// src/lib/requestDeadline.js
// Global request-deadline middleware. Enforces a hard ceiling on the
// duration of any handler that opts in, so slow external providers
// (Gemini, TradingView MCP, Twelve Data, etc.) cannot hold the connection
// open past the reverse-proxy timeout.
//
// Behavior:
//   - Wraps response lifecycle in a setTimeout that fires after
//     REQUEST_TIMEOUT_MS (default 30000, integer 1000-120000).
//   - When the deadline is exceeded the middleware writes
//     `408 REQUEST_TIMEOUT` with a structured payload and a per-request
//     `requestId` (re-uses `req.requestId` if the request-id middleware
//     has already stamped it; otherwise generates one).
//   - If the response has already been sent before the deadline, the
//     timeout is a no-op (no double-send).
//   - Exempts `/healthcheck`, `/ready`, `/openapi.json`, `/docs`, and any
//     path in REQUEST_DEADLINE_EXEMPT_PATHS (comma-separated).
//   - Honors `REQUEST_TIMEOUT_MS` malformed/non-finite/out-of-range values
//     by falling back to the documented default and logging a single
//     structured warning.

const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
const invalidConfigWarnings = new Set();

const DEFAULT_EXEMPT_PATHS = new Set([
	'/healthcheck',
	'/ready',
	'/openapi.json',
	'/docs',
]);

function readPositiveInteger(name, fallback) {
	const rawValue = process.env[name];
	if (rawValue === undefined) return fallback;

	const trimmed = String(rawValue).trim();
	if (!/^\d+$/.test(trimmed)) {
		if (!invalidConfigWarnings.has(name)) {
			invalidConfigWarnings.add(name);
			console.warn(
				`[RequestDeadline] Invalid ${name}; using the safe default of ${fallback}ms.`,
			);
		}
		return fallback;
	}

	const value = Number(trimmed);
	if (
		!Number.isFinite(value) ||
		!Number.isSafeInteger(value) ||
		value < MIN_TIMEOUT_MS ||
		value > MAX_TIMEOUT_MS
	) {
		if (!invalidConfigWarnings.has(name)) {
			invalidConfigWarnings.add(name);
			console.warn(
				`[RequestDeadline] ${name}=${trimmed} outside ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}; using default ${fallback}ms.`,
			);
		}
		return fallback;
	}

	return value;
}

function parseExemptPaths() {
	const raw = process.env.REQUEST_DEADLINE_EXEMPT_PATHS;
	if (!raw) return DEFAULT_EXEMPT_PATHS;

	const paths = new Set(DEFAULT_EXEMPT_PATHS);
	for (const part of String(raw).split(',')) {
		const trimmed = part.trim();
		if (trimmed) paths.add(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
	}
	return paths;
}

const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');

let testOverrides = null;

function resolveTimeoutMs() {
	if (testOverrides && typeof testOverrides.timeoutMs === 'number') {
		return testOverrides.timeoutMs;
	}
	const envTimeout = readPositiveInteger('REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
	try {
		const status = remoteConfigService.getStatus();
		if (status && status.enabled) {
			const runtimeConfig = remoteConfigService.getRuntimeConfig();
			if (runtimeConfig && typeof runtimeConfig.REQUEST_TIMEOUT_MS === 'number') {
				return runtimeConfig.REQUEST_TIMEOUT_MS;
			}
		}
	} catch (_) {
		// fail-open to environment variable and fallback
	}
	return envTimeout;
}

function resolveExemptPaths() {
	if (testOverrides && testOverrides.exemptPaths instanceof Set) {
		return testOverrides.exemptPaths;
	}
	return parseExemptPaths();
}

function resolveRequestId(req) {
	const headers = req && req.headers;
	const candidates = [
		req && req.requestId,
		headers && headers['x-request-id'],
		headers && headers['X-Request-Id'],
		headers && headers['x-request-ID'],
	];

	for (const raw of candidates) {
		if (typeof raw !== 'string') continue;
		const trimmed = raw.trim();
		if (trimmed.length > 0 && trimmed.length <= 128 && /^[\x21-\x7E]+$/.test(trimmed)) {
			return trimmed;
		}
	}

	return randomUUID();
}

function normalizePath(req) {
	const raw = req.originalUrl || req.url || req.path || '';
	return String(raw).split('?')[0].replace(/\/+$/, '').toLowerCase();
}

function requestDeadline(req, res, next) {
	const exemptPaths = resolveExemptPaths();
	const requestPath = normalizePath(req);
	if (exemptPaths.has(requestPath)) {
		return next();
	}

	const timeoutMs = resolveTimeoutMs();
	const requestId = resolveRequestId(req);
	req.requestId = requestId;
	res.setHeader('X-Request-Id', requestId);

	const startTime = Date.now();
	const deadlineController = new AbortController();
	let deadlineFired = false;
	let responseFinished = false;
	let allowDeadlineResponse = false;
	const originalSetHeader = res.setHeader;
	const originalSend = res.send;
	const originalJson = res.json;
	const originalEnd = res.end;
	const originalWrite = res.write;
	const originalWriteHead = res.writeHead;
	const originalStatus = res.status;
	const canWrite = () => !req.requestDeadlineExceeded || allowDeadlineResponse;
	req.requestDeadlineSignal = deadlineController.signal;
	req.requestDeadlineLateStatusCode = 200;

	res.setHeader = function(...args) {
		if (!canWrite()) return this;
		return originalSetHeader.apply(this, args);
	};
	res.send = function(...args) {
		if (!canWrite()) return this;
		return originalSend.apply(this, args);
	};
	res.json = function(...args) {
		if (!canWrite()) return this;
		return originalJson.apply(this, args);
	};
	res.end = function(...args) {
		if (!canWrite()) return this;
		return originalEnd.apply(this, args);
	};
	res.write = function(...args) {
		if (!canWrite()) return false;
		return originalWrite.apply(this, args);
	};
	res.writeHead = function(...args) {
		if (!canWrite()) return this;
		return originalWriteHead.apply(this, args);
	};
	if (typeof originalStatus === 'function') {
		res.status = function(...args) {
			if (req.requestDeadlineExceeded && !allowDeadlineResponse) {
				const statusCode = Number(args[0]);
				if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
					req.requestDeadlineLateStatusCode = statusCode;
				}
				return this;
			}
			return originalStatus.apply(this, args);
		};
	}

	const closeIncompleteRequest = () => {
		if (req.requestDeadlineExceeded && !req.complete && !req.destroyed && typeof req.destroy === 'function') {
			req.destroy();
		}
	};

	const timer = setTimeout(() => {
		deadlineFired = true;
		if (responseFinished || res.headersSent || res.writableEnded) return;
		req.requestDeadlineExceeded = true;
		deadlineController.abort(new Error(`Request deadline exceeded after ${timeoutMs}ms`));

		const durationMs = Date.now() - startTime;
		console.warn(
			`[RequestDeadline] 408 REQUEST_TIMEOUT after ${durationMs}ms on ${req.method} ${requestPath} (requestId=${requestId})`,
		);

		allowDeadlineResponse = true;
		req.requestDeadlineResponse = true;
		try {
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.setHeader('Connection', 'close');
			res.status(408).json({
				error: 'Request Timeout',
				code: 'REQUEST_TIMEOUT',
				requestId,
				deadlineMs: timeoutMs,
				durationMs,
			});
		} catch (err) {
			console.warn(
				`[RequestDeadline] failed to send 408 for ${requestPath}: ${err && err.message ? err.message : err}`,
			);
		} finally {
			req.requestDeadlineResponse = false;
			allowDeadlineResponse = false;
		}
	}, timeoutMs);

	if (typeof timer.unref === 'function') {
		timer.unref();
	}

	const finalize = () => {
		responseFinished = true;
		if (!deadlineFired) clearTimeout(timer);
	};

	res.once('finish', finalize);
	res.once('close', finalize);
	res.once('finish', closeIncompleteRequest);
	res.once('close', closeIncompleteRequest);

	next();
}

function rejectExpiredRequest(req, res, next) {
	if (req.requestDeadlineExceeded) return;
	return next();
}

requestDeadline.enableTestMode = function() {
	// Preserved for compatibility
};

requestDeadline.disableTestMode = function() {
	testOverrides = null;
};

requestDeadline.setTestOverrides = function(overrides) {
	testOverrides = overrides;
};

requestDeadline.resetForTests = function() {
	invalidConfigWarnings.clear();
	testOverrides = null;
};

requestDeadline.constants = Object.freeze({
	DEFAULT_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	DEFAULT_EXEMPT_PATHS,
});

module.exports = requestDeadline;
requestDeadline.resolveRequestId = resolveRequestId;
requestDeadline.guard = rejectExpiredRequest;
