'use strict';

const compression = require('compression');

/**
 * Default compression configuration:
 * - threshold: 1024 bytes (responses smaller than 1KB are sent uncompressed)
 * - level: 6 (balanced CPU and compression ratio)
 */
const DEFAULT_COMPRESSION_OPTIONS = Object.freeze({
	threshold: 1024,
	level: 6,
});

/**
 * Checks whether the response content-type is Server-Sent Events (SSE).
 *
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
function isEventStream(res) {
	if (!res || typeof res.getHeader !== 'function') {
		return false;
	}
	const contentType = res.getHeader('content-type') ?? res.getHeader('Content-Type');
	if (!contentType) {
		return false;
	}
	const value = Array.isArray(contentType) ? contentType.join(';') : String(contentType);
	return value.includes('text/event-stream');
}

/**
 * Custom compression filter function:
 * - Skips when client requests no compression via x-no-compression header
 * - Skips streaming responses (text/event-stream)
 * - Delegates to compression.filter for standard checks (compressible content-types)
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function shouldCompress(req, res) {
	if (req && req.headers && req.headers['x-no-compression']) {
		return false;
	}
	if (isEventStream(res)) {
		return false;
	}
	return compression.filter(req, res);
}

/**
 * Creates configured Express response compression middleware.
 *
 * @param {import('compression').CompressionOptions} [options={}]
 * @returns {import('express').RequestHandler}
 */
function createCompressionMiddleware(options = {}) {
	const mergedOptions = {
		...DEFAULT_COMPRESSION_OPTIONS,
		...options,
		filter: options.filter || shouldCompress,
	};
	return compression(mergedOptions);
}

module.exports = {
	DEFAULT_COMPRESSION_OPTIONS,
	isEventStream,
	shouldCompress,
	createCompressionMiddleware,
};
