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
	const routing = parseNotificationRouting(body);

	const originalLength = message.length;
	const truncated = originalLength > MAX_MESSAGE_LENGTH;
	const text = truncated
		? message.substring(0, MAX_MESSAGE_LENGTH) + '...'
		: message;
	const deliveredLength = text.length;

	if (truncated) {
		console.warn(
			`[MessageWebhook] Message truncated: originalLength=${originalLength}, deliveredLength=${deliveredLength}, max=${MAX_MESSAGE_LENGTH}`,
		);
	}

	return { text, truncated, originalLength, deliveredLength, ...routing };
}

function postMessage(botOrGetter) {
	return async (req, res) => {
		try {
			const routing = validateMessageRequest(req.body);
			const alert = {
				text: routing.text,
				source: 'generic-message',
				telegramChatId: routing.telegramChatId,
				telegramThreadId: routing.telegramThreadId,
				whatsappChatId: routing.whatsappChatId,
				discordWebhookUrl: routing.discordWebhookUrl,
			};

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

			const httpContext = {
				endpoint: '/api/webhook/message',
				method: 'POST',
			};

			const results = await sendWithNotificationRouting(
				notificationManager,
				alert,
				routing,
				{ http: httpContext },
			);

			const responseBody = { success: true, results };
			if (routing.truncated) {
				responseBody.truncated = true;
				responseBody.originalLength = routing.originalLength;
				responseBody.deliveredLength = routing.deliveredLength;
			}

			res.json(responseBody);
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return res.status(error.statusCode).json({
					success: false,
					error: error.message,
					details: error.details,
				});
			}

			console.error('[MessageWebhook] Request failed:', error.message);
			const requestedChannels = req.body && Array.isArray(req.body.channels) ? req.body.channels : [];
			const channel = requestedChannels.length === 1 ? requestedChannels[0] : 'http-message';

			sentryService.captureRuntimeError({
				channel,
				error,
				http: {
					endpoint: '/api/webhook/message',
					method: 'POST',
					statusCode: 500,
				},
				extra: {
					category: 'http_webhook_error',
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
