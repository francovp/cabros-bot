'use strict';

const { idempotencyService } = require('../services/storage/IdempotencyService');

function getRequestPath(req) {
	if (typeof req.path === 'string' && req.path.length > 0) {
		return req.path;
	}

	if (typeof req.originalUrl === 'string' && req.originalUrl.length > 0) {
		return req.originalUrl.split('?')[0];
	}

	if (typeof req.url === 'string' && req.url.length > 0) {
		return req.url.split('?')[0];
	}

	return '';
}

function buildRequestFingerprint(req) {
	return {
		method: req.method || 'GET',
		path: getRequestPath(req),
		body: req.body || {},
		query: req.query || {},
	};
}

function sendCachedResponse(res, cachedRecord) {
	res.set('Idempotency-Replay', 'true');

	if (cachedRecord.headers) {
		for (const [hk, hv] of Object.entries(cachedRecord.headers)) {
			if (hv) res.set(hk, hv);
		}
	}

	res.status(cachedRecord.statusCode);

	let finalBody = cachedRecord.responseBody;
	if (finalBody && typeof finalBody === 'object') {
		finalBody = { ...finalBody, idempotencyReplayed: true };
		return res.json(finalBody);
	} else if (typeof finalBody === 'string') {
		try {
			const parsed = JSON.parse(finalBody);
			parsed.idempotencyReplayed = true;
			return res.json(parsed);
		} catch (error) {
			// Leave as plain string/text
		}
	}

	return res.send(finalBody);
}

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
	const requestFingerprint = buildRequestFingerprint(req);

	try {
		const reservation = idempotencyService.reserve(keyToCheck, requestFingerprint);
		if (reservation.state === 'completed') {
			console.debug(`[Idempotency] Replaying cached response for key: ${keyToCheck}`);
			return sendCachedResponse(res, reservation.record);
		}

		if (reservation.state === 'pending') {
			console.debug(`[Idempotency] Waiting for in-flight response for key: ${keyToCheck}`);
			return reservation.promise
				.then((cachedRecord) => sendCachedResponse(res, cachedRecord))
				.catch((error) => {
					if (error && error.code === 'IDEMPOTENCY_RELEASED') {
						return res.status(409).json({
							error: error.message,
							code: error.code,
						});
					}
					return next(error);
				});
		}
	} catch (error) {
		if (error.code === 'IDEMPOTENCY_CONFLICT') {
			console.warn(`[Idempotency] Conflict detected for key: ${keyToCheck}`);
			return res.status(409).json({
				error: error.message,
				code: error.code,
			});
		}
		if (error.code === 'IDEMPOTENCY_LIMIT_EXCEEDED') {
			console.warn(`[Idempotency] Limit exceeded for key: ${keyToCheck}`);
			return res.status(429).json({
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

		idempotencyService.set(keyToCheck, requestFingerprint, {
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

	res.on('finish', () => {
		if (!responseCached && res.statusCode >= 500) {
			const releaseError = new Error('Initial idempotent request failed before a replayable response was available');
			releaseError.code = 'IDEMPOTENCY_RELEASED';
			releaseError.statusCode = 409;
			idempotencyService.release(keyToCheck, requestFingerprint, releaseError);
		}
	});

	next();
}

module.exports = {
	idempotencyMiddleware,
};
