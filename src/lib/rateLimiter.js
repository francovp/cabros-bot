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
 * When TRUST_PROXY is enabled (typical on Render), req.ip becomes the proxy IP.
 * This function creates a composite key using the API key (when present) or falls back
 * to a combination of IP and User-Agent fingerprint for unauthenticated requests.
 *
 * @param {import('express').Request} req Express request object
 * @returns {string} Rate limit bucket key
 */
function getRateLimitKey(req) {
	// Base IP (may be proxy IP when TRUST_PROXY is enabled)
	const baseIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';

	// Try to get API key from header or query param (same as validateApiKey middleware)
	const apiKey = req.headers['x-api-key'] || req.query?.['api-key'];

	if (apiKey) {
		// Hash the API key to avoid storing raw secrets in memory
		// Use first 12 chars of a simple hash for bucket differentiation
		const crypto = require('crypto');
		const keyHash = crypto.createHash('sha256').update(String(apiKey)).digest('hex').substring(0, 12);
		return `key:${keyHash}`;
	}

	// For unauthenticated requests, combine IP with User-Agent fingerprint
	// This provides better isolation than IP-only when behind shared proxies
	const userAgent = req.headers['user-agent'] || 'unknown';
	const uaHash = require('crypto').createHash('sha256').update(userAgent).digest('hex').substring(0, 8);
	return `ip:${baseIp}:ua:${uaHash}`;
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

rateLimiter.WEBHOOK_INGEST_PATHS = WEBHOOK_INGEST_PATHS;
rateLimiter.WEBHOOK_MAX_REQUESTS = WEBHOOK_MAX_REQUESTS;

module.exports = rateLimiter;
