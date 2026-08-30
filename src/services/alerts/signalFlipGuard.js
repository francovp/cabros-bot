'use strict';

/**
 * Opposite-signal flip guard for webhook alerts.
 *
 * Tracks the most recent fired direction per `(exchange, symbol, timeframe)`
 * and, when an incoming alert carries the opposite side of the last signal
 * inside the configured cooldown window, attaches a `flipContext` annotation
 * describing the previous direction and Δt. Delivery is never blocked
 * (fail-open); the guard only annotates.
 *
 * Storage errors fail open: when the store cannot be read or written, the
 * guard returns `null` and the alert path treats it as a non-flip.
 */

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_COOLDOWN_HOURS = 24;
const MIN_COOLDOWN_HOURS = 1;
const MAX_COOLDOWN_HOURS = 168;
const HOUR_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

function resolveCooldownHours() {
	const configured = getRuntimeConfig().ALERT_FLIP_COOLDOWN_HOURS;
	if (!Number.isFinite(configured)) {
		return DEFAULT_COOLDOWN_HOURS;
	}
	if (configured < MIN_COOLDOWN_HOURS || configured > MAX_COOLDOWN_HOURS) {
		return DEFAULT_COOLDOWN_HOURS;
	}
	return Math.round(configured);
}

function isEnabled() {
	return getRuntimeConfig().ENABLE_ALERT_FLIP_GUARD === true;
}

function buildFlipKey({ exchange, symbol, timeframe }) {
	if (!symbol) {
		return null;
	}
	return [
		String(exchange || '').toUpperCase(),
		String(symbol).toUpperCase(),
		String(timeframe || '').toLowerCase(),
	].join('|');
}

function oppositeOf(side) {
	if (side === 'BUY') return 'SELL';
	if (side === 'SELL') return 'BUY';
	return null;
}

function safeRead(store, key) {
	if (!store || typeof store.get !== 'function') return null;
	try {
		return store.get(key);
	} catch (error) {
		console.warn('[SignalFlipGuard] Store read failed, failing open:', error.message);
		return null;
	}
}

function safeWrite(store, key, value) {
	if (!store || typeof store.set !== 'function') return false;
	try {
		store.set(key, value);
		return true;
	} catch (error) {
		console.warn('[SignalFlipGuard] Store write failed, failing open:', error.message);
		return false;
	}
}

function recordFire(signal, now = Date.now()) {
	if (!signal || !signal.side) {
		return null;
	}
	const key = buildFlipKey(signal);
	if (!key) {
		return null;
	}
	const side = String(signal.side).toUpperCase();
	const entry = {
		side,
		firedAt: now,
	};
	safeWrite(this.store, key, entry);
	evictIfNeeded.call(this, now);
	return key;
}

function evaluate(signal, now = Date.now()) {
	if (!isEnabled()) {
		return { annotated: false };
	}
	if (!signal || !signal.symbol || !signal.side) {
		return { annotated: false };
	}
	const side = String(signal.side).toUpperCase();
	const opposite = oppositeOf(side);
	if (!opposite) {
		return { annotated: false };
	}
	const key = buildFlipKey(signal);
	if (!key) {
		return { annotated: false };
	}

	const windowMs = resolveCooldownHours() * HOUR_MS;
	const entry = safeRead(this.store, key);
	if (!entry || !entry.firedAt || entry.side === side) {
		return { annotated: false, key, windowMs };
	}
	const elapsedMs = now - entry.firedAt;
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= windowMs) {
		return { annotated: false, key, windowMs, previousDirection: entry.side };
	}
	return {
		annotated: true,
		key,
		windowMs,
		previousDirection: entry.side,
		previousAt: entry.firedAt,
		hoursDelta: Math.round((elapsedMs / HOUR_MS) * 10) / 10,
	};
}

function evictIfNeeded(now = Date.now()) {
	const windowMs = resolveCooldownHours() * HOUR_MS;
	const store = this.store;
	if (!store || typeof store.entries !== 'function') {
		return;
	}
	try {
		for (const [key, entry] of store.entries()) {
			if (!entry || !Number.isFinite(entry.firedAt)) {
				store.delete(key);
				continue;
			}
			if (now - entry.firedAt >= windowMs) {
				store.delete(key);
			}
		}
		if (typeof store.size !== 'number' || store.size <= MAX_ENTRIES) {
			return;
		}
		const oldest = Array.from(store.entries())
			.sort(([, left], [, right]) => left.firedAt - right.firedAt);
		for (const [key] of oldest) {
			store.delete(key);
			if (store.size <= MAX_ENTRIES) break;
		}
	} catch (error) {
		console.warn('[SignalFlipGuard] Eviction failed:', error.message);
	}
}

function getStats(now = Date.now()) {
	const windowMs = resolveCooldownHours() * HOUR_MS;
	let activeEntries = 0;
	const store = this.store;
	if (store && typeof store.entries === 'function') {
		try {
			for (const [, entry] of store.entries()) {
				if (!entry || !Number.isFinite(entry.firedAt)) continue;
				if (now - entry.firedAt >= 0 && now - entry.firedAt < windowMs) {
					activeEntries += 1;
				}
			}
		} catch (error) {
			activeEntries = 0;
		}
	}
	return {
		annotatedCount: this.annotatedCount,
		lastAnnotatedAt: this.lastAnnotatedAt,
		activeTrackedKeys: activeEntries,
		cooldownHours: resolveCooldownHours(),
	};
}

function createSignalFlipGuard(options = {}) {
	const store = (options.store && typeof options.store.get === 'function' && typeof options.store.set === 'function')
		? options.store
		: new Map();
	const internal = {
		store,
		annotatedCount: 0,
		lastAnnotatedAt: null,
	};
	return {
		isEnabled,
		resolveCooldownHours,
		buildFlipKey,
		recordFire: recordFire.bind(internal),
		evaluate: evaluate.bind(internal),
		getStats: getStats.bind(internal),
		recordAnnotation() {
			internal.annotatedCount += 1;
			internal.lastAnnotatedAt = new Date().toISOString();
		},
		reset() {
			store.clear();
			internal.annotatedCount = 0;
			internal.lastAnnotatedAt = null;
		},
	};
}

const singleton = createSignalFlipGuard();

module.exports = {
	createSignalFlipGuard,
	signalFlipGuard: singleton,
	DEFAULT_COOLDOWN_HOURS,
	MIN_COOLDOWN_HOURS,
	MAX_COOLDOWN_HOURS,
	HOUR_MS,
	MAX_ENTRIES,
	buildFlipKey,
	oppositeOf,
};