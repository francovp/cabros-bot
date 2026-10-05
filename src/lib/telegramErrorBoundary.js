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

const DEFAULT_LOG_COOLDOWN_MS = 60000;
const DEFAULT_ADMIN_ALERT_THRESHOLD = 5;
const DEFAULT_ADMIN_ALERT_COOLDOWN_MS = 900000;
const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30000;

// Polling error tracking state
let pollingErrorState = {
	consecutiveFailures: 0,
	firstFailureAt: null,
	lastLoggedAt: 0,
	suppressedCount: 0,
	lastPagingAt: 0,
};

let healthProbe = {
	timer: null,
	running: false,
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

		const sendAlertContent = process.env.SENTRY_SEND_ALERT_CONTENT === 'true';
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
 * @param {number} [options.logCooldownMs=60000]
 * @param {number} [options.adminAlertThreshold=5]
 * @param {number} [options.adminAlertCooldownMs=900000]
 * @param {number} [options.recoveryWindowMs] — when the last failure is older than
 *   this window, the prior streak is treated as ended and the next failure restarts
 *   the count from 1. Defaults to 2x `logCooldownMs` so behavior is unchanged when
 *   the option is not provided.
 */
async function handlePollingError(err, options = {}) {
	try {
		const errorObj = err instanceof Error ? err : new Error(String(err));
		const logCooldownMs = options.logCooldownMs !== undefined ? options.logCooldownMs : DEFAULT_LOG_COOLDOWN_MS;
		const adminAlertThreshold =
			options.adminAlertThreshold !== undefined ? options.adminAlertThreshold : DEFAULT_ADMIN_ALERT_THRESHOLD;
		const adminAlertCooldownMs =
			options.adminAlertCooldownMs !== undefined ? options.adminAlertCooldownMs : DEFAULT_ADMIN_ALERT_COOLDOWN_MS;
		const recoveryWindowMs =
			options.recoveryWindowMs !== undefined
				? options.recoveryWindowMs
				: Math.max(logCooldownMs * 2, 60000);
		const bot = options.bot;

		const now = Date.now();

		// If we have prior failures and the last one is older than the recovery
		// window, treat the streak as ended so a single transient error does not
		// page the admin or compound with stale telemetry.
		if (
			pollingErrorState.consecutiveFailures > 0 &&
			pollingErrorState.firstFailureAt !== null &&
			now - pollingErrorState.firstFailureAt > recoveryWindowMs
		) {
			pollingErrorState.consecutiveFailures = 0;
			pollingErrorState.firstFailureAt = null;
			pollingErrorState.suppressedCount = 0;
		}

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

/**
 * Start a periodic `getMe` health probe so a successful Telegram round-trip
 * resets the polling-failure streak even when no updates are flowing.
 *
 * Telegraf v4's long-polling loop emits no success event, so without an
 * external signal the streak is monotonic for the entire process lifetime.
 * A lightweight `getMe` call is the cheapest "polling is healthy" signal.
 *
 * Calling `startTelegramHealthProbe` while a previous probe is still running
 * stops the previous one before starting the new one (idempotent re-arm).
 *
 * @param {Object} bot - Telegraf bot instance
 * @param {Object} [options]
 * @param {number} [options.intervalMs=30000] - probe interval in milliseconds
 * @param {number} [options.requestTimeoutMs=10000] - per-probe timeout
 */
function startTelegramHealthProbe(bot, options = {}) {
	stopTelegramHealthProbe();

	if (!bot || !bot.telegram || typeof bot.telegram.getMe !== 'function') {
		return;
	}

	const intervalMs =
		options.intervalMs !== undefined && options.intervalMs > 0
			? options.intervalMs
			: DEFAULT_HEALTH_PROBE_INTERVAL_MS;
	const requestTimeoutMs =
		options.requestTimeoutMs !== undefined && options.requestTimeoutMs > 0
			? options.requestTimeoutMs
			: 10000;

	const tick = async () => {
		if (!healthProbe.running) {
			return;
		}
		try {
			await Promise.race([
				bot.telegram.getMe(),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('getMe timeout')), requestTimeoutMs),
				),
			]);
			recordPollingSuccess();
		} catch (probeError) {
			const message = probeError && probeError.message ? probeError.message : String(probeError);
			console.debug('[telegram] Health probe getMe failed:', message);
		}
	};

	healthProbe.running = true;
	healthProbe.timer = setInterval(() => {
		void tick();
	}, intervalMs);
	// Don't keep the event loop alive just for the health probe.
	if (typeof healthProbe.timer.unref === 'function') {
		healthProbe.timer.unref();
	}
}

/**
 * Stop the health probe started by `startTelegramHealthProbe`.
 * Safe to call when no probe is running.
 */
function stopTelegramHealthProbe() {
	healthProbe.running = false;
	if (healthProbe.timer) {
		clearInterval(healthProbe.timer);
		healthProbe.timer = null;
	}
}

module.exports = {
	attachTelegramErrorBoundary,
	handleTelegrafUpdateError,
	handlePollingError,
	recordPollingSuccess,
	resetPollingErrorState,
	startTelegramHealthProbe,
	stopTelegramHealthProbe,
};
