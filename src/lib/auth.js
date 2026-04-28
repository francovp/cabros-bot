const crypto = require('crypto');

/**
 * Middleware to validate API key for webhook endpoints.
 * Requires `x-api-key` header to match `WEBHOOK_API_KEY` environment variable.
 */
function validateApiKey(req, res, next) {
	const validApiKey = process.env.WEBHOOK_API_KEY;

	if (!validApiKey) {
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

	// Use timingSafeEqual to prevent timing attacks
	// Both buffers must be of the same length
	const bufferApiKey = Buffer.from(keyToCheck);
	const bufferValidApiKey = Buffer.from(validApiKey);

	if (bufferApiKey.length !== bufferValidApiKey.length) {
		return res.status(403).json({ error: 'Forbidden: Invalid API key' });
	}

	if (!crypto.timingSafeEqual(bufferApiKey, bufferValidApiKey)) {
		return res.status(403).json({ error: 'Forbidden: Invalid API key' });
	}

	next();
}

module.exports = { validateApiKey };
