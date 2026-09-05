const crypto = require('crypto');
const sentryService = require('../services/monitoring/SentryService');
const { isProductionLikeEnvironment, isPreviewEnvironment } = require('./deploymentEnvironment');

/**
 * Middleware to validate API key for webhook endpoints.
 * Requires `x-api-key` header to match `WEBHOOK_API_KEY` environment variable.
 */
function validateApiKey(req, res, next) {
	const validApiKey = process.env.WEBHOOK_API_KEY;

	if (!validApiKey) {
		const isProdLike = isProductionLikeEnvironment(process.env);
		const isPreview = isPreviewEnvironment(process.env);
		const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

		if (isProdLike && !isPreview && !isDevOrTest) {
			console.error('ERROR: WEBHOOK_API_KEY is not set in production environment. Webhook endpoints are disabled.');
			try {
				if (sentryService && typeof sentryService.captureRuntimeError === 'function') {
					sentryService.captureRuntimeError({
						channel: 'api',
						feature: 'auth',
						error: new Error('WEBHOOK_API_KEY is unset in production environment'),
						http: {
							method: req.method,
							url: req.originalUrl || req.url,
							statusCode: 503,
						},
						extra: {
							route: req.originalUrl || req.url,
							method: req.method,
							environment: process.env.NODE_ENV || 'production',
							type: 'auth-fail-open',
						},
					});
				}
			} catch (_) {
				// Fail-safe
			}
			return res.status(503).json({
				error: 'Service Misconfigured: WEBHOOK_API_KEY is not set in production',
				code: 'WEBHOOK_API_KEY_UNSET',
			});
		}

		console.warn('WARNING: WEBHOOK_API_KEY is not set. Webhook endpoints are insecure.');
		return next();
	}

	// Get API key from headers (recommended) or query params. Headers is recommended, query params are less secure.
	const apiKey = req.headers['x-api-key'] || req.query['api-key'];

	if (!apiKey) {
		return res.status(401).json({ error: 'Unauthorized: Missing API key' });
	}

	// Ensure apiKey is a string (in case of multiple headers)
	const keyToCheck = Array.isArray(apiKey) ? apiKey[0] : apiKey;

	if (!isValidApiKey(req)) {
		return res.status(403).json({ error: 'Forbidden: Invalid API key' });
	}

	next();
}

function isValidApiKey(req) {
	const validApiKey = process.env.WEBHOOK_API_KEY;
	if (!validApiKey) return false;

	const apiKey = req && req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])
		|| req && req.query && req.query['api-key'];
	const keyToCheck = Array.isArray(apiKey) ? apiKey[0] : apiKey;
	if (typeof keyToCheck !== 'string') return false;

	const bufferApiKey = Buffer.from(keyToCheck);
	const bufferValidApiKey = Buffer.from(validApiKey);
	return bufferApiKey.length === bufferValidApiKey.length
		&& crypto.timingSafeEqual(bufferApiKey, bufferValidApiKey);
}

function validateWebhookSignature(req, res, next) {
	const secret = process.env.WEBHOOK_SIGNING_SECRET;
	if (!secret) return next();

	const timestamp = req.headers && req.headers['x-webhook-timestamp'];
	const signature = req.headers && req.headers['x-webhook-signature'];
	if (typeof timestamp !== 'string' || typeof signature !== 'string') {
		return res.status(401).json({
			error: 'Unauthorized: Missing webhook signature',
			code: 'WEBHOOK_SIGNATURE_MISSING',
		});
	}

	const timestampMs = Number(timestamp);
	const toleranceMs = Number.parseInt(process.env.WEBHOOK_SIGNING_TOLERANCE_MS || '300000', 10);
	if (!Number.isSafeInteger(timestampMs)
		|| !Number.isFinite(toleranceMs)
		|| toleranceMs < 0
		|| Math.abs(Date.now() - timestampMs) > toleranceMs) {
		return res.status(403).json({
			error: 'Forbidden: Invalid webhook signature',
			code: 'WEBHOOK_SIGNATURE_INVALID',
		});
	}

	const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : '';
	const canonical = `${timestamp}\n${req.method}\n${req.originalUrl || req.url}\n${rawBody}`;
	const expected = `sha256=${crypto.createHmac('sha256', secret).update(canonical).digest('hex')}`;
	const provided = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) {
		return res.status(403).json({
			error: 'Forbidden: Invalid webhook signature',
			code: 'WEBHOOK_SIGNATURE_INVALID',
		});
	}

	return next();
}

module.exports = { isValidApiKey, validateApiKey, validateWebhookSignature };
