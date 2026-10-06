/**
 * errorEnvelope - Shared structured error response envelope builder.
 *
 * Standardizes the error JSON returned by `/api/*` endpoints so that
 * API consumers (TradingView webhook integrators, cron jobs, admin
 * console, monitoring/Sentry) can programmatically distinguish:
 *   - Validation errors (bad input) vs. provider errors vs. internal errors
 *   - Retryable errors (502/503) vs. permanent errors (400/404)
 *   - Feature-disabled responses vs. actual failures
 *
 * Each envelope carries:
 *   success: false              always false on error
 *   error:   "<human msg>"      always present
 *   code:    "<MACHINE_CODE>"   one of STANDARD_ERROR_CODES
 *   requestId: <uuid>           when available
 *   retryable: boolean          true when client should retry
 *
 * The envelope is additive — existing HTTP status codes and
 * fail-open patterns remain unchanged.
 */

const { v4: uuidv4 } = require('uuid');

const STANDARD_ERROR_CODES = Object.freeze({
    INVALID_REQUEST: 'INVALID_REQUEST',
    FEATURE_DISABLED: 'FEATURE_DISABLED',
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
    PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
    DELIVERY_FAILED: 'DELIVERY_FAILED',
    STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Status-derived default error codes. Used when a response body carries no
 * explicit `code`, so an automated monitor can still classify the failure.
 *
 * This NEVER changes an endpoint's HTTP status code — it only supplies the
 * `code` field for a response that already exists.
 */
const STATUS_DEFAULT_CODES = Object.freeze({
	400: STANDARD_ERROR_CODES.INVALID_REQUEST,
	401: 'UNAUTHORIZED',
	403: STANDARD_ERROR_CODES.FEATURE_DISABLED,
	404: 'NOT_FOUND',
	409: STANDARD_ERROR_CODES.INVALID_REQUEST,
	413: 'PAYLOAD_TOO_LARGE',
	429: 'RATE_LIMITED',
	500: STANDARD_ERROR_CODES.INTERNAL_ERROR,
	502: STANDARD_ERROR_CODES.PROVIDER_UNAVAILABLE,
	503: STANDARD_ERROR_CODES.STORAGE_UNAVAILABLE,
	504: STANDARD_ERROR_CODES.PROVIDER_TIMEOUT,
});

function normalizeCode(code) {
    if (!code || typeof code !== 'string') {
        return STANDARD_ERROR_CODES.INTERNAL_ERROR;
    }
    const upper = code.toUpperCase();
    if (Object.values(STANDARD_ERROR_CODES).includes(upper)) {
        return upper;
    }
    return upper;
}

function isRetryableStatus(statusCode) {
    return Number.isInteger(statusCode) && RETRYABLE_HTTP_STATUSES.has(statusCode);
}

/**
 * Resolve the default machine-readable code for an HTTP status.
 *
 * @param {number} statusCode
 * @returns {string} one of STANDARD_ERROR_CODES or a documented status code
 */
function resolveErrorCode(statusCode) {
    if (!Number.isInteger(statusCode)) {
        return STANDARD_ERROR_CODES.INTERNAL_ERROR;
    }
    if (STATUS_DEFAULT_CODES[statusCode]) {
        return STATUS_DEFAULT_CODES[statusCode];
    }
    if (statusCode >= 400 && statusCode < 500) {
        return STANDARD_ERROR_CODES.INVALID_REQUEST;
    }
    if (statusCode >= 500) {
        return STANDARD_ERROR_CODES.INTERNAL_ERROR;
    }
    return STANDARD_ERROR_CODES.INTERNAL_ERROR;
}

/**
 * Resolve the correlation id to stamp on an envelope. Prefers the id the global
 * request-deadline middleware already stamped on `req` so the envelope, the
 * `X-Request-Id` response header, and Sentry all reference the same value.
 *
 * @param {object} [req] - Express request
 * @returns {string} existing request id or a freshly minted UUID
 */
function resolveEnvelopeRequestId(req) {
    const candidates = [
        req && req.requestId,
        req && req.headers && req.headers['x-request-id'],
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate;
        }
    }

    return uuidv4();
}

/**
 * Build a structured error envelope.
 *
 * @param {object} options
 * @param {string} [options.error] - Human-readable error message
 * @param {string} [options.code] - Machine-readable error code
 * @param {string} [options.requestId] - Request correlation ID
 * @param {number} [options.statusCode] - HTTP status code (drives retryable)
 * @param {boolean} [options.retryable] - Override retryable inference
 * @param {object} [options.details] - Optional extra details (already
 *        sanitized; the caller is responsible for excluding secrets).
 * @returns {object} Structured error envelope
 */
function buildErrorEnvelope({
    error,
    code,
    requestId,
    statusCode,
    retryable,
    details,
} = {}) {
    const safeRequestId = typeof requestId === 'string' && requestId.length > 0
        ? requestId
        : uuidv4();
    const safeCode = normalizeCode(code);
    const safeMessage = typeof error === 'string' && error.length > 0
        ? error
        : 'Internal server error';
    const isRetryable = typeof retryable === 'boolean'
        ? retryable
        : isRetryableStatus(statusCode);

    const envelope = {
        success: false,
        error: safeMessage,
        code: safeCode,
        requestId: safeRequestId,
        retryable: isRetryable,
    };

    if (details && typeof details === 'object' && Object.keys(details).length > 0) {
        envelope.details = details;
    }

    return envelope;
}

/**
 * Convenience helper that returns a function-call style API.
 *
 * @param {object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {object} options - Same options as buildErrorEnvelope
 * @returns {object} The envelope that was sent
 */
function sendError(res, statusCode, options = {}) {
    const envelope = buildErrorEnvelope({ ...options, statusCode });
    res.status(statusCode).json(envelope);
    return envelope;
}

/**
 * Additive error sender for endpoints that already return richer,
 * endpoint-specific bodies (provider codes, `message`, `storage`, `details`,
 * pagination hints, ...).
 *
 * Unlike {@link sendError} this helper does NOT replace the response body. It
 * only guarantees the standardized envelope fields are present:
 *   success: false, code, requestId, retryable
 *
 * Every pre-existing field is preserved byte-for-byte, so callers depending on
 * `message` or provider-specific shapes keep working. The HTTP status code is
 * used exactly as supplied and is never reassigned.
 *
 * @param {object} res - Express response object
 * @param {number} statusCode - HTTP status code to send (unchanged)
 * @param {object} [body] - Existing response body to extend
 * @param {object} [options]
 * @param {string} [options.requestId] - Correlation id override
 * @param {boolean} [options.retryable] - Explicit retryable override
 * @returns {object} The body that was sent
 */
function sendErrorFrom(res, statusCode, body = {}, options = {}) {
    const source = body && typeof body === 'object' && !Array.isArray(body)
        ? body
        : {};

    const merged = {
        ...source,
        success: false,
        code: source.code || resolveErrorCode(statusCode),
        requestId: source.requestId || options.requestId || resolveEnvelopeRequestId(res && res.req),
        retryable: typeof options.retryable === 'boolean'
            ? options.retryable
            : isRetryableStatus(statusCode),
    };

    res.status(statusCode).json(merged);
    return merged;
}

module.exports = {
    STANDARD_ERROR_CODES,
    RETRYABLE_HTTP_STATUSES,
    STATUS_DEFAULT_CODES,
    buildErrorEnvelope,
    sendError,
    sendErrorFrom,
    isRetryableStatus,
    normalizeCode,
    resolveErrorCode,
    resolveEnvelopeRequestId,
};