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
	getDeliveredChannels,
	getRequestedChannels,
	assertChannelsAvailable,
} = require('../../../../services/notification/requestRouting');
const { estimateMessageChunks } = require('../../../../lib/messageHelper');
const { isRecognisedDryRunValue, resolveDryRun } = require('../../../../lib/dryRunRequest');
const { STANDARD_ERROR_CODES, sendError } = require('../../../../lib/errorEnvelope');
const alertStorageService = require('../../../../services/storage/AlertStorageService');
const MAX_MESSAGE_LENGTH = 4000;

function assertRecognisedDryRunFlag(value, source) {
	if (value === undefined) {
		return;
	}
	if (!isRecognisedDryRunValue(value)) {
		throw new NotificationRoutingValidationError(
			`"dryRun" ${source} must be a boolean if provided`,
			{ field: 'dryRun' },
		);
	}
}

function validateMessageRequest(body, query) {
	if (!body || typeof body !== 'object') {
		throw new NotificationRoutingValidationError('Request body must be a JSON object');
	}

	const { message, dryValidate, dryRun } = body;

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

	// An unrecognised dryRun value must fail loudly in BOTH locations: silently
	// treating it as a live request would deliver the message a caller intended
	// as a probe. The query form carries the same risk as the body form, so it
	// gets the same guard.
	assertRecognisedDryRunFlag(dryRun, 'body');
	assertRecognisedDryRunFlag(query && query.dryRun, 'query');

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

	return {
		text,
		truncated,
		originalLength,
		deliveredLength,
		originalMessage: message,
		dryValidate: dryValidate === true,
		...routing,
	};
}

function buildDryRunRoutingPreview(routing) {
	return {
		...(routing.channels ? { channels: routing.channels } : {}),
		...(routing.telegramChatId !== undefined ? { telegramChatId: routing.telegramChatId } : {}),
		...(routing.telegramThreadId !== undefined ? { telegramThreadId: routing.telegramThreadId } : {}),
		...(routing.whatsappChatId !== undefined ? { whatsappChatId: routing.whatsappChatId } : {}),
		// The Discord webhook URL is itself the credential, so the preview reports
		// only that one was supplied. Same reasoning as the persistence path below.
		...(routing.discordWebhookUrl !== undefined ? { discordWebhookUrlProvided: true } : {}),
	};
}

function buildDryRunResponse(routing, notificationManager, requestId) {
	const responseBody = {
		success: true,
		dryRun: true,
		estimatedChunks: estimateMessageChunks(routing.originalMessage),
		requestedChannels: getRequestedChannels(notificationManager, routing, routing.text),
		deliveredChannels: [],
		payload: { text: routing.text },
		routing: buildDryRunRoutingPreview(routing),
		requestId,
	};

	// Without a channel subset the request fans out to every enabled channel, so
	// an empty requestedChannels list must not read as "nothing would be sent".
	if (!routing.channels) {
		responseBody.broadcast = true;
	}

	if (routing.truncated) {
		responseBody.truncated = true;
		responseBody.originalLength = routing.originalLength;
		responseBody.deliveredLength = routing.deliveredLength;
	}

	return responseBody;
}

function postMessage(botOrGetter) {
	return async (req, res) => {
		const requestId = resolveRequestId(req);
		const startTime = Date.now();
		try {
			const routing = validateMessageRequest(req.body, req.query);

			if (routing.dryValidate) {
				const estimatedChunks = estimateMessageChunks(routing.originalMessage);
				return res.json({
					success: true,
					dryValidate: true,
					estimatedChunks,
				});
			}

			if (resolveDryRun(req)) {
				console.debug('[MessageWebhook] Dry-run mode: skipping delivery, idempotency and Firestore persistence');
				// A preview must not initialize the channel services (that validates
				// them against their providers), so availability is only asserted when
				// the channel registry already exists on this process.
				const notificationManager = getNotificationManager();
				if (notificationManager) {
					assertChannelsAvailable(notificationManager, routing);
				}
				return res.json(buildDryRunResponse(routing, notificationManager, requestId));
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

			const estimatedChunks = estimateMessageChunks(routing.originalMessage);
			const hasExceededChunks = Object.values(estimatedChunks).some((count) => count > 1);

			const responseBody = { success: true, results, requestId };
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

				responseBody.delivered = getDeliveredChannels(results);
				responseBody.channelDetails = channelDetails;
				responseBody.estimatedChunks = estimatedChunks;
			}

			if (routing.truncated) {
				responseBody.truncated = true;
				responseBody.originalLength = routing.originalLength;
				responseBody.deliveredLength = routing.deliveredLength;
			}

			res.json(responseBody);

			// Fire-and-forget: persist after responding so storage never blocks delivery.
			// Do not persist raw discordWebhookUrl to avoid storing sensitive webhook credentials.
			alertStorageService.saveAlert({
				text: alert.text,
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				deliveryResults: results,
				channels: routing.channels || results.map((result) => result.channel).filter(Boolean),
				source: 'webhook-message',
				processingTimeMs: Math.max(0, Date.now() - startTime),
				telegramChatId: routing.telegramChatId,
				telegramThreadId: routing.telegramThreadId,
				whatsappChatId: routing.whatsappChatId,
			}).catch(() => {});
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return sendError(res, error.statusCode, {
					error: error.message,
					code: STANDARD_ERROR_CODES.INVALID_REQUEST,
					requestId,
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
