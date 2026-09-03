'use strict';

const VALID_CHANNELS = ['telegram', 'whatsapp', 'discord'];

// Strict format patterns for chat IDs. These run only when strictChatIds is
// explicitly enabled so existing operators with ad-hoc strings can opt out.
const TELEGRAM_CHAT_ID_NUMERIC_PATTERN = /^-?\d{5,20}$/;
const WHATSAPP_CHAT_ID_PATTERN = /^\d{6,20}@(?:c|g)\.us$/;
// Characters that may break Telegram MarkdownV2 parsing or carry injection risk.
const CHAT_ID_FORBIDDEN_CHARS = /[\s<>[\]{}()~`|#^=+]|!/;

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

function validateTelegramChatId(value) {
	if (!TELEGRAM_CHAT_ID_NUMERIC_PATTERN.test(value)) {
		throw new NotificationRoutingValidationError(
			'"telegramChatId" must be a numeric chat ID (5-20 digits, optional "-" prefix)',
			{ field: 'telegramChatId' },
		);
	}
}

function validateWhatsAppChatId(value) {
	if (!WHATSAPP_CHAT_ID_PATTERN.test(value)) {
		throw new NotificationRoutingValidationError(
			'"whatsappChatId" must be a GreenAPI chat ID in the format <digits>@<c.us|g.us>',
			{ field: 'whatsappChatId' },
		);
	}
}

function validateStrictChatOverride(field, value) {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'string' || value.length === 0) {
		throw new NotificationRoutingValidationError(`"${field}" must be a non-empty string if provided`, {
			field,
		});
	}

	if (CHAT_ID_FORBIDDEN_CHARS.test(value)) {
		throw new NotificationRoutingValidationError(
			`"${field}" contains disallowed characters (whitespace or MarkdownV2 escape-trigger characters)`,
			{ field },
		);
	}

	if (field === 'telegramChatId') {
		validateTelegramChatId(value);
	} else if (field === 'whatsappChatId') {
		validateWhatsAppChatId(value);
	}

	return value;
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

function parseNotificationRouting(raw = {}, options = {}) {
	const {
		requiredChannels = false,
		allowQueryChannels = false,
	} = options;

	// strictChatIds defaults to false (no behavior change) unless the operator
	// explicitly opts in via ENABLE_STRICT_CHAT_ID_VALIDATION=true. Callers can
	// still override the env-derived default with an explicit boolean.
	let strictChatIds;
	if (options.strictChatIds !== undefined) {
		strictChatIds = options.strictChatIds;
	} else if (typeof process !== 'undefined' && process.env && process.env.ENABLE_STRICT_CHAT_ID_VALIDATION !== undefined) {
		strictChatIds = process.env.ENABLE_STRICT_CHAT_ID_VALIDATION === 'true';
	} else {
		strictChatIds = false;
	}

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
		};
	}

	const rawThreadId = raw.telegramThreadId !== undefined
		? raw.telegramThreadId
		: raw.messageThreadId !== undefined
			? raw.messageThreadId
			: raw.telegram_thread_id !== undefined
				? raw.telegram_thread_id
				: raw.message_thread_id;

	const telegramChatId = strictChatIds
		? validateStrictChatOverride('telegramChatId', raw.telegramChatId)
		: validateChatOverride('telegramChatId', raw.telegramChatId);
	const whatsappChatId = strictChatIds
		? validateStrictChatOverride('whatsappChatId', raw.whatsappChatId)
		: validateChatOverride('whatsappChatId', raw.whatsappChatId);

	return {
		channels: normalizeChannels(raw.channels, {
			required: requiredChannels,
			allowCsvString: allowQueryChannels,
		}),
		telegramChatId,
		telegramThreadId: validateThreadIdOverride('telegramThreadId', rawThreadId),
		whatsappChatId,
		discordWebhookUrl: validateDiscordWebhookOverride('discordWebhookUrl', raw.discordWebhookUrl),
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
