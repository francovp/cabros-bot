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
				`[RequestDeadline] Invalid ${name}; using the safe default of ${fallback}ms.`
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
				`[RequestDeadline] ${name}=${trimmed} outside ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}; using default ${fallback}ms.`
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

let testModeEnabled = false;

function resolveTimeoutMs() {
	if (testModeEnabled) {
		const override = Number(process.env.REQUEST_TIMEOUT_MS_TEST);
		return Number.isFinite(override) && override > 0
			? override
			: DEFAULT_TIMEOUT_MS;
	}
	return readPositiveInteger('REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

function resolveExemptPaths() {
	if (testModeEnabled) {
		const exempt = new Set(DEFAULT_EXEMPT_PATHS);
		const raw = process.env.REQUEST_DEADLINE_EXEMPT_PATHS_TEST;
		if (raw) {
			for (const part of String(raw).split(',')) {
				const trimmed = part.trim();
				if (trimmed) exempt.add(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
			}
		}
		return exempt;
	}
	return parseExemptPaths();
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
	const requestId = req.requestId || randomUUID();
	req.requestId = requestId;
	res.setHeader('X-Request-Id', requestId);

	const startTime = Date.now();
	let deadlineFired = false;
	let responseFinished = false;

	const timer = setTimeout(() => {
		deadlineFired = true;
		if (responseFinished) return;

		const durationMs = Date.now() - startTime;
		console.warn(
			`[RequestDeadline] 408 REQUEST_TIMEOUT after ${durationMs}ms on ${req.method} ${requestPath} (requestId=${requestId})`
		);

		try {
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.status(408).json({
				error: 'Request timeout exceeded',
				code: 'REQUEST_TIMEOUT',
				requestId,
				deadlineMs: timeoutMs,
				durationMs,
			});
		} catch (err) {
			console.warn(
				`[RequestDeadline] failed to send 408 for ${requestPath}: ${err && err.message ? err.message : err}`
			);
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

	next();
}

requestDeadline.enableTestMode = function () {
	testModeEnabled = true;
};

requestDeadline.disableTestMode = function () {
	testModeEnabled = false;
};

requestDeadline.resetForTests = function () {
	invalidConfigWarnings.clear();
};

requestDeadline.constants = Object.freeze({
	DEFAULT_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	DEFAULT_EXEMPT_PATHS,
});

module.exports = requestDeadline;
