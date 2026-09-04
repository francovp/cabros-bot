require('dotenv').config();
const sentryService = require('../../../../services/monitoring/SentryService');
const { getNotificationManager, initializeNotificationServices } = require('../alert/alert');
const {
	VALID_CHANNELS,
	NotificationRoutingValidationError,
	parseNotificationRouting,
	sendWithNotificationRouting,
	getDeliveredChannels,
} = require('../../../../services/notification/requestRouting');
const { estimateMessageChunks } = require('../../../../lib/messageHelper');
const MAX_MESSAGE_LENGTH = 4000;

function validateMessageRequest(body) {
	if (!body || typeof body !== 'object') {
		throw new NotificationRoutingValidationError('Request body must be a JSON object');
	}

	const { message, dryValidate } = body;

	if (!message || typeof message !== 'string') {
		throw new NotificationRoutingValidationError('"message" is required and must be a non-empty string', {
			field: 'message',
		});
	}

	if (dryValidate !== undefined && typeof dryValidate !== 'boolean') {
		throw new NotificationRoutingValidationError('"dryValidate" must be a boolean if provided', {
			field: 'dryValidate',
		});
	}

	const routing = parseNotificationRouting(body);

	const text = message.length > MAX_MESSAGE_LENGTH
		? message.substring(0, MAX_MESSAGE_LENGTH) + '...'
		: message;

	return {
		text,
		originalMessage: message,
		dryValidate: dryValidate === true,
		...routing,
	};
}

function postMessage(botOrGetter) {
	return async (req, res) => {
		try {
			const routing = validateMessageRequest(req.body);

			if (routing.dryValidate) {
				const estimatedChunks = estimateMessageChunks(routing.originalMessage);
				return res.json({
					success: true,
					dryValidate: true,
					estimatedChunks,
				});
			}

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

			const estimatedChunks = estimateMessageChunks(routing.originalMessage);
			const hasExceededChunks = Object.values(estimatedChunks).some((count) => count > 1);

			if (hasExceededChunks) {
				const channelDetails = {};
				for (const r of results) {
					if (r && r.channel) {
						const details = {
							success: Boolean(r.success),
						};
						if (r.messageId) {
							details.messageId = r.messageId;
						}
						if (r.error) {
							details.error = r.error;
						}
						const chunks = r.splitMessageCount || r.messageCount;
						if (typeof chunks === 'number' && chunks > 1) {
							details.chunks = chunks;
						}
						channelDetails[r.channel] = details;
					}
				}

				return res.json({
					success: true,
					results,
					delivered: getDeliveredChannels(results),
					channelDetails,
					estimatedChunks,
				});
			}

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
