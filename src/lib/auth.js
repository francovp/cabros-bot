const crypto = require('crypto');

/**
 * Middleware to validate API key using constant-time comparison
 * Expects 'x-api-key' header
 */
function validateApiKey(req, res, next) {
	const apiKey = req.headers['x-api-key'];
	const validApiKey = process.env.WEBHOOK_API_KEY;

	if (!validApiKey) {
		console.error('WEBHOOK_API_KEY is not set in environment variables');
		return res.status(500).json({ error: 'Server configuration error' });
	}

	if (!apiKey) {
		return res.status(403).json({ error: 'Missing API key' });
	}

	// Constant-time comparison to prevent timing attacks
	const bufferApiKey = Buffer.from(apiKey);
	const bufferValidApiKey = Buffer.from(validApiKey);

	// crypto.timingSafeEqual throws if lengths are different
	if (bufferApiKey.length !== bufferValidApiKey.length) {
		return res.status(403).json({ error: 'Invalid API key' });
	}

	if (!crypto.timingSafeEqual(bufferApiKey, bufferValidApiKey)) {
		return res.status(403).json({ error: 'Invalid API key' });
	}

	next();
}

module.exports = { validateApiKey };
