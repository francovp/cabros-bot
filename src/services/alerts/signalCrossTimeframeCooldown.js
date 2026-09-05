'use strict';

/**
 * Cross-timeframe suppression service for webhook alerts.
 *
 * Suppresses the second of two same-side signals on the same
 * `(exchange, symbol, side)` key when the prior signal arrived on a
 * DIFFERENT timeframe inside `ALERT_CROSS_TF_WINDOW_MS`. Timeframe is
 * intentionally excluded from the key -- that is the only way to catch the
 * `D` + `240` SELL pattern (CB-230 / #522 already keys on
 * `(exchange, symbol, timeframe, side)` and therefore cannot dedupe across
 * timeframes).
 *
 * Semantics mirror `signalRepeatCooldown.js`:
 * - Opposite-side flips are never collapsed; they clear the prior entry.
 * - Suppressed alerts return `suppressedRepeat: true` and
 *   `suppressionReason: "cross_timeframe_duplicate"`, are still persisted
 *   with the marker, and stay available to replay/audit.
 * - All store errors fail open so delivery proceeds as today.
 *
 * The module is opt-in via `ENABLE_ALERT_CROSS_TF_SUPPRESSION=true`. The
 * window `ALERT_CROSS_TF_WINDOW_MS` is bounded `0`-`600000` ms (default
 * `60000`); `0` effectively disables the rule even when the gate is on.
 */

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_WINDOW_MS = 60000;
const MIN_WINDOW_MS = 0;
const MAX_WINDOW_MS = 600000;
const MAX_ENTRIES = 1000;
const SUPPRESSION_REASON = 'cross_timeframe_duplicate';

let monotonicGenerationCounter = 0;
let lastMonotonicGenerationTime = 0;

function nextMonotonicGeneration(nowMs = Date.now()) {
	const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
	if (currentMs > lastMonotonicGenerationTime) {
		lastMonotonicGenerationTime = currentMs;
		monotonicGenerationCounter = 0;
	} else {
		monotonicGenerationCounter += 1;
	}
	return (lastMonotonicGenerationTime * 1000) + (monotonicGenerationCounter % 1000);
}

function buildCrossTimeframeKey({ exchange, symbol, side }) {
	if (!symbol || !side) {
		return null;
	}
	return [
		String(exchange || '').toUpperCase(),
		String(symbol).toUpperCase(),
		String(side).toUpperCase(),
	].join('|');
}

function oppositeKeyOf(key) {
	if (!key || typeof key !== 'string') {
		return null;
	}
	const parts = key.split('|');
	if (parts.length !== 3) {
		return null;
	}
	parts[2] = parts[2] === 'BUY' ? 'SELL' : parts[2] === 'SELL' ? 'BUY' : parts[2];
	return parts.join('|');
}

function resolveWindowMs() {
	const configured = getRuntimeConfig().ALERT_CROSS_TF_WINDOW_MS;
	if (!Number.isFinite(configured)) {
		return DEFAULT_WINDOW_MS;
	}
	return Math.min(Math.max(configured, MIN_WINDOW_MS), MAX_WINDOW_MS);
}

function isWithinWindow(entry, now, windowMs) {
	if (!entry) {
		return false;
	}
	const firedAt = Number.isFinite(entry.firedAt) ? entry.firedAt : null;
	if (!Number.isFinite(firedAt)) {
		return false;
	}
	const elapsedMs = now - firedAt;
	return elapsedMs >= 0 && elapsedMs < windowMs;
}

function clearOpposite(key) {
	const opposite = oppositeKeyOf(key);
	if (opposite) {
		try {
			this.store.delete(opposite);
		} catch (error) {
			console.warn('[SignalCrossTfCooldown] Store clear failed:', error.message);
		}
	}
}

function evictIfNeeded(now = Date.now()) {
	const windowMs = resolveWindowMs();
	try {
		for (const [key, entry] of this.store.entries()) {
			if (!entry || !isWithinWindow(entry, now, windowMs)) {
				this.store.delete(key);
			}
		}
		if (this.store.size <= MAX_ENTRIES) {
			return;
		}
		const oldest = Array.from(this.store.entries())
			.sort(([, left], [, right]) => (left.firedAt || 0) - (right.firedAt || 0));
		for (const [key] of oldest) {
			this.store.delete(key);
			if (this.store.size <= MAX_ENTRIES) break;
		}
	} catch (error) {
		console.warn('[SignalCrossTfCooldown] Store eviction failed:', error.message);
	}
}

function check(signal, now = Date.now()) {
	const windowMs = resolveWindowMs();
	if (windowMs <= 0) {
		return { suppressed: false };
	}
	const key = buildCrossTimeframeKey(signal);
	if (!key) {
		return { suppressed: false };
	}

	let entry = null;
	try {
		entry = this.store.get(key) || null;
	} catch (error) {
		console.warn('[SignalCrossTfCooldown] Store read failed, failing open:', error.message);
		return { suppressed: false, key, windowMs };
	}

	if (!entry || !isWithinWindow(entry, now, windowMs)) {
		return { suppressed: false, key, windowMs };
	}

	const incomingTimeframe = signal && signal.timeframe ? String(signal.timeframe) : null;
	const priorTimeframe = entry.timeframe ? String(entry.timeframe) : null;
	const sameTimeframe = incomingTimeframe && priorTimeframe && incomingTimeframe === priorTimeframe;
	const elapsedMs = now - entry.firedAt;
	return {
		suppressed: !sameTimeframe,
		key,
		windowMs,
		priorTimeframe,
		incomingTimeframe,
		elapsedMs,
		retryInMs: Math.max(0, windowMs - elapsedMs),
		reason: SUPPRESSION_REASON,
	};
}

function record(signal, now = Date.now()) {
	const windowMs = resolveWindowMs();
	if (windowMs <= 0) {
		return null;
	}
	const key = buildCrossTimeframeKey(signal);
	if (!key) {
		return null;
	}

	const timeframe = signal && signal.timeframe ? String(signal.timeframe) : null;
	const generation = nextMonotonicGeneration(now);
	const entry = { firedAt: now, timeframe, generation };

	try {
		this.store.set(key, entry);
	} catch (error) {
		console.warn('[SignalCrossTfCooldown] Store write failed, failing open:', error.message);
		return { key, windowMs, generation, storeError: true };
	}
	clearOpposite.call(this, key);
	evictIfNeeded.call(this, now);
	return { key, windowMs, generation };
}

function recordSuppression() {
	this.suppressedCount += 1;
	this.lastSuppressedAt = new Date().toISOString();
}

function getStats(now = Date.now()) {
	const windowMs = resolveWindowMs();
	let activeEntries = 0;
	try {
		for (const entry of this.store.values()) {
			if (isWithinWindow(entry, now, windowMs)) {
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

function createSignalCrossTimeframeCooldown(options = {}) {
	const store = options.store instanceof Map ? options.store : new Map();
	const state = {
		store,
		suppressedCount: 0,
		lastSuppressedAt: null,
	};

	return {
		suppressionReason: SUPPRESSION_REASON,
		isEnabled() {
			return getRuntimeConfig().ENABLE_ALERT_CROSS_TF_SUPPRESSION === true;
		},
		resolveWindowMs,
		buildKey: buildCrossTimeframeKey,
		check: check.bind(state),
		record: record.bind(state),
		recordSuppression: recordSuppression.bind(state),
		getStats: getStats.bind(state),
		reset() {
			store.clear();
			state.suppressedCount = 0;
			state.lastSuppressedAt = null;
		},
	};
}

const singleton = createSignalCrossTimeframeCooldown();

module.exports = {
	createSignalCrossTimeframeCooldown,
	signalCrossTimeframeCooldown: singleton,
	SUPPRESSION_REASON,
	DEFAULT_WINDOW_MS,
	MIN_WINDOW_MS,
	MAX_WINDOW_MS,
	MAX_ENTRIES,
	buildCrossTimeframeKey,
	nextMonotonicGeneration,
};
