'use strict';

/**
 * Webhook body size limit configuration.
 *
 * Centralizes parsing of the `WEBHOOK_MAX_BODY_SIZE` env var and exposes the
 * limits consumed by `app.js` for both JSON and text/plain body parsers plus
 * the structured 413 error handler.
 */

const DEFAULT_MAX_BODY_SIZE = '256kb';
const MIN_BYTES = 1024; // 1 KB floor to avoid pathological zero/negative values
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard ceiling for the configurable value

const SIZE_UNITS = Object.freeze({
	b: 1,
	kb: 1024,
	mb: 1024 * 1024,
	gb: 1024 * 1024 * 1024,
});

/**
 * Parses a human-readable byte size string (e.g., `256kb`, `1MB`, `512b`) into
 * an integer byte count. Returns `null` when the value cannot be parsed or
 * produces an out-of-range result.
 *
 * @param {string|undefined|null} value raw value to parse
 * @returns {number|null} parsed byte count or `null` if invalid
 */
function parseByteSize(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;
	const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(trimmed);
	if (!match) return null;
	const numeric = Number(match[1]);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	const unit = match[2] || 'b';
	const multiplier = SIZE_UNITS[unit];
	if (multiplier === undefined) return null;
	const bytes = Math.floor(numeric * multiplier);
	if (bytes < MIN_BYTES || bytes > MAX_BYTES) return null;
	return bytes;
}

/**
 * Resolves the effective webhook body size limit in bytes from the
 * `WEBHOOK_MAX_BODY_SIZE` env var, applying the documented default and
 * bounded validation. Malformed or out-of-range values fall back to the
 * default without raising so a typo cannot disable size enforcement.
 *
 * @param {object} [env=process.env] Environment variables object (injectable for tests)
 * @returns {{ limitBytes: number, source: 'env'|'default', rawValue: string|null, limitString: string }}
 */
function resolveWebhookMaxBodySize(env = process.env) {
	const rawValue = env.WEBHOOK_MAX_BODY_SIZE;
	const parsed = parseByteSize(rawValue);
	if (parsed !== null) {
		return {
			limitBytes: parsed,
			source: 'env',
			rawValue,
			limitString: rawValue,
		};
	}
	if (rawValue) {
		console.warn(
			`[webhookBodySize] Ignoring invalid WEBHOOK_MAX_BODY_SIZE=${rawValue}; using default ${DEFAULT_MAX_BODY_SIZE}`
		);
	}
	return {
		limitBytes: parseByteSize(DEFAULT_MAX_BODY_SIZE),
		source: 'default',
		rawValue: rawValue || null,
		limitString: DEFAULT_MAX_BODY_SIZE,
	};
}

/**
 * Builds the JSON and text/plain body-parser configurations plus an Express
 * error-handling middleware that converts `entity.too.large` errors into a
 * structured `{ success: false, error: "PAYLOAD_TOO_LARGE" }` response.
 *
 * @param {object} [options]
 * @param {object} [options.env=process.env] Environment variables object (injectable for tests)
 * @returns {{
 *   jsonLimit: string,
 *   textLimit: string,
 *   middleware: import('express').RequestHandler,
 *   payloadTooLargeResponse: (req: import('express').Request, res: import('express').Response) => void
 * }}
 */
function buildWebhookBodySize(options = {}) {
	const env = options.env || process.env;
	const { limitString } = resolveWebhookMaxBodySize(env);

	const payloadTooLargeResponse = (req, res) => {
		res.status(413).json({
			success: false,
			error: 'PAYLOAD_TOO_LARGE',
			message: `Request body exceeds maximum size of ${limitString}`,
			limit: limitString,
		});
	};

	// 4-arg signature is required for Express to recognize this as an error-handling middleware.
	// eslint-disable-next-line no-unused-vars
	const middleware = (err, req, res, next) => {
		if (err && err.type === 'entity.too.large') {
			payloadTooLargeResponse(req, res);
			return;
		}
		next(err);
	};

	return {
		jsonLimit: limitString,
		textLimit: limitString,
		middleware,
		payloadTooLargeResponse,
	};
}

module.exports = {
	DEFAULT_MAX_BODY_SIZE,
	MAX_BYTES,
	MIN_BYTES,
	parseByteSize,
	resolveWebhookMaxBodySize,
	buildWebhookBodySize,
};
