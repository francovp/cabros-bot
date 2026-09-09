'use strict';

const VALID_CHANNELS = ['telegram', 'whatsapp', 'discord'];

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

function validateThreadIdOverride(field, value) {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new NotificationRoutingValidationError(`"${field}" must be a non-negative integer if provided`, {
				field,
			});
		}
		return value;
	}

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!/^\d+$/.test(trimmed)) {
			throw new NotificationRoutingValidationError(`"${field}" must be a non-negative integer if provided`, {
				field,
			});
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (!Number.isSafeInteger(parsed) || parsed < 0) {
			throw new NotificationRoutingValidationError(`"${field}" must be a non-negative integer if provided`, {
				field,
			});
		}
		return parsed;
	}

	throw new NotificationRoutingValidationError(`"${field}" must be a non-negative integer if provided`, {
		field,
	});
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

function validateDiscordWebhookOverride(field, value) {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'string' || value.length === 0) {
		throw new NotificationRoutingValidationError(`"${field}" must be a non-empty string if provided`, {
			field,
		});
	}

	let parsedUrl;
	try {
		parsedUrl = new URL(value);
	} catch (_) {
		throw new NotificationRoutingValidationError(`"${field}" must be a valid HTTPS Discord webhook URL`, {
			field,
		});
	}

	if (parsedUrl.protocol !== 'https:') {
		throw new NotificationRoutingValidationError(`"${field}" must be a valid HTTPS Discord webhook URL`, {
			field,
		});
	}

	const hostname = parsedUrl.hostname.toLowerCase();
	const isValidDiscordHost =
		hostname === 'discord.com' ||
		hostname.endsWith('.discord.com') ||
		hostname === 'discordapp.com' ||
		hostname.endsWith('.discordapp.com');

	const DISCORD_WEBHOOK_PATH_PATTERN = /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+(?:\/.*)?$/;

	if (!isValidDiscordHost || !DISCORD_WEBHOOK_PATH_PATTERN.test(parsedUrl.pathname)) {
		throw new NotificationRoutingValidationError(`"${field}" must be a valid HTTPS Discord webhook URL`, {
			field,
		});
	}

	return value;
}

function validateIdempotencyKeyOverride(value) {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value !== 'string') {
		throw new NotificationRoutingValidationError('"idempotencyKey" must be a non-empty string if provided', {
			field: 'idempotencyKey',
		});
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	// Reasonable upper bound to keep dedupe keys bounded and log-friendly.
	if (trimmed.length > 256) {
		throw new NotificationRoutingValidationError('"idempotencyKey" must be at most 256 characters', {
			field: 'idempotencyKey',
		});
	}

	return trimmed;
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
			telegramThreadId: undefined,
			whatsappChatId: undefined,
			discordWebhookUrl: undefined,
			idempotencyKey: undefined,
		};
	}

	const rawThreadId = raw.telegramThreadId !== undefined
		? raw.telegramThreadId
		: raw.messageThreadId !== undefined
			? raw.messageThreadId
			: raw.telegram_thread_id !== undefined
				? raw.telegram_thread_id
				: raw.message_thread_id;

	return {
		channels: normalizeChannels(raw.channels, {
			required: requiredChannels,
			allowCsvString: allowQueryChannels,
		}),
		telegramChatId: validateChatOverride('telegramChatId', raw.telegramChatId),
		telegramThreadId: validateThreadIdOverride('telegramThreadId', rawThreadId),
		whatsappChatId: validateChatOverride('whatsappChatId', raw.whatsappChatId),
		discordWebhookUrl: validateDiscordWebhookOverride('discordWebhookUrl', raw.discordWebhookUrl),
		idempotencyKey: validateIdempotencyKeyOverride(raw.idempotencyKey),
	};
}

async function sendWithNotificationRouting(notificationManager, alert, routing = {}, options = {}) {
	const alertPayload = {
		...alert,
		telegramChatId: routing.telegramChatId,
		telegramThreadId: routing.telegramThreadId,
		whatsappChatId: routing.whatsappChatId,
		discordWebhookUrl: routing.discordWebhookUrl,
	};

	if (routing.idempotencyKey) {
		alertPayload.idempotencyKey = routing.idempotencyKey;
	}

	if (routing.channels) {
		validateNotificationRouting(notificationManager, routing);
		return notificationManager.sendToChannels(alertPayload, routing.channels, options);
	}

	return notificationManager.sendToAll(alertPayload, options);
}

function validateNotificationRouting(notificationManager, routing = {}) {
	if (!routing.channels) {
		return;
	}

	const enabledChannels = getRequestedChannels(notificationManager);
	const unavailableChannels = routing.channels.filter((channel) => !enabledChannels.includes(channel));
	if (unavailableChannels.length > 0) {
		throw new NotificationRoutingValidationError(
			`Requested channel(s) disabled or misconfigured: ${unavailableChannels.join(', ')}`,
			{ field: 'channels', unavailableChannels },
		);
	}
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
	validateNotificationRouting,
	sendWithNotificationRouting,
	getRequestedChannels,
	getDeliveredChannels,
};
