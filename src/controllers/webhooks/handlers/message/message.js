require('dotenv').config();
const sentryService = require('../../../../services/monitoring/SentryService');
const { getNotificationManager, initializeNotificationServices } = require('../alert/alert');

const VALID_CHANNELS = ['telegram', 'whatsapp'];
const MAX_MESSAGE_LENGTH = 4000;

class MessageValidationError extends Error {
	constructor(message, details = null) {
		super(message);
		this.name = 'MessageValidationError';
		this.details = details;
		this.statusCode = 400;
	}
}

function validateMessageRequest(body) {
	if (!body || typeof body !== 'object') {
		throw new MessageValidationError('Request body must be a JSON object');
	}

	const { message, channels } = body;

	if (!message || typeof message !== 'string') {
		throw new MessageValidationError('"message" is required and must be a non-empty string', {
			field: 'message',
		});
	}

	if (!channels || !Array.isArray(channels) || channels.length === 0) {
		throw new MessageValidationError('"channels" is required and must be a non-empty array', {
			field: 'channels',
		});
	}

	const unknownChannels = channels.filter(ch => !VALID_CHANNELS.includes(ch));
	if (unknownChannels.length > 0) {
		throw new MessageValidationError(
			`Unknown channel(s): ${unknownChannels.join(', ')}. Valid channels: ${VALID_CHANNELS.join(', ')}`,
			{ field: 'channels', unknownChannels },
		);
	}

	const text = message.length > MAX_MESSAGE_LENGTH
		? message.substring(0, MAX_MESSAGE_LENGTH) + '...'
		: message;

	return { text, channels };
}

function postMessage(botOrGetter) {
	return async (req, res) => {
		try {
			const { text, channels } = validateMessageRequest(req.body);
			const alert = { text };

			let notificationManager = getNotificationManager();
			if (!notificationManager) {
				console.warn('[MessageWebhook] NotificationManager not initialized, initializing...');

				const bot = typeof botOrGetter === 'function' ? botOrGetter() : (botOrGetter || null);
				if (bot) {
					await initializeNotificationServices(bot);
					notificationManager = getNotificationManager();
				}

				if (!notificationManager) {
					return res.status(503).json({
						success: false,
						error: 'Notification services not initialized',
					});
				}
			}

			const results = await notificationManager.sendToChannels(alert, channels);

			res.json({ success: true, results });
		} catch (error) {
			if (error instanceof MessageValidationError) {
				return res.status(error.statusCode).json({
					success: false,
					error: error.message,
					details: error.details,
				});
			}

			console.error('[MessageWebhook] Request failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'http-message',
				error,
				http: {
					endpoint: '/api/webhook/message',
					method: 'POST',
					statusCode: 500,
				},
			});

			res.status(500).json({
				success: false,
				error: 'Internal server error',
			});
		}
	};
}

module.exports = {
	postMessage,
	MessageValidationError,
	VALID_CHANNELS,
	MAX_MESSAGE_LENGTH,
};
