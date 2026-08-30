'use strict';

const TOPIC_ALIAS_GROUPS = [
	['webhook-signal', 'webhook-alert', 'webhook', 'signal', 'signals'],
	['market-scanner', 'scanner', 'scanner-alerts'],
	['news-monitor', 'news', 'news-alert'],
	['expanded-analysis', 'analysis'],
	['scanner-preset', 'scanner-presets', 'presets', 'preset'],
	['generic-message', 'message', 'custom-message'],
	['alert-replay', 'replay'],
	['tradingview-analysis', 'jobs', 'job'],
];

/**
 * Parses raw Telegram topic route configuration string or object.
 * Format: "webhook-signal:123,market-scanner:456,news-monitor:789,default:0"
 *
 * @param {string|Object} rawRoutes - String or object containing route mappings
 * @param {Object} [logger] - Optional logger for parse warnings
 * @returns {Object.<string, number>} Normalized mapping of category keys to thread IDs
 */
function parseTelegramTopicRoutes(rawRoutes, logger = console) {
	if (!rawRoutes) {
		return {};
	}

	let parsedInput = rawRoutes;
	if (typeof rawRoutes === 'string') {
		const trimmed = rawRoutes.trim();
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				parsedInput = JSON.parse(trimmed);
			} catch {
				// Fall through to comma-separated string parsing
			}
		}
	}

	const routes = {};

	if (typeof parsedInput === 'object' && parsedInput !== null && !Array.isArray(parsedInput)) {
		for (const [key, value] of Object.entries(parsedInput)) {
			if (!key || typeof key !== 'string') continue;
			const normalizedKey = key.trim().toLowerCase();
			if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
				routes[normalizedKey] = value;
			} else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
				routes[normalizedKey] = Number.parseInt(value.trim(), 10);
			} else {
				logger?.warn?.(`[TelegramTopicRouting] Invalid topic route for key "${key}": ${value}`);
			}
		}
		return routes;
	}

	if (typeof rawRoutes === 'string') {
		const entries = rawRoutes.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
		for (const entry of entries) {
			const match = /^([a-zA-Z0-9_*.-]+)\s*[:=]\s*(\d+)$/.exec(entry);
			if (match) {
				const key = match[1].toLowerCase();
				const threadId = Number.parseInt(match[2], 10);
				if (Number.isSafeInteger(threadId) && threadId >= 0) {
					routes[key] = threadId;
				}
			} else {
				logger?.warn?.(`[TelegramTopicRouting] Ignoring malformed topic route entry "${entry}"`);
			}
		}
	}

	return routes;
}

/**
 * Resolves the message_thread_id for an alert given configured topic routes.
 *
 * Precedence:
 * 1. Per-request override: alert.telegramThreadId / alert.messageThreadId (if >= 0; 0 means main chat -> null)
 * 2. Exact match in topicRoutes on alert.source / alert.category / alert.type / alert.setupType / alert.topic / alert.eventCategory
 * 3. Group alias match in topicRoutes for alert metadata keys
 * 4. Default fallback: topicRoutes['default'] or topicRoutes['*'] (0 means main chat -> null)
 * 5. Main chat (null)
 *
 * @param {Object} alert - Alert payload containing metadata or threadId override
 * @param {Object.<string, number>} [topicRoutes] - Configured topic routes
 * @param {Object} [logger] - Optional logger
 * @returns {number|null} The resolved thread ID, or null for general/main chat
 */
function resolveTelegramThreadId(alert = {}, topicRoutes = {}, logger = console) {
	// 1. Explicit per-request override
	const explicitThread = alert.telegramThreadId !== undefined
		? alert.telegramThreadId
		: alert.messageThreadId !== undefined
			? alert.messageThreadId
			: alert.telegram_thread_id !== undefined
				? alert.telegram_thread_id
				: alert.message_thread_id;

	if (explicitThread !== undefined && explicitThread !== null) {
		if (typeof explicitThread === 'number' && Number.isSafeInteger(explicitThread) && explicitThread >= 0) {
			return explicitThread > 0 ? explicitThread : null;
		}
		if (typeof explicitThread === 'string' && /^\d+$/.test(explicitThread.trim())) {
			const parsed = Number.parseInt(explicitThread.trim(), 10);
			if (Number.isSafeInteger(parsed) && parsed >= 0) {
				return parsed > 0 ? parsed : null;
			}
		}
		logger?.warn?.(`[TelegramTopicRouting] Invalid telegramThreadId override "${explicitThread}", falling back`);
	}

	if (!topicRoutes || Object.keys(topicRoutes).length === 0) {
		return null;
	}

	// 2. Candidate metadata keys
	const candidates = [
		alert.source,
		alert.category,
		alert.type,
		alert.setupType,
		alert.eventCategory,
		alert.topic,
	].filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim().toLowerCase());

	// Check exact match
	for (const key of candidates) {
		if (Object.prototype.hasOwnProperty.call(topicRoutes, key)) {
			const threadId = topicRoutes[key];
			return threadId > 0 ? threadId : null;
		}
	}

	// Check alias groups
	for (const key of candidates) {
		for (const group of TOPIC_ALIAS_GROUPS) {
			if (group.includes(key)) {
				for (const alias of group) {
					if (Object.prototype.hasOwnProperty.call(topicRoutes, alias)) {
						const threadId = topicRoutes[alias];
						return threadId > 0 ? threadId : null;
					}
				}
			}
		}
	}

	// 4. Default fallback in topicRoutes
	if (Object.prototype.hasOwnProperty.call(topicRoutes, 'default')) {
		const threadId = topicRoutes['default'];
		return threadId > 0 ? threadId : null;
	}
	if (Object.prototype.hasOwnProperty.call(topicRoutes, '*')) {
		const threadId = topicRoutes['*'];
		return threadId > 0 ? threadId : null;
	}

	return null;
}

module.exports = {
	parseTelegramTopicRoutes,
	resolveTelegramThreadId,
	TOPIC_ALIAS_GROUPS,
};
