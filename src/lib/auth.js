const crypto = require('crypto');
const sentryService = require('../services/monitoring/SentryService');
const { isProductionLikeEnvironment, isPreviewEnvironment } = require('./deploymentEnvironment');

const API_KEY_COMPARISON_LENGTH = 4096;

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

	// ponytail: 4 KiB ceiling keeps comparison work fixed; raise only for larger operator keys.
	const bufferApiKey = Buffer.alloc(API_KEY_COMPARISON_LENGTH);
	const bufferValidApiKey = Buffer.alloc(API_KEY_COMPARISON_LENGTH);
	const sourceApiKey = Buffer.from(keyToCheck);
	const sourceValidApiKey = Buffer.from(validApiKey);
	sourceApiKey.copy(bufferApiKey, 0, 0, API_KEY_COMPARISON_LENGTH);
	sourceValidApiKey.copy(bufferValidApiKey, 0, 0, API_KEY_COMPARISON_LENGTH);
	const buffersMatch = crypto.timingSafeEqual(bufferApiKey, bufferValidApiKey);
	return buffersMatch
		&& sourceApiKey.length === sourceValidApiKey.length
		&& sourceApiKey.length <= API_KEY_COMPARISON_LENGTH
		&& sourceValidApiKey.length <= API_KEY_COMPARISON_LENGTH;
}

module.exports = { isValidApiKey, validateApiKey };
