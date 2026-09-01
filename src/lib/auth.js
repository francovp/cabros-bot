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

function getValidApiKeys() {
	const keys = new Set();
	const single = process.env.WEBHOOK_API_KEY;
	if (single && single.trim()) keys.add(single.trim());
	const list = process.env.WEBHOOK_API_KEYS;
	if (list && list.trim()) {
		for (const entry of list.split(',')) {
			const trimmed = entry.trim();
			if (trimmed) keys.add(trimmed);
		}
	}
	return Array.from(keys);
}

function isValidApiKey(req) {
	const validApiKeys = getValidApiKeys();
	if (validApiKeys.length === 0) return false;

	const apiKey = req && req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])
		|| req && req.query && req.query['api-key'];
	const keyToCheck = Array.isArray(apiKey) ? apiKey[0] : apiKey;
	if (typeof keyToCheck !== 'string') return false;

	// Timing-safe comparison against every configured key. A request is
	// accepted when it matches any of the configured keys; the constant-time
	// comparison is performed against each candidate so the check does not
	// leak which key matched through timing.
	const bufferApiKey = Buffer.from(keyToCheck);
	let matched = false;
	for (const candidate of validApiKeys) {
		const bufferCandidate = Buffer.from(candidate);
		if (bufferApiKey.length !== bufferCandidate.length) continue;
		if (crypto.timingSafeEqual(bufferApiKey, bufferCandidate)) {
			matched = true;
		}
	}
	return matched;
}

module.exports = { isValidApiKey, validateApiKey, getValidApiKeys };
