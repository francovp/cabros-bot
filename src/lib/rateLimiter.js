/**
 * Simple in-memory rate limiter with MAX_KEYS protection
 */
const maxKeys = 10000; // Prevent memory exhaustion

const ipHits = new Map(); // ip -> { count, windowStart }

function rateLimiter(req, res, next) {
    const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 minutes
    const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX) || 100; // limit each IP to 100 requests per windowMs

    // Exempt healthcheck
    if (req.path === '/healthcheck') {
        return next();
    }

    const ip = req.ip;
    const now = Date.now();

    let record = ipHits.get(ip);

    if (!record) {
        if (ipHits.size >= maxKeys) {
            console.warn('Rate limiter Max Keys reached. Clearing cache.');
            ipHits.clear();
        }
        record = { count: 0, windowStart: now };
        ipHits.set(ip, record);
    }

    if (now - record.windowStart > rateLimitWindowMs) {
        record.windowStart = now;
        record.count = 0;
    }

    record.count++;

    if (record.count > rateLimitMax) {
        return res.status(429).json({
            error: 'Too many requests, please try again later.'
        });
    }

    next();
}

// Expose reset for testing
rateLimiter.reset = () => {
    ipHits.clear();
};

module.exports = rateLimiter;
