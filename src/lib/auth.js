const crypto = require('crypto');
const sentryService = require('../services/monitoring/SentryService');
const { isProductionLikeEnvironment, isPreviewEnvironment } = require('./deploymentEnvironment');

const SLOT_CURRENT = 'current';
const SLOT_PREVIOUS = 'previous';
const SLOT_NEXT = 'next';

function isRotationEnabled() {
	return process.env.ENABLE_API_KEY_ROTATION === 'true';
}

function normalizeSlotValue(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getApiKeyFromRequest(req) {
	const headerValue = req && req.headers
		? (req.headers['x-api-key'] || req.headers['X-API-Key'])
		: undefined;
	const queryValue = req && req.query ? req.query['api-key'] : undefined;
	const raw = headerValue || queryValue;
	if (Array.isArray(raw)) return raw[0];
	return raw;
}

function constantTimeEquals(expected, candidate) {
	if (typeof expected !== 'string' || typeof candidate !== 'string') return false;
	const bufferExpected = Buffer.from(expected);
	const bufferCandidate = Buffer.from(candidate);
	if (bufferExpected.length !== bufferCandidate.length) return false;
	return crypto.timingSafeEqual(bufferExpected, bufferCandidate);
}

function isPreviousSlotExpired() {
	const raw = process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT;
	if (!raw) return false;
	const parsed = Date.parse(raw);
	if (Number.isNaN(parsed)) return false;
	return parsed <= Date.now();
}

function getActiveSlots() {
	const slots = [];
	const current = normalizeSlotValue(process.env.WEBHOOK_API_KEY);
	if (current) slots.push({ name: SLOT_CURRENT, value: current });

	if (!isRotationEnabled()) {
		return slots;
	}

	const previous = normalizeSlotValue(process.env.WEBHOOK_API_KEY_PREVIOUS);
	if (previous && !isPreviousSlotExpired()) {
		slots.push({ name: SLOT_PREVIOUS, value: previous });
	}

	const next = normalizeSlotValue(process.env.WEBHOOK_API_KEY_NEXT);
	if (next) {
		slots.push({ name: SLOT_NEXT, value: next });
	}

	return slots;
}

function getAuthKeyStatus() {
	const current = normalizeSlotValue(process.env.WEBHOOK_API_KEY);
	const enabled = isRotationEnabled();
	const previous = normalizeSlotValue(process.env.WEBHOOK_API_KEY_PREVIOUS);
	const next = normalizeSlotValue(process.env.WEBHOOK_API_KEY_NEXT);
	const slots = [];
	if (current) slots.push(SLOT_CURRENT);
	if (previous && !isPreviousSlotExpired()) slots.push(SLOT_PREVIOUS);
	if (next) slots.push(SLOT_NEXT);

	return {
		enabled,
		configured: Boolean(current),
		slots,
		previousExpiresAt: normalizeSlotValue(process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT),
	};
}

/**
 * Middleware to validate API key for webhook endpoints.
 * Requires `x-api-key` header to match `WEBHOOK_API_KEY` environment variable.
 * When `ENABLE_API_KEY_ROTATION=true`, also accepts `WEBHOOK_API_KEY_PREVIOUS`
 * and `WEBHOOK_API_KEY_NEXT` (when configured) so operators can roll the
 * active credential with an overlap window instead of a hard cutover.
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

	const match = findMatchingKeySlot(req);
	if (!match) {
		return res.status(403).json({ error: 'Forbidden: Invalid API key' });
	}

	if (isRotationEnabled() && match.name) {
		req.apiKeySlot = match.name;
		res.setHeader('X-Cabros-Key-Slot', match.name);
	} else {
		req.apiKeySlot = SLOT_CURRENT;
	}

	next();
}

function findMatchingKeySlot(req) {
	const slots = getActiveSlots();
	if (slots.length === 0) return null;
	const keyToCheck = getApiKeyFromRequest(req);
	if (typeof keyToCheck !== 'string' || keyToCheck.length === 0) return null;
	for (const slot of slots) {
		if (constantTimeEquals(slot.value, keyToCheck)) {
			return slot;
		}
	}
	return null;
}

function isValidApiKey(req) {
	return findMatchingKeySlot(req) !== null;
}

module.exports = {
	isValidApiKey,
	validateApiKey,
	getAuthKeyStatus,
	getActiveSlots,
};
