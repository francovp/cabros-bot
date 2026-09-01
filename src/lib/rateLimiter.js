// src/lib/rateLimiter.js

const crypto = require('crypto');

const rateLimit = new Map();
// Store: bucketKey -> { count, resetTime }

const MAX_KEYS = 10000;
// Protection against memory exhaustion
const DEFAULT_MAX_REQUESTS = 100;
// ponytail: fixed 1,000-request webhook bucket; split by API-key identity if isolation needs to scale.
const WEBHOOK_MAX_REQUESTS = 1000;
const DEFAULT_WINDOW_MS = 900000;
const WEBHOOK_INGEST_PATHS = new Set(['/api/webhook/alert', '/api/webhook/message']);
const invalidConfigWarnings = new Set();

let testModeEnabled = false;

function readPositiveInteger(name, fallback) {
	const rawValue = process.env[name];
	if (rawValue === undefined) return fallback;

	const value = Number(rawValue.trim());
	if (!/^\d+$/.test(rawValue.trim()) || !Number.isSafeInteger(value) || value <= 0) {
		if (!invalidConfigWarnings.has(name)) {
			invalidConfigWarnings.add(name);
			console.warn(`[RateLimiter] Invalid ${name}; using the safe default.`);
		}
		return fallback;
	}

	return value;
}

// ponytail: hash an API key fingerprint so logs do not expose the clear-text key.
function hashApiKey(apiKey) {
	return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function getConfiguredApiKeys() {
	const list = process.env.WEBHOOK_API_KEYS;
	if (list && list.trim()) {
		return list
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	const single = process.env.WEBHOOK_API_KEY;
	if (single && single.trim()) {
		return [single.trim()];
	}
	return [];
}

// Periodic cleanup
setInterval(() => {
	const now = Date.now();
	for (const [ip, data] of rateLimit.entries()) {
		if (now > data.resetTime) {
			rateLimit.delete(ip);
		}
	}
}, 60000).unref();

function isTrustProxyEnabled() {
	const value = process.env.TRUST_PROXY;
	if (value === undefined || value === null || value.trim() === '') {
		// Mirror parseTrustProxy default for managed reverse-proxy deployments.
		if (process.env.RENDER === 'true' || process.env.VERCEL === '1' || process.env.RAILWAY_ENVIRONMENT_NAME) {
			return true;
		}
		return false;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === 'true') return true;
	if (normalized === 'false') return false;
	if (/^\d+$/.test(normalized)) return parseInt(normalized, 10) > 0;
	return Boolean(normalized);
}

// ponytail: derive the rate-limit bucket key for the request.
// - Authenticated callers (matching WEBHOOK_API_KEY / WEBHOOK_API_KEYS) get a per-key
//   bucket so distinct API keys do not share limits.
// - Unauthenticated callers behind a trusted proxy fall back to IP + User-Agent
//   fingerprint so a noisy shared proxy IP does not exhaust the limit for everyone.
// - When TRUST_PROXY is disabled, the legacy IP-only key is preserved so direct
//   deployments behave byte-for-byte the same as before.
function deriveBucketKey({ req, ip, isWebhookIngest }) {
	const allowedKeys = getConfiguredApiKeys();
	const headerValue = req.headers
		? req.headers['x-api-key'] || req.headers['X-Api-Key']
		: undefined;
	if (headerValue && allowedKeys.includes(headerValue)) {
		const fingerprint = hashApiKey(headerValue);
		return isWebhookIngest ? `webhook:apikey:${fingerprint}` : `apikey:${fingerprint}`;
	}
	if (isTrustProxyEnabled()) {
		const ua = req.headers && req.headers['user-agent']
			? String(req.headers['user-agent']).trim()
			: '';
		const uaFingerprint = ua
			? crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16)
			: 'no-ua';
		const composite = `${ip}|${uaFingerprint}`;
		return isWebhookIngest ? `webhook:${composite}` : composite;
	}
	return isWebhookIngest ? `webhook:${ip}` : ip;
}

function rateLimiter(req, res, next) {
	if (
		(process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) &&
		!testModeEnabled &&
		process.env.ENABLE_TEST_RATE_LIMITER !== 'true'
	) {
		return next();
	}

	const requestPath = String(req.originalUrl || req.url || req.path || '')
		.split('?')[0]
		.replace(/\/+$/, '')
		.toLowerCase();
	const isWebhookIngest = WEBHOOK_INGEST_PATHS.has(requestPath);

	const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
	const bucketKey = deriveBucketKey({ req, ip, isWebhookIngest });
	const hasApiKey = bucketKey.startsWith('apikey:') || bucketKey.includes(':apikey:');
	const maxRequests = (() => {
		if (isWebhookIngest) return WEBHOOK_MAX_REQUESTS;
		if (hasApiKey) {
			const explicit = readPositiveInteger('RATE_LIMIT_API_KEY_MAX', 0);
			if (explicit > 0) return explicit;
		}
		return readPositiveInteger('RATE_LIMIT_MAX', DEFAULT_MAX_REQUESTS);
	})();
	const windowMs = readPositiveInteger('RATE_LIMIT_WINDOW_MS', DEFAULT_WINDOW_MS);

	const now = Date.now();

	let data = rateLimit.get(bucketKey);

	if (!data) {
		// Protection against memory exhaustion
		if (rateLimit.size >= MAX_KEYS) {
			const firstKey = rateLimit.keys().next().value;
			rateLimit.delete(firstKey);
		}

		data = {
			count: 1,
			resetTime: now + windowMs,
		};
		rateLimit.set(bucketKey, data);
	} else if (now > data.resetTime) {
		// Window expired, reset
		data.count = 1;
		data.resetTime = now + windowMs;
	} else {
		data.count++;
	}

	if (data.count > maxRequests) {
		const retryAfterSeconds = Math.max(1, Math.ceil((data.resetTime - now) / 1000));
		res.setHeader('Retry-After', String(retryAfterSeconds));
		return res.status(429).json({
			error: 'Too many requests, please try again later.',
			retryAfterSeconds,
		});
	}

	next();
}

rateLimiter.enableTestMode = function () {
	testModeEnabled = true;
};

rateLimiter.disableTestMode = function () {
	testModeEnabled = false;
	rateLimit.clear();
};

rateLimiter.reset = function () {
	rateLimit.clear();
};

rateLimiter.deriveBucketKey = deriveBucketKey;

module.exports = rateLimiter;
