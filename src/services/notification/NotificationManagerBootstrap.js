/**
 * NotificationManagerBootstrap
 *
 * Single startup-bootstrap module that owns the canonical
 * `NotificationManager` instance for the whole process. Replacing the
 * multiple `initializeNotificationServices(bot)` lazy call sites with this
 * bootstrap addresses three race conditions at once:
 *
 *  - Concurrent first-time handlers (TradingView burst + alert replay + a
 *    webhook message) used to race `getNotificationManager() === null`,
 *    each rebuilding a fresh `NotificationManager` and leaking the
 *    previous one.
 *  - Telegraf constructor failures, Render preview environments, or
 *    Telegram-polling-disabled deployments leave `notificationManager`
 *    `null` at startup, so the lazy init became the de-facto bootstrap
 *    path on the first webhook — adding several seconds of channel
 *    validation latency to the very first cold-start request.
 *  - The three call sites had inconsistent 503 vs. fail-open responses
 *    when initialization could not complete.
 *
 * Contract:
 *  - `initialize(bot)` is meant to be called exactly once from `index.js`
 *    after the bot is constructed. It returns a Promise that resolves to
 *    the constructed `NotificationManager`.
 *  - `getOrInitialize(bot)` is the safe fallback for handlers: it returns
 *    the existing manager if already initialized, otherwise runs the
 *    bootstrap once and shares the same in-flight Promise across all
 *    concurrent callers (no double init).
 *  - `getInitialized()` returns the cached manager or `null` (never
 *    throws) so handlers can check readiness without re-running init.
 *  - `resetForTesting()` clears the cached manager + in-flight Promise.
 */

const TelegramService = require('./TelegramService');
const WhatsAppService = require('./WhatsAppService');
const DiscordService = require('./DiscordService');
const NotificationManager = require('./NotificationManager');
const { getURLShortener } = require('../../controllers/webhooks/handlers/newsMonitor/urlShortener');

let notificationManager = null;
let initPromise = null;
let lastInitStartedAt = 0;
let lastInitFinishedAt = 0;
let lastInitSucceeded = false;

function buildServices(bot) {
	const telegramService = new TelegramService({
		bot,
		logger: console,
	});

	const whatsappService = new WhatsAppService({
		logger: console,
		urlShortener: getURLShortener(),
	});

	const discordService = new DiscordService({
		logger: console,
	});

	return { telegramService, whatsappService, discordService };
}

async function constructManager(bot) {
	const { telegramService, whatsappService, discordService } = buildServices(bot);
	const manager = new NotificationManager(telegramService, whatsappService, discordService);

	console.debug('Initializing notification services...');
	await manager.validateAll();

	const enabledChannels = manager.getEnabledChannels();
	console.debug(`Notification services initialized: ${enabledChannels.join(', ') || 'none'}`);

	return manager;
}

/**
 * Run the bootstrap exactly once. Concurrent callers receive the same
 * Promise — no double init, no leaked instances.
 *
 * @param {Object|null|Function} botOrGetter - Telegraf bot instance, a getter
 *   returning one, or `null` when the Telegram bot is disabled.
 * @returns {Promise<NotificationManager|null>} Resolves to the constructed
 *   manager, or `null` when the bot is unavailable. The Promise rejects only
 *   for unexpected programmer errors; validation failures fall through to a
 *   partially-valid manager (existing behavior).
 */
function initialize(botOrGetter) {
	if (notificationManager) {
		return Promise.resolve(notificationManager);
	}
	if (initPromise) {
		return initPromise;
	}

	let bot;
	try {
		bot = typeof botOrGetter === 'function' ? botOrGetter() : (botOrGetter || null);
	} catch (error) {
		console.error('[NotificationManagerBootstrap] Failed to resolve bot:', error.message);
		bot = null;
	}

	lastInitStartedAt = Date.now();
	initPromise = (async () => {
		try {
			const manager = await constructManager(bot);
			notificationManager = manager;
			lastInitFinishedAt = Date.now();
			lastInitSucceeded = true;
			return manager;
		} catch (error) {
			console.error('[NotificationManagerBootstrap] Initialization failed:', error.message);
			lastInitFinishedAt = Date.now();
			lastInitSucceeded = false;
			return null;
		} finally {
			// Clear the in-flight promise so a future retry attempt can re-run
			// (preserves the legacy "lazy fallback on null" behavior in tests
			// and recovery scenarios where init fails transiently).
			initPromise = null;
		}
	})();

	return initPromise;
}

/**
 * Returns the cached manager or runs `initialize(bot)` exactly once even
 * under concurrent calls. Handlers may use this as a deterministic lazy
 * fallback when they observe `getInitialized() === null`, but production
 * code should rely on `index.js` having already invoked `initialize()`
 * during startup.
 *
 * @param {Object|null|Function} [botOrGetter]
 * @returns {Promise<NotificationManager|null>}
 */
function getOrInitialize(botOrGetter) {
	if (notificationManager) {
		return Promise.resolve(notificationManager);
	}
	return initialize(botOrGetter);
}

/**
 * Returns the cached manager, or `null` if the bootstrap has not finished
 * yet. Never throws and never invokes initialization.
 *
 * @returns {NotificationManager|null}
 */
function getInitialized() {
	return notificationManager;
}

/**
 * Read-only introspection helpers for status / tests. Do not use to gate
 * notification dispatch — call `getOrInitialize(bot)` instead.
 */
function getBootstrapStatus() {
	return {
		initialized: notificationManager !== null,
		lastInitStartedAt,
		lastInitFinishedAt,
		lastInitSucceeded,
		enabledChannels: notificationManager
			? notificationManager.getEnabledChannels()
			: [],
	};
}

function resetForTesting() {
	notificationManager = null;
	initPromise = null;
	lastInitStartedAt = 0;
	lastInitFinishedAt = 0;
	lastInitSucceeded = false;
}

module.exports = {
	initialize,
	getOrInitialize,
	getInitialized,
	getBootstrapStatus,
	resetForTesting,
};