require('dotenv').config();
const sentryService = require('../../../../services/monitoring/SentryService');
const {
	getNotificationManager,
	initializeNotificationServices,
	resolveRequestId,
} = require('../alert/alert');
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

	const text = message.length > MAX_MESSAGE_LENGTH
		? message.substring(0, MAX_MESSAGE_LENGTH) + '...'
		: message;

	return { text, ...routing };
}

function postMessage(botOrGetter) {
	return async (req, res) => {
		const requestId = resolveRequestId(req);
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
						requestId,
					});
				}
			}

			const httpContext = {
				endpoint: '/api/webhook/message',
				method: 'POST',
				requestId,
			};

			const results = await sendWithNotificationRouting(
				notificationManager,
				alert,
				routing,
				{ http: httpContext },
			);

			res.json({ success: true, results, requestId });
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return res.status(error.statusCode).json({
					success: false,
					error: error.message,
					details: error.details,
					requestId,
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
					requestId,
				},
				extra: {
					category: 'http_webhook_error',
				},
			});

			res.status(500).json({
				success: false,
				error: 'Internal server error',
				requestId,
			});
		}
	};
}

module.exports = {
	postMessage,
	MessageValidationError: NotificationRoutingValidationError,
	VALID_CHANNELS,
	MAX_MESSAGE_LENGTH,
	resolveRequestId,
};
