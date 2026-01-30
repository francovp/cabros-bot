const crypto = require('crypto');

/**
 * Middleware to validate API key for webhook endpoints
 * Validates 'x-api-key' header against WEBHOOK_API_KEY env var
 */
function validateApiKey(req, res, next) {
	const apiKey = req.headers['x-api-key'];
	const validApiKey = process.env.WEBHOOK_API_KEY;

	// Fail closed if server is misconfigured
	if (!validApiKey) {
		console.error('CRITICAL: WEBHOOK_API_KEY not set in environment');
		return res.status(500).json({ error: 'Server configuration error' });
	}

	if (!apiKey) {
		return res.status(401).json({ error: 'Missing x-api-key header' });
	}

	try {
		const inputBuffer = Buffer.from(apiKey);
		const validBuffer = Buffer.from(validApiKey);

		// Timing safe comparison requires equal length buffers
		if (inputBuffer.length !== validBuffer.length) {
			return res.status(403).json({ error: 'Invalid API key' });
		}

		if (crypto.timingSafeEqual(inputBuffer, validBuffer)) {
			return next();
		}
	} catch (error) {
		console.error('Error validating API key:', error);
	}

	return res.status(403).json({ error: 'Invalid API key' });
}

module.exports = { validateApiKey };
