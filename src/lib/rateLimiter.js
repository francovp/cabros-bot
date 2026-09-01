// src/lib/rateLimiter.js

const rateLimit = new Map();
// Store: IP -> { count, resetTime }

const MAX_KEYS = 10000;
// Protection against memory exhaustion
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 900000;
const ENDPOINT_WINDOW_MS = 60000;
const ENDPOINT_LIMITS = new Map([
	['/api/webhook/expanded-analysis-alert', ['heavy', 5]],
	['/api/webhook/market-scanner-alert', ['heavy', 5]],
	['/api/news-monitor', ['heavy', 5]],
	['/api/trading/binance/orders', ['trading', 10]],
	['/api/webhook/alert', ['standard', 30]],
	['/api/webhook/message', ['standard', 30]],
	['/api/webhook/volume-confirmation', ['standard', 30]],
	['/healthcheck', ['light', 100]],
	['/ready', ['light', 100]],
	['/api/status', ['light', 100]],
	['/api/capabilities', ['light', 100]],
	['/openapi.json', ['light', 100]],
	['/docs', ['light', 100]],
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

// Periodic cleanup
setInterval(() => {
	const now = Date.now();
	for (const [ip, data] of rateLimit.entries()) {
		if (now > data.resetTime) {
			rateLimit.delete(ip);
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
	const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
	const endpointLimit = ENDPOINT_LIMITS.get(requestPath);
	const tier = endpointLimit?.[0];
	const maxRequests = endpointLimit
		? readPositiveInteger(`RATE_LIMIT_TIER_${tier.toUpperCase()}_MAX`, endpointLimit[1])
		: readPositiveInteger('RATE_LIMIT_MAX', DEFAULT_MAX_REQUESTS);
	const windowMs = endpointLimit
		? ENDPOINT_WINDOW_MS
		: readPositiveInteger('RATE_LIMIT_WINDOW_MS', DEFAULT_WINDOW_MS);
	const bucketKey = endpointLimit ? `endpoint:${requestPath}:${ip}` : ip;
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

module.exports = rateLimiter;
