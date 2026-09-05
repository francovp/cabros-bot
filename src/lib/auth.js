const crypto = require('crypto');
const sentryService = require('../services/monitoring/SentryService');
const { isProductionLikeEnvironment, isPreviewEnvironment } = require('./deploymentEnvironment');

const QUERY_DEPRECATION_FLAG_KEY = '__cabrosApiKeyQueryDeprecationWarned';

function parseApiKeyQuerySunset(value) {
	const raw = value === undefined ? process.env.API_KEY_QUERY_SUNSET : value;
	if (!raw) return null;
	const match = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	// Compare against UTC midnight to keep the boundary deterministic across deployments.
	return Date.UTC(year, month - 1, day);
}

function isQueryAuthSunsetReached() {
	const sunset = parseApiKeyQuerySunset();
	if (sunset === null) return false;
	return Date.now() >= sunset;
}

function isQueryApiKeyPresent(req) {
	if (!req || !req.query) return false;
	const value = req.query['api-key'];
	return typeof value === 'string' || Array.isArray(value);
}

function warnQueryApiKeyDeprecationOnce(req) {
	if (process.env[QUERY_DEPRECATION_FLAG_KEY] === '1') return;
	process.env[QUERY_DEPRECATION_FLAG_KEY] = '1';
	const route = (req && (req.originalUrl || req.url)) || 'unknown';
	const sunset = process.env.API_KEY_QUERY_SUNSET;
	const sunsetNote = sunset
		? ` Set API_KEY_QUERY_SUNSET=${sunset} has passed; remove the query parameter from your client.`
		: ' Migrate to the x-api-key header before the announced sunset date.';
	console.warn(`[auth] The api-key query parameter is deprecated and may leak through reverse-proxy access logs. Route: ${route}.${sunsetNote}`);
}

/**
 * Middleware to validate API key for webhook endpoints.
 * Requires `x-api-key` header to match `WEBHOOK_API_KEY` environment variable.
 * The legacy `api-key` query parameter is accepted for backward compatibility but emits a
 * one-time deprecation warning per process; when `API_KEY_QUERY_SUNSET` (YYYY-MM-DD, UTC) is
 * reached or passed, query-parameter auth is rejected with `401 API_KEY_QUERY_REMOVED`.
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

	// Sunset has passed: query-parameter auth is no longer accepted.
	if (isQueryApiKeyPresent(req) && isQueryAuthSunsetReached()) {
		return res.status(401).json({
			error: 'The api-key query parameter support has been removed; use the x-api-key header instead.',
			code: 'API_KEY_QUERY_REMOVED',
		});
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

	if (isQueryApiKeyPresent(req)) {
		warnQueryApiKeyDeprecationOnce(req);
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

function _resetQueryDeprecationFlagForTests() {
	delete process.env[QUERY_DEPRECATION_FLAG_KEY];
}

module.exports = {
	_isQueryApiKeyPresent: isQueryApiKeyPresent,
	_isQueryAuthSunsetReached: isQueryAuthSunsetReached,
	_parseApiKeyQuerySunset: parseApiKeyQuerySunset,
	_resetQueryDeprecationFlagForTests,
	isValidApiKey,
	validateApiKey,
};
