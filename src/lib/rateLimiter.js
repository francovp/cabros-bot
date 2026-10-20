const crypto = require('crypto');
const { sendErrorFrom } = require('./errorEnvelope');

const RATE_LIMIT_KEY_SALT = 'cabros-bot-rate-limit-identity';
const keyHashCache = new Map();
const MAX_KEY_HASH_ENTRIES = 500;

function deriveApiKeyHash(apiKey) {
	const cached = keyHashCache.get(apiKey);
	if (cached) return cached;
	if (keyHashCache.size >= MAX_KEY_HASH_ENTRIES) {
		keyHashCache.clear();
	}
	const hash = crypto.scryptSync(apiKey, RATE_LIMIT_KEY_SALT, 6, { N: 1024, r: 8, p: 1 }).toString('hex');
	keyHashCache.set(apiKey, hash);
	return hash;
}

// src/lib/rateLimiter.js

const rateLimit = new Map();
// Store: rateLimitKey -> { count, resetTime }

const MAX_KEYS = 10000;
// Protection against memory exhaustion
const DEFAULT_MAX_REQUESTS = 100;
// ponytail: fixed 1,000-request webhook bucket; split by API-key identity if isolation needs to scale.
const WEBHOOK_MAX_REQUESTS = 1000;
const DEFAULT_WINDOW_MS = 900000;
const WEBHOOK_INGEST_PATHS = new Set([
	'/api/webhook/alert',
	'/api/webhook/message',
	'/api/webhook/expanded-analysis-alert',
	'/api/webhook/market-scanner-alert',
	'/api/webhook/volume-confirmation',
	'/api/webhook/symbol-analysis',
	'/api/news-monitor',
]);
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

/**
 * Extracts a client identifier for rate limiting that works correctly behind reverse proxies.
 * When TRUST_PROXY is enabled (typical on Render), req.ip reflects the client IP when forwarded
 * by trusted reverse proxies.
 * For authenticated requests, this function creates a composite key binding the API key hash
 * and the trusted client IP to maintain isolation across distinct clients sharing an API key.
 * For unauthenticated requests, it keys strictly by the trusted client IP to prevent header
 * rotation bypasses (such as spoofed User-Agent headers).
 *
 * @param {import('express').Request} req Express request object
 * @returns {string} Rate limit bucket key
 */
function getRateLimitKey(req) {
	// Base IP (derived from req.ip when TRUST_PROXY is enabled, with remoteAddress fallback)
	const baseIp = req?.ip || req?.socket?.remoteAddress || '127.0.0.1';

	// Try to get API key from header or query param (normalized identically to validateApiKey middleware)
	const rawApiKey = (req?.headers && (req.headers['x-api-key'] || req.headers['X-API-Key']))
		|| (req?.query && req.query['api-key']);
	const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;

	if (typeof apiKey === 'string' && apiKey.length > 0) {
		// Derive a pseudonymous token from the API key using scrypt to avoid storing raw secrets in memory
		// and satisfy CodeQL password hash computational effort rules. Use first 12 chars for bucket differentiation.
		const keyHash = deriveApiKeyHash(apiKey);
		return `key:${keyHash}:ip:${baseIp}`;
	}

	// For unauthenticated requests, use trusted client IP as the complete boundary
	// to prevent caller-controlled header rotation (e.g. User-Agent) from bypassing limits
	return `ip:${baseIp}`;
}

// Periodic cleanup
setInterval(() => {
	const now = Date.now();
	for (const [key, data] of rateLimit.entries()) {
		if (now > data.resetTime) {
			rateLimit.delete(key);
		}
	}
}, 60000).unref();

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
	const maxRequests = isWebhookIngest
		? WEBHOOK_MAX_REQUESTS
		: readPositiveInteger('RATE_LIMIT_MAX', DEFAULT_MAX_REQUESTS);
	const windowMs = readPositiveInteger('RATE_LIMIT_WINDOW_MS', DEFAULT_WINDOW_MS);

	const bucketKey = isWebhookIngest ? `webhook:${getRateLimitKey(req)}` : getRateLimitKey(req);
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

	const remaining = Math.max(0, maxRequests - data.count);
	const resetSeconds = Math.ceil(data.resetTime / 1000);
	res.setHeader('X-RateLimit-Limit', String(maxRequests));
	res.setHeader('X-RateLimit-Remaining', String(remaining));
	res.setHeader('X-RateLimit-Reset', String(resetSeconds));

	if (data.count > maxRequests) {
		const retryAfterSeconds = Math.max(1, Math.ceil((data.resetTime - now) / 1000));
		res.setHeader('Retry-After', String(retryAfterSeconds));
		return sendErrorFrom(res, 429, {
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
	keyHashCache.clear();
};

rateLimiter.WEBHOOK_INGEST_PATHS = WEBHOOK_INGEST_PATHS;
rateLimiter.WEBHOOK_MAX_REQUESTS = WEBHOOK_MAX_REQUESTS;
rateLimiter._getRateLimitKey = getRateLimitKey;

module.exports = rateLimiter;
