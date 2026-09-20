'use strict';

const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');
const defaultSentryService = require('../services/monitoring/SentryService');
const MarkdownV2Formatter = require('../services/notification/formatters/markdownV2Formatter');

const markdownV2Formatter = new MarkdownV2Formatter();

const MAINTENANCE_ERROR_RESPONSE = Object.freeze({
	error: 'MAINTENANCE_MODE',
	message: 'Service is temporarily unavailable for maintenance',
});

const RAW_TELEGRAM_MAINTENANCE_NOTICE = '⚠️ El bot se encuentra temporalmente en modo de mantenimiento. Por favor, intenta más tarde.';
const TELEGRAM_MAINTENANCE_NOTICE = markdownV2Formatter.format(RAW_TELEGRAM_MAINTENANCE_NOTICE);

let lastNotifiedMaintenanceMode = false;
let lastNotificationFailureAt = 0;
const NOTIFICATION_FAILURE_RETRY_COOLDOWN_MS = 60_000;
let isNotifying = false;
let globalBotGetter = null;

function resetNotificationLatch() {
	lastNotifiedMaintenanceMode = false;
	lastNotificationFailureAt = 0;
}

function getEffectiveMaintenanceMode(overrides) {
	if (overrides && overrides.ENABLE_MAINTENANCE_MODE !== undefined) {
		return overrides.ENABLE_MAINTENANCE_MODE === true;
	}
	return process.env.ENABLE_MAINTENANCE_MODE === 'true';
}

function handleRemoteConfigChange({ prevOverrides, nextOverrides }) {
	const prevEffective = getEffectiveMaintenanceMode(prevOverrides);
	const nextEffective = getEffectiveMaintenanceMode(nextOverrides);

	// Reset notification latch only if maintenance mode transitioned (enabled <-> disabled)
	// or is currently disabled. Do not reset if maintenance mode remained enabled across
	// an unrelated parameter publish.
	if (prevEffective !== nextEffective || !nextEffective) {
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
	try {
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

	if (!enabled && lastNotifiedMaintenanceMode) {
		lastNotifiedMaintenanceMode = false;
		lastNotificationFailureAt = 0;
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
	const now = Date.now();
	if (isEnabled && !lastNotifiedMaintenanceMode && !isNotifying) {
		const failureCooldownMs = options.failureRetryCooldownMs ?? NOTIFICATION_FAILURE_RETRY_COOLDOWN_MS;
		if (lastNotificationFailureAt > 0 && now - lastNotificationFailureAt < failureCooldownMs) {
			return;
		}
		isNotifying = true;
		try {
			const notified = await notifyAdminOnToggle(options);
			if (notified && isMaintenanceModeEnabled()) {
				lastNotifiedMaintenanceMode = true;
				lastNotificationFailureAt = 0;
			} else if (!isMaintenanceModeEnabled()) {
				lastNotifiedMaintenanceMode = false;
				lastNotificationFailureAt = 0;
			} else {
				// Notification attempt failed while maintenance remained enabled.
				// Apply a bounded failure cooldown before trying again.
				lastNotificationFailureAt = Date.now();
			}
		} finally {
			isNotifying = false;
		}
	} else if (!isEnabled && lastNotifiedMaintenanceMode) {
		resetNotificationLatch();
	}
}

const maintenanceReplyBuckets = new Map();
const MAINTENANCE_REPLY_COOLDOWN_MS = 5000;
const MAX_MAINTENANCE_BUCKETS = 10_000;

function isMaintenanceReplyThrottled(chatId, now = Date.now(), options = {}) {
	if (chatId === undefined || chatId === null) {
		return false;
	}
	const maxBuckets = options.maxBuckets ?? MAX_MAINTENANCE_BUCKETS;
	const lastReplyAt = maintenanceReplyBuckets.get(chatId) || 0;
	if (now - lastReplyAt < MAINTENANCE_REPLY_COOLDOWN_MS) {
		return true;
	}

	// Enforce bucket capacity before inserting new entries
	if (maintenanceReplyBuckets.size >= maxBuckets) {
		for (const [id, timestamp] of maintenanceReplyBuckets) {
			if (now - timestamp >= MAINTENANCE_REPLY_COOLDOWN_MS) {
				maintenanceReplyBuckets.delete(id);
			}
		}
		// If still at or above capacity after pruning expired entries, evict oldest entry to enforce strict cap
		while (maintenanceReplyBuckets.size >= maxBuckets) {
			const oldestKey = maintenanceReplyBuckets.keys().next().value;
			if (oldestKey === undefined) break;
			maintenanceReplyBuckets.delete(oldestKey);
		}
	}

	maintenanceReplyBuckets.delete(chatId);
	maintenanceReplyBuckets.set(chatId, now);
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

const DEFAULT_MAINTENANCE_REPLY_TIMEOUT_MS = 5000;

/**
 * Sends a bounded maintenance reply to a Telegram chat, preventing stalled connections
 * from blocking Telegraf's polling loop.
 *
 * @param {Object} context Telegraf update context
 * @param {string|number} chatId
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function sendMaintenanceReply(context, chatId, timeoutMs = DEFAULT_MAINTENANCE_REPLY_TIMEOUT_MS) {
	const controller = new AbortController();
	let timeoutId;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort(new Error(`Telegram maintenance reply timed out after ${timeoutMs}ms`));
			reject(new Error(`Telegram maintenance reply timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		const sendPromise = typeof context?.telegram?.callApi === 'function' && chatId !== undefined && chatId !== null
			? context.telegram.callApi('sendMessage', {
				chat_id: chatId,
				text: TELEGRAM_MAINTENANCE_NOTICE,
				parse_mode: 'MarkdownV2',
			}, { signal: controller.signal })
			: (typeof context?.reply === 'function'
				? context.reply(TELEGRAM_MAINTENANCE_NOTICE, { parse_mode: 'MarkdownV2' })
				: Promise.resolve());

		await Promise.race([sendPromise, timeoutPromise]);
	} catch (error) {
		console.error('[commands] Failed to send Telegram maintenance reply:', error.message);
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
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
			await sendMaintenanceReply(context, chatId);
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
	NOTIFICATION_FAILURE_RETRY_COOLDOWN_MS,
	DEFAULT_MAINTENANCE_REPLY_TIMEOUT_MS,
	isMaintenanceModeEnabled,
	setBotGetter,
	notifyAdminOnToggle,
	checkAndNotifyMaintenanceModeToggle,
	sendMaintenanceReply,
	maintenanceModeMiddleware,
	telegramMaintenanceMode,
	isTelegramCommand,
	resetNotificationLatch,
	_getLatchState: () => ({ lastNotifiedMaintenanceMode, lastNotificationFailureAt }),
	_setLastNotificationFailureAt: (ts) => { lastNotificationFailureAt = ts; },
	_isMaintenanceReplyThrottled: isMaintenanceReplyThrottled,
	_getMaintenanceReplyBucketsSize: () => maintenanceReplyBuckets.size,
	_handleRemoteConfigChange: handleRemoteConfigChange,
	_resetForTesting: resetForTesting,
};
