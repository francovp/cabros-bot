/**
 * telegramCommandAuth.js
 *
 * Telegraf middleware that gates bot command invocation behind an
 * authorized-chat allowlist. The HTTP surface is protected by
 * `validateApiKey`; the Telegram surface is an open, unthrottled trigger for
 * the same expensive backends (TradingView MCP, Gemini, Binance, Twelve Data).
 * This module is the in-process equivalent of that allowlist gate so a stranger
 * who discovers the bot username cannot run provider calls or inject messages
 * into the operator's private trading group.
 *
 * The allowlist is sourced from `TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated)
 * and defaults to `TELEGRAM_CHAT_ID` when the explicit list is unset. Both
 * private and group chat IDs are supported; the comparison is exact-match on
 * the string form of the chat id so that no chat type leaks through.
 *
 * Unauthorized senders are dropped silently (log once per sender, no reply) to
 * avoid confirming the bot's features. Read-only commands registered with
 * `registerOpenCommand()` (e.g. `/help`, `/start`) are exempt from the gate.
 */

const sentryService = require('../services/monitoring/SentryService');

const SILENT_DROP_LOG_COOLDOWN_MS = 60000;

/**
 * The cooldown map only suppresses duplicate log lines, so it must stay bounded:
 * strangers discovering the bot are the stated threat model, and an unbounded
 * per-chat-id map would grow without limit under sustained traffic. Evicting
 * early only costs one extra log line, so this stays fail-open.
 */
const SILENT_DROP_TRACKED_TTL_MS = 600000;
const SILENT_DROP_TRACKED_MAX_ENTRIES = 1000;

let silentDropState = {
	deniedSenders: new Map(),
	deniedTotal: 0,
};

function resetSilentDropState() {
	silentDropState = { deniedSenders: new Map(), deniedTotal: 0 };
}

function pruneTrackedDenials(now) {
	for (const [key, timestamp] of silentDropState.deniedSenders) {
		if (now - timestamp > SILENT_DROP_TRACKED_TTL_MS) {
			silentDropState.deniedSenders.delete(key);
		}
	}
	while (silentDropState.deniedSenders.size > SILENT_DROP_TRACKED_MAX_ENTRIES) {
		const oldest = silentDropState.deniedSenders.keys().next().value;
		silentDropState.deniedSenders.delete(oldest);
	}
}

function parseAllowedChatIds(value) {
	if (typeof value !== 'string' || value.trim() === '') {
		return [];
	}
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function resolveAllowedChatIds() {
	const explicit = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
	if (explicit.length > 0) {
		return explicit;
	}
	const fallback = process.env.TELEGRAM_CHAT_ID;
	return fallback ? [String(fallback).trim()] : [];
}

function getResolvedAllowedChatIds() {
	return resolveAllowedChatIds();
}

function getStatus() {
	const allowed = getResolvedAllowedChatIds();
	const explicit = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
	return {
		enabled: allowed.length > 0,
		allowlistSource: explicit.length > 0 ? 'TELEGRAM_ALLOWED_CHAT_IDS' : 'TELEGRAM_CHAT_ID',
		allowlistSize: allowed.length,
		deniedSinceStart: silentDropState.deniedTotal,
		trackedDeniedSenders: silentDropState.deniedSenders.size,
		deniedSenderCacheLimit: SILENT_DROP_TRACKED_MAX_ENTRIES,
	};
}

function isChatAuthorized(chatId) {
	if (chatId === undefined || chatId === null) {
		return false;
	}
	const allowed = getResolvedAllowedChatIds();
	if (allowed.length === 0) {
		return false;
	}
	const normalized = String(chatId).trim();
	return allowed.includes(normalized);
}

function extractChatId(context) {
	if (!context || typeof context.update !== 'object') return undefined;
	const message = context.update.message
		|| context.update.edited_message
		|| context.update.channel_post
		|| context.update.edited_channel_post;
	if (message && message.chat && message.chat.id !== undefined) {
		return message.chat.id;
	}
	if (context.message && context.message.chat && context.message.chat.id !== undefined) {
		return context.message.chat.id;
	}
	return undefined;
}

function recordSilentDrop(chatId) {
	if (chatId === undefined || chatId === null) return;
	const key = String(chatId);
	const now = Date.now();
	pruneTrackedDenials(now);
	const previous = silentDropState.deniedSenders.get(key) || 0;
	if (now - previous < SILENT_DROP_LOG_COOLDOWN_MS) {
		return;
	}
	silentDropState.deniedSenders.set(key, now);
	silentDropState.deniedTotal += 1;
	pruneTrackedDenials(now);
	console.warn('[telegram] Dropped command from unauthorized chat:', key);
}

function buildSilentDropAuthMiddleware() {
	return async (context, next) => {
		const chatId = extractChatId(context);
		if (!isChatAuthorized(chatId)) {
			recordSilentDrop(chatId);
			return;
		}
		return next();
	};
}

function buildLoggingAuthMiddleware() {
	return async (context, next) => {
		try {
			return await next();
		} catch (error) {
			const chatId = extractChatId(context);
			if (error && typeof error === 'object') {
				sentryService.captureRuntimeError({
					channel: 'telegram',
					feature: 'telegram-command-auth',
					error,
					extra: {
						authorized: isChatAuthorized(chatId),
						chatId: chatId !== undefined ? String(chatId) : 'unknown',
					},
				});
			}
			throw error;
		}
	};
}

function registerAuthMiddleware(bot) {
	if (!bot || typeof bot.use !== 'function') return;
	const silentDrop = buildSilentDropAuthMiddleware();
	const withLogging = buildLoggingAuthMiddleware();
	bot.use(silentDrop);
	bot.use(withLogging);
}

module.exports = {
	extractChatId,
	getResolvedAllowedChatIds,
	getStatus,
	isChatAuthorized,
	parseAllowedChatIds,
	registerAuthMiddleware,
	resetSilentDropState,
};
