const packageJson = require('../../package.json');
const bootstrapReadiness = require('../lib/bootstrapReadiness');

const PUBLIC_STATUS_CACHE_MS = 30000;

let cachedSnapshot = null;
let cachedAt = 0;
let cachedReady = false;

function channelReady(channel) {
	return Boolean(channel && channel.enabled);
}

function buildDependencyFlag(entry) {
	if (!entry) return { ready: false };
	return { ready: Boolean(entry.ready) };
}

function getShutdownStatus() {
	try {
		const { isShuttingDownForPublicStatus } = require('../lib/processLifecycle');
		if (typeof isShuttingDownForPublicStatus === 'function') {
			return isShuttingDownForPublicStatus();
		}
	} catch (_) {
		// module may not be available in unit-test contexts
	}
	return false;
}

function readPublicSnapshot({ getStatus, now = Date.now() } = {}) {
	if (typeof getStatus !== 'function') {
		throw new Error('getStatus function is required');
	}
	const full = getStatus();
	const enabledChannels = [];
	if (channelReady(full.deliveryChannels && full.deliveryChannels.telegram)) {
		enabledChannels.push('telegram');
	}
	if (channelReady(full.deliveryChannels && full.deliveryChannels.whatsapp)) {
		enabledChannels.push('whatsapp');
	}
	if (channelReady(full.deliveryChannels && full.deliveryChannels.discord)) {
		enabledChannels.push('discord');
	}
	const dependencies = {
		gemini: buildDependencyFlag(full.dependencies && full.dependencies.gemini),
		tradingview: buildDependencyFlag(full.dependencies && full.dependencies.tradingViewMcp),
		firestore: buildDependencyFlag(full.dependencies && full.dependencies.firestore),
	};
	const ready = bootstrapReadiness.getStatus().ready === true && !getShutdownStatus();
	return {
		service: {
			name: full.service && full.service.name ? full.service.name : packageJson.name,
			version: full.service && full.service.version != null ? full.service.version : packageJson.version,
		},
		status: {
			ok: ready,
			uptimeSeconds: Math.max(0, Math.round(process.uptime())),
			lastUpdated: new Date(now).toISOString(),
			shuttingDown: getShutdownStatus(),
		},
		channels: {
			enabled: enabledChannels,
		},
		dependencies,
	};
}

function getCachedPublicSnapshot({ getStatus, forceRefresh = false } = {}) {
	const now = Date.now();
	if (!forceRefresh && cachedSnapshot && now - cachedAt < PUBLIC_STATUS_CACHE_MS) {
		return { snapshot: cachedSnapshot, ready: cachedReady };
	}
	const snapshot = readPublicSnapshot({ getStatus, now });
	const ready = Boolean(snapshot && snapshot.status && snapshot.status.ok);
	cachedSnapshot = snapshot;
	cachedAt = now;
	cachedReady = ready;
	return { snapshot, ready };
}

function resetPublicStatusCacheForTesting() {
	cachedSnapshot = null;
	cachedAt = 0;
	cachedReady = false;
}

function getPublicStatus(getStatus) {
	return function handlePublicStatus(req, res) {
		try {
			const { snapshot, ready } = getCachedPublicSnapshot({ getStatus });
			if (!ready) {
				return res.status(503).json({
					...snapshot,
					error: 'service_not_ready',
					code: 'SERVICE_NOT_READY',
				});
			}
			return res.status(200).json(snapshot);
		} catch (error) {
			return res.status(500).json({
				error: error && error.message ? error.message : 'Internal error',
				code: 'INTERNAL_ERROR',
			});
		}
	};
}

module.exports = {
	getPublicStatus,
	readPublicSnapshot,
	getCachedPublicSnapshot,
	resetPublicStatusCacheForTesting,
	PUBLIC_STATUS_CACHE_MS,
};