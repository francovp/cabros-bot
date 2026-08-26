'use strict';

/**
 * Signal repeat-cooldown service for webhook alerts.
 *
 * Suppresses duplicate channel delivery for the same
 * `(exchange, symbol, timeframe, side)` signal while the prior signal is
 * still within its cooldown window. Opposite-side flips are always delivered
 * and clear the prior side so BUY → SELL → BUY re-entries are not swallowed.
 * Suppressed alerts remain persisted (with a suppression marker) so replay
 * and audit stay complete. All storage errors fail open: when the store
 * cannot be read or written, delivery proceeds as today.
 */

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const TIMEFRAME_BAR_MS = Object.freeze({
	'5m': 5 * 60 * 1000,
	'15m': 15 * 60 * 1000,
	'1h': 60 * 60 * 1000,
	'4h': 4 * 60 * 60 * 1000,
	'1D': 24 * 60 * 60 * 1000,
	'1W': 7 * 24 * 60 * 60 * 1000,
	'1M': 30 * 24 * 60 * 60 * 1000,
});

const DEFAULT_COOLDOWN_BARS = 1;
const MAX_COOLDOWN_BARS = 10;
const MAX_ENTRIES = 1000;

function resolveCooldownBars() {
	const configured = getRuntimeConfig().ALERT_SIGNAL_COOLDOWN_BARS;
	if (!Number.isFinite(configured)) {
		return DEFAULT_COOLDOWN_BARS;
	}
	return Math.min(Math.max(configured, 1), MAX_COOLDOWN_BARS);
}

function buildSignalKey({ exchange, symbol, timeframe, side }) {
	if (!symbol || !side) {
		return null;
	}
	return [
		String(exchange || '').toUpperCase(),
		String(symbol).toUpperCase(),
		String(timeframe || '').toLowerCase(),
		String(side).toUpperCase(),
	].join('|');
}

function oppositeKeyOf(key) {
	if (!key || typeof key !== 'string') {
		return null;
	}
	const parts = key.split('|');
	if (parts.length !== 4) {
		return null;
	}
	parts[3] = parts[3] === 'BUY' ? 'SELL' : 'BUY';
	return parts.join('|');
}

function isSuppressed(signal, now = Date.now()) {
	const bars = resolveCooldownBars();
	const barMs = TIMEFRAME_BAR_MS[signal && signal.timeframe];
	if (!Number.isFinite(barMs)) {
		return { suppressed: false };
	}
	const key = buildSignalKey(signal);
	if (!key) {
		return { suppressed: false };
	}

	let lastFired = null;
	try {
		lastFired = this.store.get(key);
	} catch (error) {
		console.warn('[SignalRepeatCooldown] Store read failed, failing open:', error.message);
		return { suppressed: false };
	}

	const windowMs = bars * barMs;
	const elapsedMs = lastFired !== undefined && lastFired !== null ? now - lastFired : null;
	if (
		elapsedMs !== null
		&& Number.isFinite(elapsedMs)
		&& elapsedMs >= 0
		&& elapsedMs < windowMs
	) {
		return {
			suppressed: true,
			key,
			windowMs,
			elapsedMs,
			retryInMs: Math.max(0, windowMs - elapsedMs),
		};
	}
	return { suppressed: false, key, windowMs };
}

function recordFire(key, now = Date.now()) {
	if (!key) {
		return;
	}
	try {
		this.store.set(key, now);
		const opposite = oppositeKeyOf(key);
		if (opposite) {
			this.store.delete(opposite);
		}
	} catch (error) {
		// Storage write failure must never break alert flow.
		console.warn('[SignalRepeatCooldown] Store write failed:', error.message);
		return;
	}
	evictIfNeeded.call(this, now);
}

function evictIfNeeded(now = Date.now()) {
	if (this.store.size <= MAX_ENTRIES) {
		return;
	}
	const maxWindowMs = MAX_COOLDOWN_BARS * Math.max(...Object.values(TIMEFRAME_BAR_MS));
	for (const [key, firedAt] of this.store.entries()) {
		if (!Number.isFinite(firedAt) || now - firedAt >= maxWindowMs) {
			this.store.delete(key);
		}
		if (this.store.size <= MAX_ENTRIES) {
			break;
		}
	}
}

function getStats(now = Date.now()) {
	const maxWindowMs = MAX_COOLDOWN_BARS * Math.max(...Object.values(TIMEFRAME_BAR_MS));
	let activeEntries = 0;
	try {
		for (const firedAt of this.store.values()) {
			if (Number.isFinite(firedAt) && now - firedAt >= 0 && now - firedAt < maxWindowMs) {
				activeEntries += 1;
			}
		}
	} catch (error) {
		activeEntries = 0;
	}
	return {
		suppressedCount: this.suppressedCount,
		lastSuppressedAt: this.lastSuppressedAt,
		activeTrackedSignals: activeEntries,
	};
}

function createSignalRepeatCooldown(options = {}) {
	const store = options.store instanceof Map ? options.store : new Map();
	const state = {
		store,
		suppressedCount: 0,
		lastSuppressedAt: null,
	};

	return {
		isEnabled() {
			return getRuntimeConfig().ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION === true;
		},
		isSuppressed: isSuppressed.bind(state),
		recordFire: recordFire.bind(state),
		recordSuppression() {
			state.suppressedCount += 1;
			state.lastSuppressedAt = new Date().toISOString();
		},
		getStats: getStats.bind(state),
		reset() {
			store.clear();
			state.suppressedCount = 0;
			state.lastSuppressedAt = null;
		},
	};
}

const singleton = createSignalRepeatCooldown();

module.exports = {
	createSignalRepeatCooldown,
	signalRepeatCooldown: singleton,
	TIMEFRAME_BAR_MS,
	DEFAULT_COOLDOWN_BARS,
	MAX_COOLDOWN_BARS,
	buildSignalKey,
};
