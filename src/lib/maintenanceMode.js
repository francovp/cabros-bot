'use strict';

const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');
const defaultSentryService = require('../services/monitoring/SentryService');

const MAINTENANCE_ERROR_RESPONSE = Object.freeze({
	error: 'MAINTENANCE_MODE',
	message: 'Service is temporarily unavailable for maintenance',
});

const TELEGRAM_MAINTENANCE_NOTICE = '⚠️ El bot se encuentra temporalmente en modo de mantenimiento. Por favor, intenta más tarde.';

let lastNotifiedMaintenanceMode = false;
let globalBotGetter = null;

/**
 * Returns whether maintenance mode is currently enabled.
 * Checks Remote Config first, falling back to ENABLE_MAINTENANCE_MODE env var.
 * @returns {boolean}
 */
function isMaintenanceModeEnabled() {
	try {
		const runtimeConfig = remoteConfigService.getRuntimeConfig();
		if (typeof runtimeConfig.ENABLE_MAINTENANCE_MODE === 'boolean') {
			return runtimeConfig.ENABLE_MAINTENANCE_MODE;
		}
	} catch (_) {
		// Fail-open: fall back to environment variable if RemoteConfigService fails
	}
	return process.env.ENABLE_MAINTENANCE_MODE === 'true';
}

/**
 * Sets the bot getter function used to resolve a Telegraf bot instance for admin notifications.
 * @param {Function|Object} getter
 */
function setBotGetter(getter) {
	globalBotGetter = typeof getter === 'function' ? getter : () => getter;
}

/**
 * Sends a fail-open admin Telegram notification when maintenance mode is toggled on.
 * @param {Object} [options]
 * @param {Object} [options.bot]
 * @param {string} [options.chatId]
 * @param {Object} [options.logger]
 * @param {Object} [options.sentry]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<boolean>}
 */
async function notifyAdminOnToggle({
	bot,
	chatId,
	logger = console,
	sentry = defaultSentryService,
	timeoutMs = 10000,
} = {}) {
	const rawAdminChatId = chatId !== undefined ? chatId : process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	const adminChatId = String(rawAdminChatId || '').trim();

	if (!adminChatId) {
		return false;
	}

	const resolvedBot = bot || (globalBotGetter ? globalBotGetter() : null);
	if (!resolvedBot || !resolvedBot.telegram || typeof resolvedBot.telegram.sendMessage !== 'function') {
		return false;
	}

	const text = '⚠️ *Modo de mantenimiento ACTIVADO*\nLos endpoints de alertas y comandos de Telegram han sido temporalmente deshabilitados por mantenimiento\\.';

	const controller = new AbortController();
	let timeoutId;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort(new Error(`Maintenance mode notification timed out after ${timeoutMs}ms`));
			reject(new Error(`Maintenance mode notification timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		const sendPromise = typeof resolvedBot.telegram.callApi === 'function'
			? resolvedBot.telegram.callApi('sendMessage', {
				chat_id: adminChatId,
				text,
				parse_mode: 'MarkdownV2',
			}, { signal: controller.signal })
			: resolvedBot.telegram.sendMessage(adminChatId, text, { parse_mode: 'MarkdownV2' });

		await Promise.race([sendPromise, timeoutPromise]);
		logger.log?.('[maintenanceMode] Admin notification sent: Maintenance mode activated');
		return true;
	} catch (error) {
		logger.warn?.('[maintenanceMode] Failed to send admin notification for maintenance mode:', error.message);
		try {
			sentry?.captureRuntimeError?.({
				channel: 'telegram',
				error,
				extra: { context: 'maintenance_mode_admin_notification', adminChatId },
			});
		} catch (_) {
			// Fail-open
		}
		return false;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Checks if maintenance mode transitioned to active, and if so notifies the admin chat once.
 * If mode transitioned to inactive, resets the notification latch.
 * @param {Object} [options]
 * @returns {Promise<void>}
 */
async function checkAndNotifyMaintenanceModeToggle(options = {}) {
	const isEnabled = isMaintenanceModeEnabled();
	if (isEnabled && !lastNotifiedMaintenanceMode) {
		lastNotifiedMaintenanceMode = true;
		await notifyAdminOnToggle(options);
	} else if (!isEnabled && lastNotifiedMaintenanceMode) {
		lastNotifiedMaintenanceMode = false;
	}
}

/**
 * Express middleware to gate protected endpoints during maintenance mode.
 * Returns HTTP 503 SERVICE_UNAVAILABLE with a structured JSON envelope when active.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function maintenanceModeMiddleware(req, res, next) {
	if (isMaintenanceModeEnabled()) {
		await checkAndNotifyMaintenanceModeToggle();
		return res.status(503).json(MAINTENANCE_ERROR_RESPONSE);
	}
	return next();
}

/**
 * Telegraf middleware to intercept incoming bot commands when maintenance mode is active.
 *
 * @param {Object} context
 * @param {Function} next
 */
async function telegramMaintenanceMode(context, next) {
	if (isMaintenanceModeEnabled()) {
		const bot = context && (context.bot || { telegram: context.telegram });
		await checkAndNotifyMaintenanceModeToggle({ bot });
		if (context && typeof context.reply === 'function') {
			try {
				await context.reply(TELEGRAM_MAINTENANCE_NOTICE);
			} catch (error) {
				console.error('[commands] Failed to send Telegram maintenance reply:', error.message);
			}
		}
		return;
	}
	return next();
}

/**
 * Testing reset helper
 */
function resetForTesting() {
	lastNotifiedMaintenanceMode = false;
	globalBotGetter = null;
}

module.exports = {
	MAINTENANCE_ERROR_RESPONSE,
	TELEGRAM_MAINTENANCE_NOTICE,
	isMaintenanceModeEnabled,
	setBotGetter,
	notifyAdminOnToggle,
	checkAndNotifyMaintenanceModeToggle,
	maintenanceModeMiddleware,
	telegramMaintenanceMode,
	_resetForTesting: resetForTesting,
};
