const statusController = require('./status');

const NOTIFICATION_CHANNEL_NAMES = ['telegram', 'whatsapp', 'discord'];

function isTruthy(value) {
	if (typeof value === 'string') {
		return value.trim().toLowerCase() === 'true';
	}
	return Boolean(value);
}

function isDeepRequested(req) {
	const raw = req && req.query && req.query.deep;
	return isTruthy(raw);
}

function getChannelReadinessSnapshot() {
	const snapshot = (() => {
		try {
			return statusController.getStatus();
		} catch (error) {
			console.warn('[Healthcheck] statusController.getStatus() failed:', error.message);
			return { dependencies: {} };
		}
	})();
	const deps = (snapshot && snapshot.dependencies) || {};
	const channels = {};
	for (const name of NOTIFICATION_CHANNEL_NAMES) {
		const dep = deps[name];
		if (!dep || typeof dep !== 'object') {
			channels[name] = {
				enabled: false,
				ready: false,
				status: 'unknown',
			};
			continue;
		}
		channels[name] = {
			enabled: dep.enabled === true,
			ready: dep.ready === true,
			status: dep.status || (dep.ready ? 'ready' : 'unknown'),
			...(dep.error ? { error: dep.error } : {}),
		};
	}
	return channels;
}

function computeDeepHealth(channels) {
	const degraded = [];
	for (const name of NOTIFICATION_CHANNEL_NAMES) {
		const channel = channels[name];
		if (!channel || !channel.enabled) {
			continue;
		}
		if (channel.ready !== true) {
			degraded.push(name);
		}
	}
	return {
		healthy: degraded.length === 0,
		degradedChannels: degraded,
	};
}

function buildDeepHealthResponse() {
	const channels = getChannelReadinessSnapshot();
	const { healthy, degradedChannels } = computeDeepHealth(channels);
	const body = {
		status: healthy ? 'healthy' : 'degraded',
		uptime: process.uptime(),
		channels,
	};
	if (!healthy) {
		body.degradedChannels = degradedChannels;
	}
	return { healthy, body };
}

function getDeepHealthcheckHandler() {
	return function deepHealthcheck(req, res) {
		if (!isDeepRequested(req)) {
			return res.status(200).json({ uptime: process.uptime() });
		}
		const { healthy, body } = buildDeepHealthResponse();
		return res.status(healthy ? 200 : 503).json(body);
	};
}

module.exports = {
	getDeepHealthcheckHandler,
	getChannelReadinessSnapshot,
	computeDeepHealth,
	isDeepRequested,
};