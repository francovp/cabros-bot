/**
 * telegramErrorBoundary.js
 *
 * Global error boundary and polling error supervisor for Telegraf.
 * Catches update errors, reports to Sentry, provides user feedback,
 * and rate-limits polling failures with admin paging.
 */

const sentryService = require('../services/monitoring/SentryService');
const MarkdownV2Formatter = require('../services/notification/formatters/markdownV2Formatter');

const markdownFormatter = new MarkdownV2Formatter();

// Polling error tracking state
let pollingErrorState = {
	consecutiveFailures: 0,
	firstFailureAt: null,
	lastLoggedAt: 0,
	suppressedCount: 0,
	lastPagingAt: 0,
};

function resetPollingErrorState() {
	pollingErrorState = {
		consecutiveFailures: 0,
		firstFailureAt: null,
		lastLoggedAt: 0,
		suppressedCount: 0,
		lastPagingAt: 0,
	};
}

function recordPollingSuccess() {
	if (pollingErrorState.consecutiveFailures > 0) {
		if (pollingErrorState.consecutiveFailures >= 3) {
			console.info(
				`[telegram] Polling recovered after ${pollingErrorState.consecutiveFailures} failure(s)`,
			);
		}
		pollingErrorState.consecutiveFailures = 0;
		pollingErrorState.firstFailureAt = null;
		pollingErrorState.suppressedCount = 0;
	}
}

/**
 * Handle errors thrown during Telegraf update processing (middleware/commands)
 * @param {Error|unknown} err
 * @param {Object} ctx
 * @param {Object} [options]
 */
async function handleTelegrafUpdateError(err, ctx, options = {}) {
	try {
		const update = ctx && ctx.update ? ctx.update : {};
		const updateType =
			ctx && ctx.updateType
				? ctx.updateType
				: Object.keys(update).find((k) => k !== 'update_id') || 'unknown';
		const updateId = update.update_id;
		const message = update.message || (ctx && ctx.message);
		const text = message && typeof message.text === 'string' ? message.text : undefined;
		const command = text && text.startsWith('/') ? text.split(' ')[0] : undefined;

		const errorObj = err instanceof Error ? err : new Error(String(err));
		console.error('[telegram] Error processing update:', errorObj.message, {
			updateType,
			updateId,
			command,
		});

		const sendAlertContent = sentryService.shouldSendAlertContent();
		const extra = {
			updateType,
			updateId,
			command,
			...(sendAlertContent && text ? { rawText: text } : {}),
		};

		sentryService.captureRuntimeError({
			channel: 'telegram',
			feature: 'telegram-bot',
			error: errorObj,
			extra,
		});

		if (ctx && typeof ctx.reply === 'function') {
			try {
				await ctx.reply('Lo siento, ocurrió un error interno al procesar tu solicitud.');
			} catch (replyError) {
				console.debug('[telegram] Failed to send error reply to user:', replyError.message);
			}
		}
	} catch (boundaryError) {
		console.error('[telegram] Error inside telegram error boundary:', boundaryError.message);
	}
}

/**
 * Handle polling or bot launch errors with rate-limited logging and optional admin paging
 * @param {Error|unknown} err
 * @param {Object} [options]
 */
async function handlePollingError(err, options = {}) {
	try {
		const errorObj = err instanceof Error ? err : new Error(String(err));
		const logCooldownMs = options.logCooldownMs !== undefined ? options.logCooldownMs : 60000;
		const adminAlertThreshold = options.adminAlertThreshold !== undefined ? options.adminAlertThreshold : 5;
		const adminAlertCooldownMs = options.adminAlertCooldownMs !== undefined ? options.adminAlertCooldownMs : 900000;
		const bot = options.bot;

		const now = Date.now();
		pollingErrorState.consecutiveFailures += 1;
		if (!pollingErrorState.firstFailureAt) {
			pollingErrorState.firstFailureAt = now;
		}

		const shouldLog =
			pollingErrorState.consecutiveFailures === 1 ||
			now - pollingErrorState.lastLoggedAt >= logCooldownMs;

		if (shouldLog) {
			console.error('[telegram] Polling error:', errorObj.message, {
				consecutiveFailures: pollingErrorState.consecutiveFailures,
				suppressedCount: pollingErrorState.suppressedCount,
			});
			pollingErrorState.lastLoggedAt = now;
			pollingErrorState.suppressedCount = 0;

			sentryService.captureExternalFailure({
				channel: 'telegram',
				feature: 'telegram-bot',
				external: {
					provider: 'telegram-api',
					attemptCount: pollingErrorState.consecutiveFailures,
					durationMs: now - pollingErrorState.firstFailureAt,
					lastErrorMessage: errorObj.message,
					lastErrorCode: errorObj.code || (errorObj.response && errorObj.response.error_code),
				},
				extra: {
					consecutiveFailures: pollingErrorState.consecutiveFailures,
				},
			});
		} else {
			pollingErrorState.suppressedCount += 1;
			console.debug('[telegram] Suppressed repetitive polling error:', errorObj.message);
		}

		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		if (
			adminChatId &&
			bot &&
			bot.telegram &&
			typeof bot.telegram.sendMessage === 'function' &&
			pollingErrorState.consecutiveFailures >= adminAlertThreshold &&
			now - pollingErrorState.lastPagingAt >= adminAlertCooldownMs
		) {
			pollingErrorState.lastPagingAt = now;
			const safeMessage = markdownFormatter.format(errorObj.message);
			const alertText = `⚠️ *Telegram bot sustained polling failure*\nConsecutive failures: ${pollingErrorState.consecutiveFailures}\nError: ${safeMessage}`;
			try {
				await bot.telegram.sendMessage(adminChatId, alertText, { parse_mode: 'MarkdownV2' });
			} catch (adminSendError) {
				console.warn('[telegram] Failed to send admin notification for polling error:', adminSendError.message);
			}
		}
	} catch (boundaryError) {
		console.error('[telegram] Error in polling error handler:', boundaryError.message);
	}
}

/**
 * Attach global error boundaries and polling listeners to a Telegraf instance
 * @param {Object} bot - Telegraf bot instance
 * @param {Object} [options]
 */
function attachTelegramErrorBoundary(bot, options = {}) {
	if (!bot) return;

	if (typeof bot.catch === 'function') {
		bot.catch((err, ctx) => handleTelegrafUpdateError(err, ctx, options));
	}

	if (typeof bot.on === 'function') {
		bot.on('polling_error', (error) => handlePollingError(error, { ...options, bot }));
	}
}

module.exports = {
	attachTelegramErrorBoundary,
	handleTelegrafUpdateError,
	handlePollingError,
	recordPollingSuccess,
	resetPollingErrorState,
};
