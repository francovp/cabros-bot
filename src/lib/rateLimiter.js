const rateLimit = require('express-rate-limit');

const windowMs = process.env.RATE_LIMIT_WINDOW_MS ? parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) : 15 * 60 * 1000; // 15 minutes by default
const max = process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 100; // Limit each IP to 100 requests per windowMs

const limiter = rateLimit({
	windowMs,
	max,
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
	message: 'Too many requests from this IP, please try again later.',
	skip: (req) => {
		// Skip rate limiting for healthcheck endpoint
		return req.path === '/healthcheck';
	},
});

module.exports = limiter;
