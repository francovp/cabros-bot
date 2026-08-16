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
	let body = req.body || {};
	if (body && typeof body === 'object') {
		body = { ...body };
		delete body.idempotencyKey;
		delete body.idempotency_key;
	}

	let query = req.query || {};
	if (query && typeof query === 'object') {
		query = { ...query };
		delete query.idempotencyKey;
		delete query.idempotency_key;
	}

	return {
		method: req.method || 'GET',
		path: getRequestPath(req),
		body,
		query,
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

function getIdempotencyKey(req) {
	const headers = req.headers || {};
	if (headers['idempotency-key'] !== undefined) {
		return headers['idempotency-key'];
	}
	if (headers['x-idempotency-key'] !== undefined) {
		return headers['x-idempotency-key'];
	}

	const body = req.body;
	if (body && typeof body === 'object') {
		if (body.idempotencyKey !== undefined) return body.idempotencyKey;
		if (body.idempotency_key !== undefined) return body.idempotency_key;
	}

	const query = req.query;
	if (query && typeof query === 'object') {
		if (query.idempotencyKey !== undefined) return query.idempotencyKey;
		if (query.idempotency_key !== undefined) return query.idempotency_key;
	}

	return undefined;
}

/**
 * Express middleware to handle idempotency key checks and response caching.
 */
function idempotencyMiddleware(req, res, next) {
	// 1. Get the key from headers (recommended), request body, or query params
	const key = getIdempotencyKey(req);

	if (key === undefined) {
		return next();
	}

	// Reject non-string values instead of allowing object/array identity keys.
	if (typeof key !== 'string' || !key.trim()) {
		return res.status(400).json({
			error: 'Idempotency key must be a non-empty string',
			code: 'INVALID_REQUEST',
		});
	}

	const requestFingerprint = buildRequestFingerprint(req);

	const handleReservation = (reservation) => {
		if (reservation.state === 'completed') {
			console.debug('[Idempotency] Replaying cached response');
			return sendCachedResponse(res, reservation.record);
		}

		if (reservation.state === 'pending') {
			console.debug('[Idempotency] Waiting for in-flight response');
			return reservation.promise
				.then((cachedRecord) => sendCachedResponse(res, cachedRecord))
				.catch((error) => {
					if (error && (error.code === 'IDEMPOTENCY_RELEASED' || error.code === 'IDEMPOTENCY_CONFLICT')) {
						return res.status(409).json({
							error: error.message,
							code: error.code || 'IDEMPOTENCY_CONFLICT',
						});
					}
					return next(error);
				});
		}

		// First-time request: intercept the response methods to cache the output on completion
		res.set('Idempotency-Replay', 'false');

		const originalSend = res.send;
		const originalJson = res.json;
		let responseCached = false;

		const cacheResponse = (body) => {
			if (responseCached) {
				return;
			}

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

			const replayableIndeterminateQueueResponse = res.statusCode === 503
				&& responseBody
				&& typeof responseBody === 'object'
				&& responseBody.code === 'JOB_QUEUE_ACCEPTANCE_UNKNOWN'
				&& typeof responseBody.jobId === 'string'
				&& responseBody.jobId.length > 0;
			const replayableIndeterminateOrderResponse = res.statusCode === 503
				&& responseBody
				&& typeof responseBody === 'object'
				&& responseBody.code === 'BINANCE_ORDER_STATUS_UNKNOWN';
			if (res.statusCode >= 500 && !replayableIndeterminateQueueResponse && !replayableIndeterminateOrderResponse) {
				return;
			}
			responseCached = true;

			const contentType = res.get('content-type');
			const headers = {};
			if (contentType !== undefined && contentType !== null) {
				headers['content-type'] = contentType;
			}

			idempotencyService.set(key, requestFingerprint, {
				statusCode: res.statusCode,
				body: responseBody,
				headers,
			});
		};

		res.send = function(body) {
			const result = originalSend.apply(this, arguments);
			cacheResponse(body);
			return result;
		};

		res.json = function(obj) {
			const result = originalJson.apply(this, arguments);
			cacheResponse(obj);
			return result;
		};

		res.on('finish', () => {
			if (!responseCached && res.statusCode >= 500) {
				const releaseError = new Error('Initial idempotent request failed before a replayable response was available');
				releaseError.code = 'IDEMPOTENCY_RELEASED';
				releaseError.statusCode = 409;
				idempotencyService.release(key, requestFingerprint, releaseError);
			}
		});

		return next();
	};

	try {
		const reservation = idempotencyService.reserve(key, requestFingerprint);
		if (reservation && typeof reservation.then === 'function') {
			return reservation
				.then(handleReservation)
				.catch((error) => {
					if (error.code === 'IDEMPOTENCY_CONFLICT') {
						console.warn('[Idempotency] Conflict detected');
						return res.status(409).json({
							error: error.message,
							code: error.code,
						});
					}
					if (error.code === 'IDEMPOTENCY_LIMIT_EXCEEDED') {
						console.warn('[Idempotency] Limit exceeded');
						return res.status(429).json({
							error: error.message,
							code: error.code,
						});
					}
					return next(error);
				});
		}
		return handleReservation(reservation);
	} catch (error) {
		if (error.code === 'IDEMPOTENCY_CONFLICT') {
			console.warn('[Idempotency] Conflict detected');
			return res.status(409).json({
				error: error.message,
				code: error.code,
			});
		}
		if (error.code === 'IDEMPOTENCY_LIMIT_EXCEEDED') {
			console.warn('[Idempotency] Limit exceeded');
			return res.status(429).json({
				error: error.message,
				code: error.code,
			});
		}
		return next(error);
	}
}

module.exports = {
	idempotencyMiddleware,
};
