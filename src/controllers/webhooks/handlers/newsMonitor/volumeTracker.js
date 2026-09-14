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

		this.deliveries = [];
		this.throttled = [];
		this.reservations = [];
	}

	getMaxAlertsPerBatch() {
		if (typeof this.customMaxAlertsPerBatch === 'number') {
			return this.customMaxAlertsPerBatch;
		}
		if (typeof this.maxAlertsPerBatch === 'number') {
			return this.maxAlertsPerBatch;
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
		if (typeof this.maxAlertsPerWindow === 'number') {
			return this.maxAlertsPerWindow;
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
		if (typeof this.windowMs === 'number') {
			return this.windowMs;
		}
		const runtimeConfig = getRemoteConfig();
		if (typeof runtimeConfig.NEWS_MAX_ALERTS_PER_WINDOW_MS === 'number') {
			return runtimeConfig.NEWS_MAX_ALERTS_PER_WINDOW_MS;
		}
		return parseNewsMaxAlertsPerWindowMs(process.env.NEWS_MAX_ALERTS_PER_WINDOW_MS, 300000);
	}

	prune(now = Date.now()) {
		const windowMs = this.getWindowMs();
		const cutoff = now - windowMs;
		while (this.deliveries.length > 0 && this.deliveries[0] <= cutoff) {
			this.deliveries.shift();
		}
		while (this.throttled.length > 0 && this.throttled[0] <= cutoff) {
			this.throttled.shift();
		}
		while (this.reservations.length > 0 && this.reservations[0].expiresAt <= now) {
			this.reservations.shift();
		}
	}

	getReservedCount(now = Date.now()) {
		this.prune(now);
		return this.reservations.reduce((sum, r) => sum + r.count, 0);
	}

	getRemainingWindowQuota(now = Date.now()) {
		this.prune(now);
		const maxPerWindow = this.getMaxAlertsPerWindow();
		const activeUsage = this.deliveries.length + this.getReservedCount(now);
		return Math.max(0, maxPerWindow - activeUsage);
	}

	getEffectiveBatchCapacity(now = Date.now()) {
		const remainingInWindow = this.getRemainingWindowQuota(now);
		const maxPerBatch = this.getMaxAlertsPerBatch();
		return Math.min(maxPerBatch, remainingInWindow);
	}

	reserveCapacity(count, now = Date.now(), ttlMs = null) {
		if (count <= 0) return null;
		this.prune(now);
		const remaining = this.getRemainingWindowQuota(now);
		const toReserve = Math.min(count, remaining);
		if (toReserve <= 0) return null;
		const effectiveTtl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : Math.max(this.getWindowMs(), 600000);
		const reservation = {
			id: Math.random().toString(36).substring(2) + Date.now().toString(36),
			count: toReserve,
			expiresAt: now + effectiveTtl,
		};
		this.reservations.push(reservation);
		return reservation;
	}

	renewReservation(reservation, now = Date.now(), ttlMs = null) {
		if (!reservation) return;
		const r = this.reservations.find((item) => item.id === reservation.id);
		if (r) {
			const effectiveTtl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : Math.max(this.getWindowMs(), 600000);
			r.expiresAt = now + effectiveTtl;
			reservation.expiresAt = r.expiresAt;
		}
	}

	commitReservation(reservation, deliveredCount = null, now = Date.now()) {
		if (!reservation) return;
		this.prune(now);
		const idx = this.reservations.findIndex((r) => r.id === reservation.id);
		if (idx !== -1) {
			this.reservations.splice(idx, 1);
		}
		const actualDelivered = typeof deliveredCount === 'number' ? deliveredCount : reservation.count;
		for (let i = 0; i < actualDelivered; i++) {
			this.deliveries.push(now);
		}
	}

	releaseReservation(reservation, now = Date.now()) {
		if (!reservation) return;
		this.prune(now);
		const idx = this.reservations.findIndex((r) => r.id === reservation.id);
		if (idx !== -1) {
			this.reservations.splice(idx, 1);
		}
	}

	recordDelivered(count = 1, now = Date.now()) {
		if (count <= 0) return;
		this.prune(now);
		for (let i = 0; i < count; i++) {
			this.deliveries.push(now);
		}
	}

	recordThrottled(count = 1, now = Date.now()) {
		if (count <= 0) return;
		this.prune(now);
		for (let i = 0; i < count; i++) {
			this.throttled.push(now);
		}
	}

	getWindowUsage(now = Date.now()) {
		this.prune(now);
		const windowMs = this.getWindowMs();
		let resetsAtMs;
		if (this.deliveries.length > 0) {
			resetsAtMs = this.deliveries[0] + windowMs;
		} else {
			resetsAtMs = now + windowMs;
		}
		return {
			alertsDelivered: this.deliveries.length,
			alertsThrottled: this.throttled.length,
			windowResetsAt: new Date(resetsAtMs).toISOString(),
		};
	}

	resetForTesting(now = Date.now()) {
		this.deliveries = [];
		this.throttled = [];
		this.reservations = [];
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
