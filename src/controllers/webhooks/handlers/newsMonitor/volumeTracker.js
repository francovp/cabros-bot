'use strict';

let remoteConfigServiceModule;
function getRemoteConfig() {
	if (!remoteConfigServiceModule) {
		remoteConfigServiceModule = require('../../../../services/remoteConfig/RemoteConfigService');
	}
	return remoteConfigServiceModule.getRuntimeConfig();
}

function parseNewsMaxAlertsPerBatch(value, fallback = 10) {
	if (value === undefined) {
		return fallback;
	}
	const str = String(value).trim();
	if (str === '') {
		return fallback;
	}
	if (!/^\d+$/.test(str)) {
		console.warn('[VolumeTracker] Invalid NEWS_MAX_ALERTS_PER_BATCH configuration, using default');
		return fallback;
	}
	const parsed = Number(str);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
		console.warn('[VolumeTracker] Invalid NEWS_MAX_ALERTS_PER_BATCH configuration, using default');
		return fallback;
	}
	return parsed;
}

function parseNewsMaxAlertsPerWindow(value, fallback = 20) {
	if (value === undefined) {
		return fallback;
	}
	const str = String(value).trim();
	if (str === '') {
		return fallback;
	}
	if (!/^\d+$/.test(str)) {
		console.warn('[VolumeTracker] Invalid NEWS_MAX_ALERTS_PER_WINDOW configuration, using default');
		return fallback;
	}
	const parsed = Number(str);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
		console.warn('[VolumeTracker] Invalid NEWS_MAX_ALERTS_PER_WINDOW configuration, using default');
		return fallback;
	}
	return parsed;
}

function parseNewsMaxAlertsPerWindowMs(value, fallback = 300000) {
	if (value === undefined) {
		return fallback;
	}
	const str = String(value).trim();
	if (str === '') {
		return fallback;
	}
	if (!/^\d+$/.test(str)) {
		console.warn('[VolumeTracker] Invalid NEWS_MAX_ALERTS_PER_WINDOW_MS configuration, using default');
		return fallback;
	}
	const parsed = Number(str);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1000 || parsed > 3600000) {
		console.warn('[VolumeTracker] Invalid NEWS_MAX_ALERTS_PER_WINDOW_MS configuration, using default');
		return fallback;
	}
	return parsed;
}

class NewsAlertVolumeTracker {
	constructor(options = {}) {
		this.customMaxAlertsPerBatch = options.maxAlertsPerBatch;
		this.customMaxAlertsPerWindow = options.maxAlertsPerWindow;
		this.customWindowMs = options.windowMs;

		this.alertsDelivered = 0;
		this.alertsThrottled = 0;
		this.windowStartedAt = Date.now();
	}

	getMaxAlertsPerBatch() {
		if (typeof this.customMaxAlertsPerBatch === 'number') {
			return this.customMaxAlertsPerBatch;
		}
		const runtimeConfig = getRemoteConfig();
		if (typeof runtimeConfig.NEWS_MAX_ALERTS_PER_BATCH === 'number') {
			return runtimeConfig.NEWS_MAX_ALERTS_PER_BATCH;
		}
		return parseNewsMaxAlertsPerBatch(process.env.NEWS_MAX_ALERTS_PER_BATCH, 10);
	}

	getMaxAlertsPerWindow() {
		if (typeof this.customMaxAlertsPerWindow === 'number') {
			return this.customMaxAlertsPerWindow;
		}
		const runtimeConfig = getRemoteConfig();
		if (typeof runtimeConfig.NEWS_MAX_ALERTS_PER_WINDOW === 'number') {
			return runtimeConfig.NEWS_MAX_ALERTS_PER_WINDOW;
		}
		return parseNewsMaxAlertsPerWindow(process.env.NEWS_MAX_ALERTS_PER_WINDOW, 20);
	}

	getWindowMs() {
		if (typeof this.customWindowMs === 'number') {
			return this.customWindowMs;
		}
		const runtimeConfig = getRemoteConfig();
		if (typeof runtimeConfig.NEWS_MAX_ALERTS_PER_WINDOW_MS === 'number') {
			return runtimeConfig.NEWS_MAX_ALERTS_PER_WINDOW_MS;
		}
		return parseNewsMaxAlertsPerWindowMs(process.env.NEWS_MAX_ALERTS_PER_WINDOW_MS, 300000);
	}

	checkAndResetWindow(now = Date.now()) {
		const windowMs = this.getWindowMs();
		if (now >= this.windowStartedAt + windowMs) {
			this.alertsDelivered = 0;
			this.alertsThrottled = 0;
			this.windowStartedAt = now;
		}
	}

	recordDelivered(count = 1, now = Date.now()) {
		if (count <= 0) return;
		this.checkAndResetWindow(now);
		this.alertsDelivered += count;
	}

	recordThrottled(count = 1, now = Date.now()) {
		if (count <= 0) return;
		this.checkAndResetWindow(now);
		this.alertsThrottled += count;
	}

	getRemainingWindowQuota(now = Date.now()) {
		this.checkAndResetWindow(now);
		const maxPerWindow = this.getMaxAlertsPerWindow();
		return Math.max(0, maxPerWindow - this.alertsDelivered);
	}

	getEffectiveBatchCapacity(now = Date.now()) {
		const remainingInWindow = this.getRemainingWindowQuota(now);
		const maxPerBatch = this.getMaxAlertsPerBatch();
		return Math.min(maxPerBatch, remainingInWindow);
	}

	getWindowUsage(now = Date.now()) {
		this.checkAndResetWindow(now);
		return {
			alertsDelivered: this.alertsDelivered,
			alertsThrottled: this.alertsThrottled,
			windowResetsAt: new Date(this.windowStartedAt + this.getWindowMs()).toISOString(),
		};
	}

	resetForTesting(now = Date.now()) {
		this.alertsDelivered = 0;
		this.alertsThrottled = 0;
		this.windowStartedAt = now;
	}
}

let defaultVolumeTracker = null;

function getVolumeTracker() {
	if (!defaultVolumeTracker) {
		defaultVolumeTracker = new NewsAlertVolumeTracker();
	}
	return defaultVolumeTracker;
}

function resetVolumeTrackerForTesting(now = Date.now()) {
	if (defaultVolumeTracker) {
		defaultVolumeTracker.resetForTesting(now);
	}
}

module.exports = {
	NewsAlertVolumeTracker,
	getVolumeTracker,
	resetVolumeTrackerForTesting,
	parseNewsMaxAlertsPerBatch,
	parseNewsMaxAlertsPerWindow,
	parseNewsMaxAlertsPerWindowMs,
};
