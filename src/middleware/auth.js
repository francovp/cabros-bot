/**
 * Authentication Middleware
 * Validates API keys for webhook endpoints
 */

/**
 * Validate API Key middleware
 * Expects 'x-api-key' header to match WEBHOOK_API_KEY env variable
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next function
 */
function validateApiKey(req, res, next) {
	const apiKey = process.env.WEBHOOK_API_KEY;
	const requestApiKey = req.headers['x-api-key'];

	if (!apiKey) {
		console.error('WEBHOOK_API_KEY is not defined in environment variables');
		return res.status(500).json({
			error: 'Server configuration error',
			message: 'Authentication not configured',
		});
	}

	if (!requestApiKey || requestApiKey !== apiKey) {
		console.warn(`Unauthorized access attempt to ${req.originalUrl} from ${req.ip}`);
		return res.status(401).json({
			error: 'Unauthorized',
			message: 'Invalid or missing API key',
		});
	}

	next();
}

module.exports = { validateApiKey };
