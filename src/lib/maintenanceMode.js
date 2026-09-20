'use strict';

const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');
const defaultSentryService = require('../services/monitoring/SentryService');

const MAINTENANCE_ERROR_RESPONSE = Object.freeze({
	error: 'MAINTENANCE_MODE',
	message: 'Service is temporarily unavailable for maintenance',
});

const TELEGRAM_MAINTENANCE_NOTICE = '⚠️ El bot se encuentra temporalmente en modo de mantenimiento. Por favor, intenta más tarde.';

let lastNotifiedMaintenanceMode = false;
let lastNotifiedTemplateVersion = null;
let lastSeenTemplateVersion = null;
let isNotifying = false;
let globalBotGetter = null;

function resetNotificationLatch() {
	lastNotifiedMaintenanceMode = false;
	lastNotifiedTemplateVersion = null;
	lastSeenTemplateVersion = null;
}

function handleRemoteConfigChange({ prevOverrides, nextOverrides, templateVersion }) {
	const prevVal = prevOverrides?.ENABLE_MAINTENANCE_MODE;
	const nextVal = nextOverrides?.ENABLE_MAINTENANCE_MODE;

	if (nextVal === false || (prevVal === true && nextVal !== true) || (prevVal === false && nextVal === true)) {
		resetNotificationLatch();
	} else if (nextVal !== true && !isMaintenanceModeEnabled()) {
		resetNotificationLatch();
	} else if (templateVersion && lastNotifiedTemplateVersion && templateVersion !== lastNotifiedTemplateVersion) {
		resetNotificationLatch();
	}
}

if (typeof remoteConfigService.addChangeListener === 'function') {
	remoteConfigService.addChangeListener(handleRemoteConfigChange);
}

/**
 * Returns whether maintenance mode is currently enabled.
 * Checks Remote Config first, falling back to ENABLE_MAINTENANCE_MODE env var.
 * @returns {boolean}
 */
function isMaintenanceModeEnabled() {
	let enabled = false;
	let currentTemplateVersion = null;
	try {
		const status = remoteConfigService.getStatus();
		currentTemplateVersion = status?.templateVersion || null;
		const runtimeConfig = remoteConfigService.getRuntimeConfig();
		if (typeof runtimeConfig.ENABLE_MAINTENANCE_MODE === 'boolean') {
			enabled = runtimeConfig.ENABLE_MAINTENANCE_MODE;
		} else {
			enabled = process.env.ENABLE_MAINTENANCE_MODE === 'true';
		}
	} catch (_) {
		// Fail-open: fall back to environment variable if RemoteConfigService fails
		enabled = process.env.ENABLE_MAINTENANCE_MODE === 'true';
	}

	if (currentTemplateVersion && lastSeenTemplateVersion && currentTemplateVersion !== lastSeenTemplateVersion) {
		if (lastNotifiedTemplateVersion && currentTemplateVersion !== lastNotifiedTemplateVersion) {
			lastNotifiedMaintenanceMode = false;
			lastNotifiedTemplateVersion = null;
		}
	}
	if (currentTemplateVersion) {
		lastSeenTemplateVersion = currentTemplateVersion;
	}

	if (!enabled && lastNotifiedMaintenanceMode) {
		lastNotifiedMaintenanceMode = false;
		lastNotifiedTemplateVersion = null;
	}
	return enabled;
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
	if (isEnabled && !lastNotifiedMaintenanceMode && !isNotifying) {
		isNotifying = true;
		try {
			const notified = await notifyAdminOnToggle(options);
			if (notified && isMaintenanceModeEnabled()) {
				lastNotifiedMaintenanceMode = true;
				try {
					lastNotifiedTemplateVersion = remoteConfigService.getStatus()?.templateVersion || null;
				} catch (_) {
					lastNotifiedTemplateVersion = null;
				}
			} else if (!isMaintenanceModeEnabled()) {
				lastNotifiedMaintenanceMode = false;
				lastNotifiedTemplateVersion = null;
			}
		} finally {
			isNotifying = false;
		}
	} else if (!isEnabled && lastNotifiedMaintenanceMode) {
		lastNotifiedMaintenanceMode = false;
		lastNotifiedTemplateVersion = null;
	}
}

const maintenanceReplyBuckets = new Map();
const MAINTENANCE_REPLY_COOLDOWN_MS = 5000;
const MAX_MAINTENANCE_BUCKETS = 10_000;

function isMaintenanceReplyThrottled(chatId, now = Date.now()) {
	if (chatId === undefined || chatId === null) {
		return false;
	}
	const lastReplyAt = maintenanceReplyBuckets.get(chatId) || 0;
	if (now - lastReplyAt < MAINTENANCE_REPLY_COOLDOWN_MS) {
		return true;
	}
	maintenanceReplyBuckets.set(chatId, now);

	if (maintenanceReplyBuckets.size > MAX_MAINTENANCE_BUCKETS) {
		for (const [id, timestamp] of maintenanceReplyBuckets) {
			if (now - timestamp >= MAINTENANCE_REPLY_COOLDOWN_MS * 2) {
				maintenanceReplyBuckets.delete(id);
			}
		}
	}
	return false;
}

/**
 * Determines whether a Telegraf context represents a bot command addressed to this bot.
 * If the command includes a recipient (@bot_username), verifies that it matches the current bot.
 * Commands directed to other bots in group chats return false so they can pass through.
 *
 * @param {Object} context
 * @returns {boolean}
 */
function isTelegramCommand(context) {
	const message = context && (context.message || context.channelPost);
	if (!message || typeof message.text !== 'string') {
		return false;
	}
	const text = message.text.trim();
	if (!text) {
		return false;
	}

	let commandToken = '';
	const commandEntity = Array.isArray(message.entities)
		&& message.entities.find((entity) => entity.type === 'bot_command' && entity.offset === 0);

	if (commandEntity) {
		commandToken = text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length);
	} else if (text.startsWith('/')) {
		commandToken = text.split(/\s+/)[0];
	}

	if (!commandToken) {
		return false;
	}

	const tokenWithoutSlash = commandToken.startsWith('/') ? commandToken.slice(1) : commandToken;
	const [rawCommand, recipient] = tokenWithoutSlash.split('@', 2);
	if (recipient !== undefined) {
		const myUsername = context?.me || context?.botInfo?.username;
		if (!myUsername || recipient.toLowerCase() !== String(myUsername).replace(/^@/, '').toLowerCase()) {
			return false;
		}
	}

	return true;
}

/**
 * Express middleware to gate protected endpoints during maintenance mode.
 * Returns HTTP 503 SERVICE_UNAVAILABLE with a structured JSON envelope when active.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function maintenanceModeMiddleware(req, res, next) {
	if (isMaintenanceModeEnabled()) {
		checkAndNotifyMaintenanceModeToggle().catch(() => {});
		return res.status(503).json(MAINTENANCE_ERROR_RESPONSE);
	}
	return next();
}

/**
 * Telegraf middleware to intercept incoming bot commands when maintenance mode is active.
 * Leaves non-command updates (callbacks, plain text messages) unaffected.
 * Applies a per-chat throttle to prevent outbound spam flooding during an incident.
 *
 * @param {Object} context
 * @param {Function} next
 */
async function telegramMaintenanceMode(context, next) {
	if (!isTelegramCommand(context)) {
		return next();
	}
	if (isMaintenanceModeEnabled()) {
		const bot = context && (context.bot || { telegram: context.telegram });
		checkAndNotifyMaintenanceModeToggle({ bot }).catch(() => {});

		const chatId = context?.chat?.id ?? context?.message?.chat?.id ?? context?.update?.message?.chat?.id;
		if (!isMaintenanceReplyThrottled(chatId)) {
			if (context && typeof context.reply === 'function') {
				try {
					await context.reply(TELEGRAM_MAINTENANCE_NOTICE);
				} catch (error) {
					console.error('[commands] Failed to send Telegram maintenance reply:', error.message);
				}
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
	resetNotificationLatch();
	isNotifying = false;
	globalBotGetter = null;
	maintenanceReplyBuckets.clear();
	if (typeof remoteConfigService.addChangeListener === 'function') {
		remoteConfigService.addChangeListener(handleRemoteConfigChange);
	}
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
	isTelegramCommand,
	resetNotificationLatch,
	_handleRemoteConfigChange: handleRemoteConfigChange,
	_resetForTesting: resetForTesting,
};
