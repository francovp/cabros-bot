// src/lib/rateLimiter.js

const rateLimit = new Map();
// Store: IP -> { count, resetTime }

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10);
// Default 15m
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
// Default 100 requests
const MAX_KEYS = 10000;
// Protection against memory exhaustion

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
	const ip = req.ip;
	const now = Date.now();

	let data = rateLimit.get(ip);

	if (!data) {
		// Protection against memory exhaustion
		if (rateLimit.size >= MAX_KEYS) {
			// Optional: Remove oldest or just reject new IPs?
			// For simplicity and safety against DoS targeting memory, we can clear the whole cache or just reject.
			// Let's clear the oldest (which is hard with Map iteration order being insertion order, so the first one is the oldest).
			const firstKey = rateLimit.keys().next().value;
			rateLimit.delete(firstKey);
		}

		data = {
			count: 1,
			resetTime: now + RATE_LIMIT_WINDOW_MS,
		};
		rateLimit.set(ip, data);
	} else if (now > data.resetTime) {
		// Window expired, reset
		data.count = 1;
		data.resetTime = now + RATE_LIMIT_WINDOW_MS;
	} else {
		data.count++;
	}

	if (data.count > RATE_LIMIT_MAX) {
		return res.status(429).json({
			error: 'Too many requests, please try again later.',
		});
	}

	next();
}

module.exports = rateLimiter;
