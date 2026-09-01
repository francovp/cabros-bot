'use strict';

/**
 * startCommand — Telegram /start handler with deep-link payload support.
 *
 * Triggers on `t.me/<bot>?start=<payload>` deep links. Recognized tokens:
 *   enroll, lang=es|en, watch=SYM1,SYM2, ref=<token>.
 *
 * Falls back to the generic help message when:
 *   - no payload is present,
 *   - the payload is empty,
 *   - the payload is malformed.
 *
 * Fail-open: enrollment persistence errors are logged via Sentry and the
 * welcome message is still sent so the user is never ghosted by a backend
 * hiccup.
 */

const {
	parseStartPayload,
	buildStartMessage,
	DEFAULT_LANGUAGE,
} = require('./startPayload');
const chatEnrollmentsService = require('../../../../services/enrollments/ChatEnrollmentsService');

const MAX_INLINE_BUTTONS = 8;

function buildInlineKeyboard(botUsername) {
	const buttons = [];
	if (typeof botUsername === 'string' && botUsername.length > 0) {
		buttons.push([
			{
				text: 'Add to group',
				url: `https://t.me/${botUsername}?startgroup=enroll`,
			},
		]);
	}
	buttons.push([
		{ text: '/precio', callback_data: 'cmd:precio' },
		{ text: '/outcomes', callback_data: 'cmd:outcomes' },
	]);
	return { inline_keyboard: buttons.slice(0, MAX_INLINE_BUTTONS) };
}

function resolveChatId(context) {
	if (context && context.chat && context.chat.id !== undefined) return context.chat.id;
	if (context && context.update && context.update.message && context.update.message.chat) {
		return context.update.message.chat.id;
	}
	if (context && context.message && context.message.chat) return context.message.chat.id;
	return null;
}

function resolveChatType(context) {
	if (context && context.chat && typeof context.chat.type === 'string') return context.chat.type;
	if (context && context.update && context.update.message && context.update.message.chat
		&& typeof context.update.message.chat.type === 'string') {
		return context.update.message.chat.type;
	}
	if (context && context.message && context.message.chat
		&& typeof context.message.chat.type === 'string') {
		return context.message.chat.type;
	}
	return null;
}

function resolveBotUsername(context) {
	if (!context) return null;
	if (context.botInfo && typeof context.botInfo.username === 'string') return context.botInfo.username;
	if (context.telegram && context.telegram.botInfo
		&& typeof context.telegram.botInfo.username === 'string') {
		return context.telegram.botInfo.username;
	}
	return null;
}

/**
 * Send the localized welcome message and reply_markup.
 *
 * @param {object} context Telegraf context
 * @param {object} payload parsed payload result
 * @param {string} preferredLanguage
 * @returns {Promise<void>}
 */
async function replyWithWelcome(context, payload, preferredLanguage) {
	const welcome = buildStartMessage(payload, preferredLanguage);
	const botUsername = resolveBotUsername(context);
	const replyMarkup = buildInlineKeyboard(botUsername);

	await context.reply(welcome.message, {
		parse_mode: 'MarkdownV2',
		reply_markup: replyMarkup,
	});
	return welcome;
}

/**
 * Compose the /start handler with optional enrollment persistence.
 *
 * @param {object} [options]
 * @param {Function} [options.reply] injected reply (defaults to context.reply)
 * @param {Function} [options.sentry] optional Sentry capture hook
 * @returns {Function} Telegraf context handler
 */
function createStartCommand(options = {}) {
	const captureRuntimeError = options.captureRuntimeError;

	return async function startCommand(context) {
		const payload = context && typeof context.startPayload === 'string'
			? context.startPayload
			: null;

		const parsedResult = parseStartPayload(payload);
		const chatId = resolveChatId(context);
		const chatType = resolveChatType(context);

		const welcome = await replyWithWelcome(context, payload, DEFAULT_LANGUAGE);

		if (chatId === null || chatId === undefined) {
			return;
		}

		if (!chatEnrollmentsService.isEnabled()) {
			return;
		}

		try {
			const existing = await chatEnrollmentsService.getByChatId(chatId);
			const hasTokens = Array.isArray(parsedResult.tokens) && parsedResult.tokens.length > 0;
			const payloadIsValid = !parsedResult.invalid;

			// Per spec, invalid/malformed payloads are ignored. We only
			// persist when the deep link contained at least one recognized
			// token — that is the explicit signal that the user opted in.
			if (!hasTokens || !payloadIsValid) {
				return;
			}

			const merged = {
				chatId,
				chatType: chatType || (existing && existing.chatType) || 'private',
				language: parsedResult.language || (existing && existing.language) || null,
				watchlist: parsedResult.watchlist
					|| (existing && Array.isArray(existing.watchlist) ? existing.watchlist : []),
				refSource: parsedResult.refSource
				|| (existing && existing.refSource) || null,
			};

			await chatEnrollmentsService.enroll(merged);
		} catch (error) {
			console.warn('[startCommand] failed to persist enrollment:', error.message);
			if (typeof captureRuntimeError === 'function') {
				captureRuntimeError({
					channel: 'telegram',
					error,
					extra: {
						command: 'start',
						chatId,
					},
				});
			}
		}

		void welcome;
	};
}

module.exports = {
	createStartCommand,
	resolveChatId,
	resolveChatType,
	resolveBotUsername,
	buildInlineKeyboard,
};
