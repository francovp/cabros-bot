/**
 * Authentication Middleware
 * Validates API key for webhook endpoints
 */
const crypto = require('crypto');

const validateApiKey = (req, res, next) => {
	const apiKey = req.headers['x-api-key'];
	const configuredKey = process.env.WEBHOOK_API_KEY;

	if (!configuredKey) {
		console.error('WEBHOOK_API_KEY is not configured in environment variables. Rejecting all requests.');
		return res.status(500).json({ error: 'Server configuration error: Authentication not configured' });
	}

	if (!apiKey) {
		return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
	}

	// Use timingSafeEqual to prevent timing attacks
	try {
		const apiKeyBuf = Buffer.from(apiKey);
		const configuredKeyBuf = Buffer.from(configuredKey);

		if (apiKeyBuf.length !== configuredKeyBuf.length || !crypto.timingSafeEqual(apiKeyBuf, configuredKeyBuf)) {
			return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
		}
	} catch (error) {
		// Handle potential encoding errors or other issues
		return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
	}

	next();
};

module.exports = { validateApiKey };
