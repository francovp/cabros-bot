// src/lib/rateLimiter.js

const crypto = require('crypto');
const { getValidApiKeys } = require('./auth');

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

// Resolve a per-process HMAC secret for API-key fingerprinting so the bucket
// key is not derivable from a publicly available algorithm (CodeQL:
// "password hash with insufficient computational effort"). When the operator
// has not configured a secret, fall back to a process-lifetime random value
// — bucket keys are still non-reversible to cleartext without the running
// process, but per-deploy rotation remains under operator control.
let fingerprintSecret = null;
function getFingerprintSecret() {
	if (fingerprintSecret) return fingerprintSecret;
	const configured = process.env.RATE_LIMIT_FINGERPRINT_SECRET;
	if (configured && configured.trim().length >= 16) {
		fingerprintSecret = configured.trim();
		return fingerprintSecret;
	}
	fingerprintSecret = crypto.randomBytes(32).toString('hex');
	return fingerprintSecret;
}

// ponytail: derive a non-reversible fingerprint of an API key. Uses
// HMAC-SHA256 so an attacker with access to a single bucket key cannot
// recover the cleartext; the secret is per-process and never logged.
function hashApiKey(apiKey) {
	return crypto
		.createHmac('sha256', getFingerprintSecret())
		.update(String(apiKey))
		.digest('hex')
		.slice(0, 16);
}

// Returns the union of all configured API keys (primary + secondary). The
// list is what the limiter uses to identify authenticated callers; the same
// set is consulted by `src/lib/auth.js#isValidApiKey` so a key recognized
// by the limiter is also accepted by the auth middleware.
function getConfiguredApiKeys() {
	return getValidApiKeys();
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
// - Authenticated callers (matching WEBHOOK_API_KEY / WEBHOOK_API_KEYS) get a
//   per-key bucket so distinct API keys do not share limits.
// - Unauthenticated callers are keyed on the trusted `req.ip` (which behind
//   `TRUST_PROXY` is the real client IP from the proxy header). The
//   User-Agent header is intentionally NOT folded into the key — it is
//   attacker-controlled and would let anonymous callers rotate buckets
//   indefinitely to bypass the limit.
// - When `TRUST_PROXY` is disabled, the legacy IP-only key is preserved so
//   direct deployments behave byte-for-byte the same as before.
function deriveBucketKey({ req, ip, isWebhookIngest }) {
	const allowedKeys = getConfiguredApiKeys();
	const headerValue = req.headers
		? req.headers['x-api-key'] || req.headers['X-Api-Key']
		: undefined;
	if (headerValue && allowedKeys.includes(headerValue)) {
		const fingerprint = hashApiKey(headerValue);
		return isWebhookIngest ? `webhook:apikey:${fingerprint}` : `apikey:${fingerprint}`;
	}
	// Anonymous traffic: key solely on the trusted `req.ip` (which already
	// reflects the proxy-decided client IP when `TRUST_PROXY` is on). This
	// keeps a single noisy client pinned to one bucket regardless of any
	// attacker-controlled headers.
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
rateLimiter.getConfiguredApiKeys = getConfiguredApiKeys;
rateLimiter.hashApiKey = hashApiKey;
rateLimiter.getFingerprintSecret = getFingerprintSecret;

module.exports = rateLimiter;
