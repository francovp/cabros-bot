require('dotenv').config();
const sentryService = require('../../../../services/monitoring/SentryService');
const { getNotificationManager, initializeNotificationServices } = require('../alert/alert');
const {
	VALID_CHANNELS,
	NotificationRoutingValidationError,
	parseNotificationRouting,
	sendWithNotificationRouting,
} = require('../../../../services/notification/requestRouting');

const DEFAULT_MAX_MESSAGE_LENGTH = 4000;
const MIN_MAX_MESSAGE_LENGTH = 1;
const MAX_MAX_MESSAGE_LENGTH = 20000;

function resolveMaxMessageLength() {
	const raw = process.env.GENERIC_MESSAGE_MAX_LENGTH;
	if (raw === undefined || raw === null || raw === '') {
		return DEFAULT_MAX_MESSAGE_LENGTH;
	}
	const trimmed = String(raw).trim();
	if (!/^\d+$/.test(trimmed)) {
		return DEFAULT_MAX_MESSAGE_LENGTH;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed) || parsed < MIN_MAX_MESSAGE_LENGTH || parsed > MAX_MAX_MESSAGE_LENGTH) {
		return DEFAULT_MAX_MESSAGE_LENGTH;
	}
	return parsed;
}

function getMaxMessageLength() {
	return resolveMaxMessageLength();
}

function buildTruncatedText(message, maxLength) {
	return message.substring(0, maxLength) + '...';
}

function validateMessageRequest(body, options = {}) {
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

	const maxLength = typeof options.maxMessageLength === 'number'
		&& Number.isSafeInteger(options.maxMessageLength)
		&& options.maxMessageLength >= MIN_MAX_MESSAGE_LENGTH
		&& options.maxMessageLength <= MAX_MAX_MESSAGE_LENGTH
		? options.maxMessageLength
		: getMaxMessageLength();

	const originalLength = message.length;
	const truncated = originalLength > maxLength;
	const text = truncated ? buildTruncatedText(message, maxLength) : message;
	const messageLength = text.length;

	return {
		text,
		originalLength,
		messageLength,
		truncated,
		maxMessageLength: maxLength,
		...routing,
	};
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

			if (routing.truncated) {
				console.warn('[MessageWebhook] truncated message', {
					originalLength: routing.originalLength,
					messageLength: routing.messageLength,
					maxMessageLength: routing.maxMessageLength,
				});
			}

			res.json({
				success: true,
				results,
				truncated: routing.truncated,
				messageLength: routing.messageLength,
				originalLength: routing.originalLength,
				maxMessageLength: routing.maxMessageLength,
			});
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
	DEFAULT_MAX_MESSAGE_LENGTH,
	MIN_MAX_MESSAGE_LENGTH,
	MAX_MAX_MESSAGE_LENGTH,
	getMaxMessageLength,
	buildTruncatedText,
	validateMessageRequest,
};
