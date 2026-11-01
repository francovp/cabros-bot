'use strict';

const SOURCE_ALIAS_GROUPS = [
	['market-scanner', 'scanner', 'scanner-alert', 'scanner-alerts', 'market-scanner-alert'],
	['news-monitor', 'news', 'news-alert', 'news-monitor-alert'],
	['expanded-analysis', 'expanded-analysis-alert', 'analysis', 'analisis'],
	['symbol-analysis', 'symbol-analysis-alert'],
	['volume-confirmation', 'volume-confirmation-alert'],
	['scanner-preset', 'scanner-presets', 'presets', 'preset'],
	['generic-message', 'message', 'custom-message', 'generic-message-webhook'],
	['alert-replay', 'replay', 'alert-replay-replay'],
	['webhook-alert', 'webhook', 'webhook-signal', 'signal', 'signals'],
	['tradingview-analysis', 'jobs', 'job', 'tradingview-jobs'],
];

let aggregateDecisions = 0;
let aggregateFallbacks = 0;

function recordDecision(isFallback) {
	aggregateDecisions += 1;
	if (isFallback) {
		aggregateFallbacks += 1;
	}
}

function getAggregateStats() {
	return {
		decisions: aggregateDecisions,
		fallbacks: aggregateFallbacks,
	};
}

function resetAggregateStatsForTesting() {
	aggregateDecisions = 0;
	aggregateFallbacks = 0;
}

function pickRouteKey(alert, routes) {
	if (!alert || typeof alert !== 'object' || !routes) {
		return null;
	}
	const candidates = [
		alert.source,
		alert.category,
		alert.type,
		alert.setupType,
		alert.eventCategory,
		alert.topic,
	]
		.filter((v) => typeof v === 'string' && v.trim().length > 0)
		.map((v) => v.trim().toLowerCase());

	for (const key of candidates) {
		if (Object.prototype.hasOwnProperty.call(routes, key)) {
			return key;
		}
	}

	for (const key of candidates) {
		for (const group of SOURCE_ALIAS_GROUPS) {
			if (group.includes(key)) {
				for (const alias of group) {
					if (Object.prototype.hasOwnProperty.call(routes, alias)) {
						return alias;
					}
				}
			}
		}
	}

	if (Object.prototype.hasOwnProperty.call(routes, 'default')) {
		return 'default';
	}
	if (Object.prototype.hasOwnProperty.call(routes, '*')) {
		return '*';
	}
	return null;
}

function parseDiscordSourceRouting(rawRoutes, logger = console) {
	if (!rawRoutes) {
		return {};
	}

	let parsedInput = rawRoutes;
	if (typeof rawRoutes === 'string') {
		const trimmed = rawRoutes.trim();
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				parsedInput = JSON.parse(trimmed);
			} catch (error) {
				logger?.warn?.(
					`[DiscordSourceRouting] Ignoring malformed JSON routing config: ${error.message}`,
				);
				return {};
			}
		} else {
			logger?.warn?.('[DiscordSourceRouting] Ignoring non-JSON routing config (expected JSON object)');
			return {};
		}
	}

	if (typeof parsedInput !== 'object' || parsedInput === null || Array.isArray(parsedInput)) {
		logger?.warn?.('[DiscordSourceRouting] Ignoring non-object routing config');
		return {};
	}

	const routes = {};
	for (const [key, value] of Object.entries(parsedInput)) {
		if (!key || typeof key !== 'string') continue;
		const normalizedKey = key.trim().toLowerCase();
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (trimmed.length === 0) {
				logger?.warn?.(`[DiscordSourceRouting] Skipping empty webhook URL for "${key}"`);
				continue;
			}
			routes[normalizedKey] = trimmed;
		} else {
			logger?.warn?.(`[DiscordSourceRouting] Ignoring non-string webhook URL for "${key}"`);
		}
	}
	return routes;
}

function resolveDiscordWebhookForAlert(alert, routes, fallbackWebhookUrl, logger = console) {
	if (!routes || Object.keys(routes).length === 0) {
		return { webhookUrl: fallbackWebhookUrl, routeKey: null };
	}
	const routeKey = pickRouteKey(alert, routes);
	if (!routeKey) {
		recordDecision(true);
		return { webhookUrl: fallbackWebhookUrl, routeKey: null };
	}
	const routed = routes[routeKey];
	if (!routed || (typeof routed === 'string' && routed.trim().length === 0)) {
		logger?.warn?.(
			`[DiscordSourceRouting] Empty webhook for resolved route "${routeKey}", falling back to default`,
		);
		recordDecision(true);
		return { webhookUrl: fallbackWebhookUrl, routeKey };
	}
	recordDecision(fallbackWebhookUrl === routed);
	return { webhookUrl: routed, routeKey };
}

function isValidDiscordWebhookUrl(value) {
	if (typeof value !== 'string' || value.length === 0) return false;
	let parsedUrl;
	try {
		parsedUrl = new URL(value);
	} catch (_) {
		return false;
	}
	if (parsedUrl.protocol !== 'https:') return false;
	const hostname = parsedUrl.hostname.toLowerCase();
	const isValidDiscordHost =
		hostname === 'discord.com' ||
		hostname.endsWith('.discord.com') ||
		hostname === 'discordapp.com' ||
		hostname.endsWith('.discordapp.com');
	if (!isValidDiscordHost) return false;
	const DISCORD_WEBHOOK_PATH_PATTERN = /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+(?:\/.*)?$/;
	return DISCORD_WEBHOOK_PATH_PATTERN.test(parsedUrl.pathname);
}

function summarizeDiscordSourceRouting(routes) {
	const summary = {
		enabled: false,
		routesConfigured: 0,
		keys: [],
		hasDefault: false,
	};
	if (!routes || Object.keys(routes).length === 0) {
		return summary;
	}
	summary.enabled = true;
	summary.routesConfigured = Object.keys(routes).length;
	summary.keys = Object.keys(routes).sort();
	summary.hasDefault = summary.keys.includes('default') || summary.keys.includes('*');
	return summary;
}

module.exports = {
	parseDiscordSourceRouting,
	resolveDiscordWebhookForAlert,
	summarizeDiscordSourceRouting,
	isValidDiscordWebhookUrl,
	getAggregateStats,
	resetAggregateStatsForTesting,
	SOURCE_ALIAS_GROUPS,
};