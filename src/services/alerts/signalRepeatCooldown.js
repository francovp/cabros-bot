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

function getEntryFiredAt(entry) {
	if (Number.isFinite(entry)) {
		return entry;
	}
	return entry && Number.isFinite(entry.firedAt) ? entry.firedAt : null;
}

function getBarMsFromKey(key) {
	const timeframe = String(key || '').split('|')[2];
	const mappedTimeframe = Object.keys(TIMEFRAME_BAR_MS).find((candidate) => candidate.toLowerCase() === timeframe);
	return mappedTimeframe ? TIMEFRAME_BAR_MS[mappedTimeframe] : null;
}

function getWindowMsForKey(key) {
	const barMs = getBarMsFromKey(key);
	return Number.isFinite(barMs) ? resolveCooldownBars() * barMs : null;
}

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
		lastFired = getEntryFiredAt(this.store.get(key));
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

function reserve(signal, channels = [], now = Date.now()) {
	const bars = resolveCooldownBars();
	const barMs = TIMEFRAME_BAR_MS[signal && signal.timeframe];
	if (!Number.isFinite(barMs)) {
		return { suppressed: false, channels };
	}
	const key = buildSignalKey(signal);
	if (!key) {
		return { suppressed: false, channels };
	}

	const requestedChannels = Array.from(new Set(
		(Array.isArray(channels) && channels.length > 0 ? channels : ['*']).map(String),
	));
	const windowMs = bars * barMs;
	try {
		const current = this.store.get(key);
		const entry = Number.isFinite(current)
			? { firedAt: current, channels: null }
			: current;
		const currentFiredAt = getEntryFiredAt(entry);
		const currentIsActive = Number.isFinite(currentFiredAt)
			&& now - currentFiredAt >= 0
			&& now - currentFiredAt < windowMs;

		if (entry && entry.channels instanceof Map && currentIsActive) {
			const availableChannels = requestedChannels.filter((channel) => {
				const firedAt = entry.channels.get(channel);
				return !Number.isFinite(firedAt) || now - firedAt < 0 || now - firedAt >= windowMs;
			});
			if (availableChannels.length === 0) {
				return {
					suppressed: true,
					key,
					windowMs,
					elapsedMs: now - currentFiredAt,
					retryInMs: Math.max(0, windowMs - (now - currentFiredAt)),
				};
			}
			for (const channel of availableChannels) {
				entry.channels.set(channel, now);
			}
			entry.firedAt = now;
			this.store.set(key, entry);
			evictIfNeeded.call(this, now);
			return { suppressed: false, key, windowMs, channels: availableChannels };
		}

		if (entry && currentIsActive) {
			return {
				suppressed: true,
				key,
				windowMs,
				elapsedMs: now - currentFiredAt,
				retryInMs: Math.max(0, windowMs - (now - currentFiredAt)),
			};
		}

		const nextEntry = {
			firedAt: now,
			channels: new Map(requestedChannels.map(channel => [channel, now])),
		};
		this.store.set(key, nextEntry);
		evictIfNeeded.call(this, now);
		return { suppressed: false, key, windowMs, channels: requestedChannels };
	} catch (error) {
		console.warn('[SignalRepeatCooldown] Store reservation failed, failing open:', error.message);
		return { suppressed: false, key, windowMs, channels: requestedChannels, storeError: true };
	}
}

function clearOpposite(key) {
	const opposite = oppositeKeyOf(key);
	if (opposite) {
		this.store.delete(opposite);
	}
}

function clearOppositeChannels(key, successfulChannels) {
	const opposite = oppositeKeyOf(key);
	if (!opposite || successfulChannels.length === 0) {
		return;
	}
	const entry = this.store.get(opposite);
	if (!entry) {
		return;
	}
	if (!(entry.channels instanceof Map)) {
		this.store.delete(opposite);
		return;
	}
	for (const channel of successfulChannels) {
		entry.channels.delete(channel);
	}
	if (entry.channels.size === 0) {
		this.store.delete(opposite);
		return;
	}
	entry.firedAt = Math.max(...entry.channels.values());
	this.store.set(opposite, entry);
}

function finalize(key, reservedChannels = [], successfulChannels = []) {
	if (!key) {
		return;
	}
	try {
		const entry = this.store.get(key);
		if (!entry || !(entry.channels instanceof Map)) {
			return;
		}
		const successful = new Set(successfulChannels);
		for (const channel of reservedChannels) {
			if (!successful.has(channel)) {
				entry.channels.delete(channel);
			}
		}
		if (entry.channels.size === 0) {
			this.store.delete(key);
		} else {
			entry.firedAt = Math.max(...entry.channels.values());
			this.store.set(key, entry);
		}
		clearOppositeChannels.call(this, key, successful);
	} catch (error) {
		console.warn('[SignalRepeatCooldown] Store finalization failed:', error.message);
	}
}

function release(key, channels = []) {
	if (!key || !Array.isArray(channels) || channels.length === 0) {
		return;
	}
	try {
		const entry = this.store.get(key);
		if (!entry || !(entry.channels instanceof Map)) {
			return;
		}
		for (const channel of channels) {
			entry.channels.delete(channel);
		}
		if (entry.channels.size === 0) {
			this.store.delete(key);
		} else {
			entry.firedAt = Math.max(...entry.channels.values());
			this.store.set(key, entry);
		}
	} catch (error) {
		console.warn('[SignalRepeatCooldown] Store release failed:', error.message);
	}
}

function recordFire(key, now = Date.now()) {
	if (!key) {
		return;
	}
	try {
		this.store.set(key, { firedAt: now, channels: null });
		clearOpposite.call(this, key);
	} catch (error) {
		// Storage write failure must never break alert flow.
		console.warn('[SignalRepeatCooldown] Store write failed:', error.message);
		return;
	}
	evictIfNeeded.call(this, now);
}

function evictIfNeeded(now = Date.now()) {
	for (const [key, entry] of this.store.entries()) {
		const firedAt = getEntryFiredAt(entry);
		const windowMs = getWindowMsForKey(key);
		if (!Number.isFinite(firedAt) || !Number.isFinite(windowMs) || now - firedAt >= windowMs) {
			this.store.delete(key);
		}
	}
	if (this.store.size <= MAX_ENTRIES) {
		return;
	}
	const oldest = Array.from(this.store.entries())
		.sort(([, left], [, right]) => getEntryFiredAt(left) - getEntryFiredAt(right));
	for (const [key] of oldest) {
		this.store.delete(key);
		if (this.store.size <= MAX_ENTRIES) break;
	}
}

function getStats(now = Date.now()) {
	const maxWindowMs = MAX_COOLDOWN_BARS * Math.max(...Object.values(TIMEFRAME_BAR_MS));
	let activeEntries = 0;
	try {
		for (const [key, entry] of this.store.entries()) {
			const firedAt = getEntryFiredAt(entry);
			const windowMs = getWindowMsForKey(key) || maxWindowMs;
			if (Number.isFinite(firedAt) && now - firedAt >= 0 && now - firedAt < windowMs) {
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
		reserve: reserve.bind(state),
		finalize: finalize.bind(state),
		release: release.bind(state),
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
	MAX_ENTRIES,
	buildSignalKey,
};
