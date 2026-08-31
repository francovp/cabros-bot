'use strict';

const VALID_CHANNELS = ['telegram', 'whatsapp', 'discord'];
const SYMBOL_STOP_WORDS = new Set(['AND', 'THE', 'THIS', 'ONLY', 'SEND', 'ALERT', 'UPDATE', 'WITH', 'FROM', 'TO', 'BUY', 'SELL', 'VENTA', 'COMPRA']);

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

function normalizeSymbolRouteKey(rawKey) {
	if (typeof rawKey !== 'string') {
		throw new NotificationRoutingValidationError('"symbolRoutes" keys must be non-empty symbol strings', {
			field: 'symbolRoutes',
		});
	}

	const key = rawKey.trim().toUpperCase().replace(/\s*:\s*/, ':').replace(/\s+/g, '_');
	if (!/^(?:[A-Z][A-Z0-9_]{1,15}:)?[A-Z0-9._-]{2,20}$/.test(key)) {
		throw new NotificationRoutingValidationError(`Invalid symbolRoutes key: ${rawKey}`, {
			field: 'symbolRoutes',
		});
	}

	return key;
}

function normalizeSymbolRoutes(rawSymbolRoutes) {
	if (rawSymbolRoutes === undefined) {
		return undefined;
	}
	if (!rawSymbolRoutes || typeof rawSymbolRoutes !== 'object' || Array.isArray(rawSymbolRoutes) || Object.keys(rawSymbolRoutes).length === 0) {
		throw new NotificationRoutingValidationError('"symbolRoutes" must be a non-empty object', {
			field: 'symbolRoutes',
		});
	}

	return Object.fromEntries(Object.entries(rawSymbolRoutes).map(([rawKey, rawRoute]) => {
		if (!rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) {
			throw new NotificationRoutingValidationError(`Route for ${rawKey} must be an object`, {
				field: 'symbolRoutes',
			});
		}

		return [normalizeSymbolRouteKey(rawKey), {
			channels: normalizeChannels(rawRoute.channels, { required: true }),
		}];
	}));
}

function extractSymbolReferences(text) {
	if (typeof text !== 'string') {
		return [];
	}

	const references = [];
	const seen = new Set();
	// ponytail: token heuristic; use structured alert metadata if symbol grammars expand.
	const symbolPattern = /\b(?:([A-Za-z][A-Za-z0-9_]{1,15}):)?([A-Za-z][A-Za-z0-9._-]{1,19})\b/g;
	let match;
	while ((match = symbolPattern.exec(text)) !== null) {
		const rawExchange = match[1];
		const rawSymbol = match[2];
		const symbol = rawSymbol.toUpperCase();
		if ((!rawExchange && rawSymbol !== symbol) || SYMBOL_STOP_WORDS.has(symbol)) {
			continue;
		}
		const referenceKey = rawExchange ? `${rawExchange}:${symbol}`.toUpperCase() : symbol;
		if (seen.has(referenceKey)) {
			continue;
		}
		seen.add(referenceKey);
		references.push({
			symbol,
			lookupKeys: rawExchange ? [normalizeSymbolRouteKey(referenceKey), symbol] : [symbol],
		});
	}

	return references;
}

function resolveSymbolRouteDispatches(text, symbolRoutes, routing = {}) {
	if (!symbolRoutes) {
		return null;
	}

	const references = extractSymbolReferences(text);
	if (references.length === 0) {
		return null;
	}

	return references.map((reference) => {
		const route = reference.lookupKeys.map((key) => symbolRoutes[key]).find(Boolean);
		return {
			symbol: reference.symbol,
			channels: route ? route.channels : routing.channels,
		};
	});
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
			symbolRoutes: undefined,
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
		symbolRoutes: normalizeSymbolRoutes(raw.symbolRoutes),
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
	const symbolDispatches = resolveSymbolRouteDispatches(alert && alert.text, routing.symbolRoutes, routing);
	if (symbolDispatches) {
		const results = await Promise.all(symbolDispatches.map(async ({ symbol, channels }) => {
			const symbolAlert = { ...alertPayload, symbol };
			const delivered = channels
				? await notificationManager.sendToChannels(symbolAlert, channels, options)
				: await notificationManager.sendToAll(symbolAlert, options);
			return delivered.map((result) => ({ ...result, symbol }));
		}));
		return results.flat();
	}

	if (routing.channels) {
		validateNotificationRouting(notificationManager, routing);
		return notificationManager.sendToChannels(alertPayload, routing.channels, options);
	}

	return notificationManager.sendToAll(alertPayload, options);
}

function validateNotificationRouting(notificationManager, routing = {}) {
	const requestedChannels = [
		...(routing.channels || []),
		...Object.values(routing.symbolRoutes || {}).flatMap((route) => route.channels),
	];
	if (requestedChannels.length === 0) {
		return;
	}

	const enabledChannels = getRequestedChannels(notificationManager);
	const unavailableChannels = [...new Set(requestedChannels)].filter((channel) => !enabledChannels.includes(channel));
	if (unavailableChannels.length > 0) {
		throw new NotificationRoutingValidationError(
			`Requested channel(s) disabled or misconfigured: ${unavailableChannels.join(', ')}`,
			{ field: 'channels', unavailableChannels },
		);
	}
}

function getRequestedChannels(notificationManager, routing = {}, text) {
	const enabledChannels = !notificationManager || typeof notificationManager.getEnabledChannels !== 'function'
		? []
		: notificationManager.getEnabledChannels();
	if (routing.symbolRoutes) {
		const dispatches = resolveSymbolRouteDispatches(text, routing.symbolRoutes, routing);
		if (dispatches) {
			return [...new Set(dispatches.flatMap(({ channels }) => channels || enabledChannels))];
		}
	}

	if (routing.channels) {
		return routing.channels;
	}

	return enabledChannels;
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
	extractSymbolReferences,
	resolveSymbolRouteDispatches,
};
