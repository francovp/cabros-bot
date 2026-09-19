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

module.exports = {
    STANDARD_ERROR_CODES,
    RETRYABLE_HTTP_STATUSES,
    buildErrorEnvelope,
    sendError,
    isRetryableStatus,
    normalizeCode,
};