require('dotenv').config();
const sentryService = require('../../../../services/monitoring/SentryService');
const { getNotificationManager, initializeNotificationServices } = require('../alert/alert');
const {
	VALID_CHANNELS,
	NotificationRoutingValidationError,
	parseNotificationRouting,
	sendWithNotificationRouting,
} = require('../../../../services/notification/requestRouting');
const MAX_MESSAGE_LENGTH = 4000;

function validateMessageRequest(body) {
	if (!body || typeof body !== 'object') {
		throw new NotificationRoutingValidationError('Request body must be a JSON object');
	}

	const { message } = body;

	if (!message || typeof message !== 'string') {
		throw new NotificationRoutingValidationError('"message" is required and must be a non-empty string', {
			field: 'message',
		});
	}
	const routing = parseNotificationRouting(body, { requiredChannels: true });

	const text = message.length > MAX_MESSAGE_LENGTH
		? message.substring(0, MAX_MESSAGE_LENGTH) + '...'
		: message;

	return { text, ...routing };
}

function postMessage(botOrGetter) {
	return async (req, res) => {
		try {
			const { text, channels, telegramChatId, whatsappChatId } = validateMessageRequest(req.body);
			const alert = { text, telegramChatId, whatsappChatId };

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

			const results = await sendWithNotificationRouting(notificationManager, alert, { channels, telegramChatId, whatsappChatId });

			res.json({ success: true, results });
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
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
	MessageValidationError: NotificationRoutingValidationError,
	VALID_CHANNELS,
	MAX_MESSAGE_LENGTH,
};
