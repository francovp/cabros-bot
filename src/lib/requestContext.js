/**
 * Express middleware that attaches a stable request context to every request.
 *
 * Goals:
 * - Generate a single requestId per HTTP request and reuse it across
 *   handler -> enrichment -> notification -> storage calls.
 * - Honor an inbound X-Request-Id (or x-request-id) header when present
 *   so upstream callers (proxies, retries, tests) can correlate logs.
 * - Stamp req.startTime so handlers can compute processingTimeMs without
 *   re-deriving it.
 * - Echo the resolved requestId back to the caller as X-Request-Id so
 *   operators can grep their own request across downstream logs.
 *
 * The middleware is additive and fail-open: if anything throws, the request
 * still proceeds with the previous behavior (no requestId on the request).
 */

const { v4: uuidv4 } = require('uuid');

const HEADER_CANDIDATES = ['x-request-id', 'X-Request-Id', 'x-request-ID'];
const SAFE_REQUEST_ID = /^[\x21-\x7E]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

function resolveRequestIdFromHeaders(headers) {
	if (!headers || typeof headers !== 'object') {
		return null;
	}
	for (const key of HEADER_CANDIDATES) {
		const raw = headers[key];
		if (typeof raw !== 'string') {
			continue;
		}
		const trimmed = raw.trim();
		if (
			trimmed.length > 0
			&& trimmed.length <= MAX_REQUEST_ID_LENGTH
			&& SAFE_REQUEST_ID.test(trimmed)
		) {
			return trimmed;
		}
	}
	return null;
}

/**
 * Build a request context object without mutating a request.
 * @param {object} [options]
 * @param {object} [options.headers] - Header bag to inspect for an inbound x-request-id value.
 * @param {string} [options.requestId] - Explicit requestId override; takes precedence over headers.
 * @returns {{ requestId: string, startTime: number }}
 */
function buildRequestContext({ headers, requestId } = {}) {
	const explicit = typeof requestId === 'string' ? requestId.trim() : '';
	const safeExplicit = (
		explicit.length > 0
		&& explicit.length <= MAX_REQUEST_ID_LENGTH
		&& SAFE_REQUEST_ID.test(explicit)
	)
		? explicit
		: null;

	return {
		requestId: safeExplicit || resolveRequestIdFromHeaders(headers) || uuidv4(),
		startTime: Date.now(),
	};
}

/**
 * Express middleware factory.
 * @returns {import('express').RequestHandler}
 */
function requestContextMiddleware() {
	return function requestContext(req, res, next) {
		try {
			const context = buildRequestContext({ headers: req.headers });
			req.requestId = context.requestId;
			req.startTime = context.startTime;
			req.requestContext = context;

			if (res && typeof res.setHeader === 'function') {
				res.setHeader('X-Request-Id', context.requestId);
			}
		} catch (error) {
			if (!req.requestId) {
				req.requestId = uuidv4();
			}
			if (!req.startTime) {
				req.startTime = Date.now();
			}
		}
		next();
	};
}

module.exports = {
	buildRequestContext,
	requestContextMiddleware,
	resolveRequestIdFromHeaders,
};
