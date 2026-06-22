'use strict';

const VALID_CHANNELS = ['telegram', 'whatsapp'];

class NotificationRoutingValidationError extends Error {
	constructor(message, details = null) {
		super(message);
		this.name = 'NotificationRoutingValidationError';
		this.details = details;
		this.statusCode = 400;
	}
}

function normalizeChannels(rawChannels, options = {}) {
	const {
		required = false,
		allowCsvString = false,
	} = options;

	if (rawChannels === undefined) {
		if (required) {
			throw new NotificationRoutingValidationError('"channels" is required and must be a non-empty array', {
				field: 'channels',
			});
		}
		return undefined;
	}

	let channels = rawChannels;
	if (allowCsvString && typeof rawChannels === 'string') {
		channels = rawChannels
			.split(',')
			.map((channel) => channel.trim())
			.filter(Boolean);
	}

	if (!Array.isArray(channels) || channels.length === 0) {
		throw new NotificationRoutingValidationError('"channels" must be a non-empty array', {
			field: 'channels',
		});
	}

	const uniqueChannels = Array.from(new Set(channels));
	const unknownChannels = uniqueChannels.filter((channel) => !VALID_CHANNELS.includes(channel));
	if (unknownChannels.length > 0) {
		throw new NotificationRoutingValidationError(
			`Unknown channel(s): ${unknownChannels.join(', ')}. Valid channels: ${VALID_CHANNELS.join(', ')}`,
			{ field: 'channels', unknownChannels },
		);
	}

	return uniqueChannels;
}

function validateChatOverride(field, value) {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'string' || value.length === 0) {
		throw new NotificationRoutingValidationError(`"${field}" must be a non-empty string if provided`, {
			field,
		});
	}

	return value;
}

function parseNotificationRouting(raw = {}, options = {}) {
	const {
		requiredChannels = false,
		allowQueryChannels = false,
	} = options;

	if (!raw || typeof raw !== 'object') {
		if (requiredChannels) {
			throw new NotificationRoutingValidationError('Request body must be a JSON object');
		}
		return {
			channels: undefined,
			telegramChatId: undefined,
			whatsappChatId: undefined,
		};
	}

	return {
		channels: normalizeChannels(raw.channels, {
			required: requiredChannels,
			allowCsvString: allowQueryChannels,
		}),
		telegramChatId: validateChatOverride('telegramChatId', raw.telegramChatId),
		whatsappChatId: validateChatOverride('whatsappChatId', raw.whatsappChatId),
	};
}

async function sendWithNotificationRouting(notificationManager, alert, routing = {}, options = {}) {
	const alertPayload = {
		...alert,
		telegramChatId: routing.telegramChatId,
		whatsappChatId: routing.whatsappChatId,
	};

	if (routing.channels) {
		return notificationManager.sendToChannels(alertPayload, routing.channels, options);
	}

	return notificationManager.sendToAll(alertPayload, options);
}

function getRequestedChannels(notificationManager, routing = {}) {
	if (routing.channels) {
		return routing.channels;
	}

	if (!notificationManager || typeof notificationManager.getEnabledChannels !== 'function') {
		return [];
	}

	return notificationManager.getEnabledChannels();
}

function getDeliveredChannels(results = []) {
	return results
		.filter((result) => result && result.success)
		.map((result) => result.channel);
}

module.exports = {
	VALID_CHANNELS,
	NotificationRoutingValidationError,
	parseNotificationRouting,
	sendWithNotificationRouting,
	getRequestedChannels,
	getDeliveredChannels,
};
