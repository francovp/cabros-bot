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

/**
 * Resolve the admin/operator API key.
 *
 * Returns `ADMIN_API_KEY` when set, otherwise falls back to `WEBHOOK_API_KEY`
 * for backward compatibility with deployments that have not yet introduced
 * the dedicated credential. The fallback is intentionally narrow: once an
 * operator opts into `ADMIN_API_KEY`, the webhook key is no longer accepted
 * on admin/operator routes — see `isValidAdminApiKey` and the
 * `validateAdminApiKey` middleware.
 */
function getAdminApiKey() {
	const adminKey = String(process.env.ADMIN_API_KEY || '').trim();
	if (adminKey) return adminKey;
	return String(process.env.WEBHOOK_API_KEY || '');
}

/**
 * Returns true when `ADMIN_API_KEY` is configured. When true, the admin
 * route auth path MUST scope API-key matching to the dedicated key; the
 * webhook key is never accepted on admin/operator or trading routes.
 */
function isAdminApiKeyScoped() {
	return Boolean(String(process.env.ADMIN_API_KEY || '').trim());
}

/**
 * Returns true when the supplied request carries the admin/operator API key.
 *
 * When `ADMIN_API_KEY` is configured this enforces strict scope separation:
 * the webhook key is never accepted on admin routes. When `ADMIN_API_KEY`
 * is unset, the webhook key remains accepted (legacy fallback) so existing
 * deployments do not break; new deployments should set `ADMIN_API_KEY` to
 * get defense-in-depth.
 *
 * When neither `ADMIN_API_KEY` nor `WEBHOOK_API_KEY` is set, the call
 * returns true so the dev/test paths stay open. The production
 * `requireConfiguredAdminAccess` gate (or `validateApiKey`'s prod-only
 * 503 short-circuit) is what stops the request in real deployments.
 */
function isValidAdminApiKey(req) {
	const adminKey = String(process.env.ADMIN_API_KEY || '').trim();
	if (adminKey) {
		const apiKey = req && req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])
			|| req && req.query && req.query['api-key'];
		const keyToCheck = Array.isArray(apiKey) ? apiKey[0] : apiKey;
		if (typeof keyToCheck !== 'string') return false;
		const bufferApiKey = Buffer.from(keyToCheck);
		const bufferAdminKey = Buffer.from(adminKey);
		if (bufferApiKey.length !== bufferAdminKey.length) return false;
		return crypto.timingSafeEqual(bufferApiKey, bufferAdminKey);
	}
	// Legacy fallback: keep accepting WEBHOOK_API_KEY until ADMIN_API_KEY
	// is configured. Once configured, the path above takes over and the
	// webhook key no longer grants admin access.
	if (process.env.WEBHOOK_API_KEY) {
		return isValidApiKey(req);
	}
	// No credential configured — preserve the legacy dev/test "open" path
	// so `validateApiKey` (which is what the original middleware called)
	// could log a warning and call next(). Production is gated upstream
	// by `requireConfiguredAdminAccess`.
	return true;
}

/**
 * Returns true when the supplied request carries the Binance trading API
 * key (independent of admin/webhook scopes). The check is short-circuited
 * when `BINANCE_TRADING_API_KEY` is not configured; the caller is then
 * expected to fall back to the admin/operator role check.
 */
function isValidBinanceTradingApiKey(req) {
	const tradingKey = String(process.env.BINANCE_TRADING_API_KEY || '').trim();
	if (!tradingKey) return false;
	const apiKey = req && req.headers && (req.headers['x-api-key'] || req.headers['X-API-Key'])
		|| req && req.query && req.query['api-key'];
	const keyToCheck = Array.isArray(apiKey) ? apiKey[0] : apiKey;
	if (typeof keyToCheck !== 'string') return false;
	const bufferApiKey = Buffer.from(keyToCheck);
	const bufferTradingKey = Buffer.from(tradingKey);
	if (bufferApiKey.length !== bufferTradingKey.length) return false;
	return crypto.timingSafeEqual(bufferApiKey, bufferTradingKey);
}

module.exports = {
	getAdminApiKey,
	isAdminApiKeyScoped,
	isValidAdminApiKey,
	isValidApiKey,
	isValidBinanceTradingApiKey,
	validateApiKey,
};
