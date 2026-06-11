'use strict';

const { idempotencyService } = require('../services/storage/IdempotencyService');

/**
 * Express middleware to handle idempotency key checks and response caching.
 */
function idempotencyMiddleware(req, res, next) {
	// 1. Get the key from headers (recommended), request body, or query params
	const key = req.headers['idempotency-key']
		|| (req.body && (req.body.idempotencyKey || req.body.idempotency_key))
		|| (req.query && (req.query.idempotencyKey || req.query.idempotency_key));

	if (!key) {
		return next();
	}

	// Ensure the key is a string (e.g., if array of headers received)
	const keyToCheck = Array.isArray(key) ? key[0] : key;

	try {
		const cachedRecord = idempotencyService.get(keyToCheck, req.body);
		if (cachedRecord) {
			console.debug(`[Idempotency] Replaying cached response for key: ${keyToCheck}`);
			res.set('Idempotency-Replay', 'true');

			// Restore cached headers
			if (cachedRecord.headers) {
				for (const [hk, hv] of Object.entries(cachedRecord.headers)) {
					if (hv) res.set(hk, hv);
				}
			}

			res.status(cachedRecord.statusCode);

			let finalBody = cachedRecord.responseBody;
			// If the response body is an object or parsed JSON, append idempotencyReplayed: true
			if (finalBody && typeof finalBody === 'object') {
				finalBody = { ...finalBody, idempotencyReplayed: true };
				return res.json(finalBody);
			} else if (typeof finalBody === 'string') {
				try {
					const parsed = JSON.parse(finalBody);
					parsed.idempotencyReplayed = true;
					return res.json(parsed);
				} catch (e) {
					// Leave as plain string/text
				}
			}

			return res.send(finalBody);
		}
	} catch (error) {
		if (error.code === 'IDEMPOTENCY_CONFLICT') {
			console.warn(`[Idempotency] Conflict detected for key: ${keyToCheck}`);
			return res.status(409).json({
				error: error.message,
				code: error.code,
			});
		}
		return next(error);
	}

	// First-time request: intercept the response methods to cache the output on completion
	res.set('Idempotency-Replay', 'false');

	const originalSend = res.send;
	const originalJson = res.json;
	let responseCached = false;

	const cacheResponse = (body) => {
		if (responseCached || res.statusCode >= 500) {
			return;
		}
		responseCached = true;

		let responseBody = body;
		if (typeof body === 'string') {
			try {
				responseBody = JSON.parse(body);
			} catch (e) {
				// Keep as string
			}
		} else if (Buffer.isBuffer(body)) {
			try {
				responseBody = JSON.parse(body.toString('utf8'));
			} catch (e) {
				responseBody = body.toString('utf8');
			}
		}

		idempotencyService.set(keyToCheck, req.body, {
			statusCode: res.statusCode,
			body: responseBody,
			headers: {
				'content-type': res.get('content-type'),
			},
		});
	};

	res.send = function (body) {
		cacheResponse(body);
		return originalSend.apply(this, arguments);
	};

	res.json = function (obj) {
		cacheResponse(obj);
		return originalJson.apply(this, arguments);
	};

	next();
}

module.exports = {
	idempotencyMiddleware,
};
