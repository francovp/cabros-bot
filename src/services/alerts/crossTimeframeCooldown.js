'use strict';

/**
 * Cross-timeframe duplicate suppression for webhook alerts.
 *
 * CB-230 (`signalRepeatCooldown`) keys on `(exchange, symbol, timeframe, side)`,
 * so it cannot collapse the pattern observed in issue #1103: the same symbol
 * firing the same direction on two different timeframes seconds apart
 * (`BINANCE:BTCUSDT(D)` VENTA followed by `BINANCE:BTCUSDT(240)` VENTA ~400ms
 * later), which produced two Telegram + two WhatsApp + two Discord messages for
 * a single trading idea.
 *
 * This module keys on `(exchange, symbol, side)` — timeframe deliberately
 * excluded — and suppresses the *later* arrival when the same direction already
 * fired inside the window on a different timeframe.
 *
 * Collapse direction: **first arrival reserves, later arrival is suppressed.**
 * Preferring the higher timeframe would require buffering every alert until the
 * window closed before deciding, adding up to `ALERT_CROSS_TF_WINDOW_MS` of
 * latency to a delivery path where the whole point is speed. The first signal to
 * arrive is therefore always delivered and the store records its timeframe, so
 * every same-direction signal on any *other* timeframe inside the window is
 * suppressed against it.
 *
 * Destination scoping mirrors CB-230: the entry keeps one record per
 * `(channel, destination)` identity holding *both* its timestamp and the
 * timeframe it was reserved for, so a reservation made for
 * `telegramChatId: -1001111111` never suppresses a later signal routed to
 * `-1002222222`. The timeframe must live on the per-destination record and not
 * on the entry: a leg that is only partly available is reserved on the free
 * destinations alone, so an entry-level timeframe would be overwritten with the
 * narrowing leg's value and would stop describing the destination that actually
 * received the earlier signal. Suppression is decided per destination against
 * that record, so a leg is collapsed only when *every* requested destination is
 * already held by a different timeframe, and the caller narrows delivery to the
 * still-available ones.
 *
 * Reservations are provisional: `reserve()` returns `reservedAt` and the caller
 * hands it back to `release()` for any destination whose delivery produced
 * nothing (a failed channel, a throwing dispatch, or a deployment that cannot
 * deliver at all). Without that release a leg that notified nobody would swallow
 * the next real signal on a different timeframe for the whole window.
 *
 * Flip protection mirrors CB-230: the side is part of the key, so an opposite
 * flip is never collapsed, and reserving a flip clears the opposite entry so a
 * later same-direction signal is not swallowed by a stale pre-flip record.
 *
 * Suppressed alerts are still persisted by the caller with a
 * `suppressedRepeat: true` + `suppressionReason: "cross_timeframe_duplicate"`
 * marker, so replay and audit stay complete. All store errors fail open: when the
 * in-process store cannot be read or written, delivery proceeds unchanged.
 *
 * The store is process-local, exactly like CB-230's. With multiple replicas
 * each replica may deliver one copy of a collapsed pair; the window is a message
 * volume optimization, not a correctness guarantee.
 */

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_WINDOW_MS = 60000;
const MAX_WINDOW_MS = 600000;
const MAX_ENTRIES = 1000;
const MAX_CHANNELS_PER_ENTRY = 100;
const CROSS_TIMEFRAME_SUPPRESSION_REASON = 'cross_timeframe_duplicate';

function normalizeCrossTimeframe(timeframe) {
	if (timeframe === null || timeframe === undefined) {
		return '';
	}
	return String(timeframe).trim().toLowerCase();
}

function buildCrossTimeframeKey({ exchange, symbol, side } = {}) {
	if (!symbol || !side) {
		return null;
	}
	return [
		String(exchange || '').toUpperCase(),
		String(symbol).toUpperCase(),
		String(side).toUpperCase(),
	].join('|');
}

function oppositeCrossTimeframeKeyOf(key) {
	if (!key || typeof key !== 'string') {
		return null;
	}
	const parts = key.split('|');
	if (parts.length !== 3) {
		return null;
	}
	parts[2] = parts[2] === 'BUY' ? 'SELL' : 'BUY';
	return parts.join('|');
}

function resolveWindowMs() {
	const configured = getRuntimeConfig().ALERT_CROSS_TF_WINDOW_MS;
	if (!Number.isFinite(configured)) {
		return DEFAULT_WINDOW_MS;
	}
	return Math.min(Math.max(Math.trunc(configured), 0), MAX_WINDOW_MS);
}

function getEntryFiredAt(entry) {
	return entry && Number.isFinite(entry.firedAt) ? entry.firedAt : null;
}

function channelFiredAt(held) {
	return held && Number.isFinite(held.firedAt) ? held.firedAt : 0;
}

function latestChannelFiredAt(channels, fallback) {
	let latest = null;
	for (const held of channels.values()) {
		const firedAt = channelFiredAt(held);
		if (Number.isFinite(firedAt) && (latest === null || firedAt > latest)) {
			latest = firedAt;
		}
	}
	return latest === null ? fallback : latest;
}

/**
 * Records the reserved signal and reports whether this arrival was a
 * cross-timeframe duplicate of an already-held one.
 *
 * Reserving before delivery (rather than recording after) is what keeps two
 * near-simultaneous requests from both delivering; the caller already skips
 * delivery entirely on `suppressed: true`. The returned `reservedAt` is the
 * token `release()` matches against, so a later legitimate reservation is never
 * dropped by an earlier leg's rollback.
 */
function reserve(signal, channels = [], now = Date.now()) {
	const key = buildCrossTimeframeKey(signal || {});
	const timeframe = normalizeCrossTimeframe(signal && signal.timeframe);
	if (!key || !timeframe) {
		return { suppressed: false };
	}

	const requestedChannels = Array.from(new Set(
		(Array.isArray(channels) && channels.length > 0 ? channels : ['*']).map(String),
	));
	const windowMs = resolveWindowMs();
	try {
		const current = this.store.get(key);
		const entry = current && current.channels instanceof Map ? current : null;

		const availableChannels = [];
		let conflict = null;
		for (const channel of requestedChannels) {
			const held = entry ? entry.channels.get(channel) : null;
			const heldElapsedMs = held ? now - channelFiredAt(held) : null;
			const heldActive = held
				&& Number.isFinite(heldElapsedMs)
				&& heldElapsedMs >= 0
				&& heldElapsedMs < windowMs;
			// A held destination only conflicts when *it* was reserved for another
			// timeframe; a same-timeframe repeat stays CB-230's job and is never
			// collapsed here. The timeframe lives on the destination's own record
			// because a narrowed leg reserves only the free destinations, so an
			// entry-level field would be overwritten with the narrowing leg's
			// timeframe and would no longer describe the destination that actually
			// holds the earlier signal.
			if (!heldActive || normalizeCrossTimeframe(held.timeframe) === timeframe) {
				availableChannels.push(channel);
				continue;
			}
			if (!conflict) {
				conflict = {
					elapsedMs: heldElapsedMs,
					conflictingTimeframe: normalizeCrossTimeframe(held.timeframe),
				};
			}
		}

		// Collapsed only when every requested destination is already held by a
		// different timeframe; a partly available set is delivered and narrowed by
		// the caller, exactly like CB-230.
		if (conflict && availableChannels.length === 0) {
			return {
				suppressed: true,
				reason: CROSS_TIMEFRAME_SUPPRESSION_REASON,
				key,
				windowMs,
				elapsedMs: conflict.elapsedMs,
				retryInMs: Math.max(0, windowMs - conflict.elapsedMs),
				conflictingTimeframe: conflict.conflictingTimeframe,
				suppressedTimeframe: timeframe,
			};
		}

		// Reserved (or a same-timeframe repeat, which stays CB-230's job): re-arm
		// the available destinations from now so the window slides from the most
		// recent reservation while the still-held ones keep their own deadline and
		// their own timeframe.
		const reservedChannels = entry ? new Map(entry.channels) : new Map();
		for (const channel of availableChannels) {
			reservedChannels.set(channel, { firedAt: now, timeframe });
		}
		trimChannels(reservedChannels);
		this.store.set(key, {
			firedAt: latestChannelFiredAt(reservedChannels, now),
			channels: reservedChannels,
		});
		const opposite = oppositeCrossTimeframeKeyOf(key);
		if (opposite) {
			this.store.delete(opposite);
		}
		evictIfNeeded.call(this, now);
		return { suppressed: false, key, windowMs, channels: availableChannels, reservedAt: now };
	} catch (error) {
		console.warn('[CrossTimeframeCooldown] Store reservation failed, failing open:', error.message);
		return { suppressed: false, key, windowMs, channels: requestedChannels, storeError: true };
	}
}

/**
 * Rolls back a reservation that produced no delivery.
 *
 * `channels` narrows the rollback to specific destination identities; omit it to
 * roll back the whole reservation. Every delete is guarded by `reservedAt`, so a
 * later legitimate reservation for the same key survives an earlier rollback.
 */
function release(key, reservedAt, channels = null) {
	if (!key || !Number.isFinite(reservedAt)) {
		return;
	}
	try {
		const entry = this.store.get(key);
		if (!entry) {
			return;
		}
		if (!(entry.channels instanceof Map)) {
			if (getEntryFiredAt(entry) === reservedAt) {
				this.store.delete(key);
			}
			return;
		}
		const targets = Array.isArray(channels) ? channels : [...entry.channels.keys()];
		let released = false;
		for (const channel of targets) {
			if (channelFiredAt(entry.channels.get(channel)) === reservedAt) {
				entry.channels.delete(channel);
				released = true;
			}
		}
		if (entry.channels.size === 0) {
			this.store.delete(key);
			return;
		}
		if (released) {
			entry.firedAt = latestChannelFiredAt(entry.channels, reservedAt);
			this.store.set(key, entry);
		}
	} catch (error) {
		console.warn('[CrossTimeframeCooldown] Store release failed:', error.message);
	}
}

function trimChannels(reservedChannels) {
	if (reservedChannels.size <= MAX_CHANNELS_PER_ENTRY) {
		return;
	}
	const oldest = [...reservedChannels.entries()]
		.sort(([, left], [, right]) => channelFiredAt(left) - channelFiredAt(right))
		.slice(0, reservedChannels.size - MAX_CHANNELS_PER_ENTRY);
	for (const [channel] of oldest) {
		reservedChannels.delete(channel);
	}
}

function evictIfNeeded(now = Date.now()) {
	const windowMs = resolveWindowMs();
	for (const [key, entry] of this.store.entries()) {
		const firedAt = getEntryFiredAt(entry);
		if (firedAt === null || now - firedAt >= windowMs) {
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
	const windowMs = resolveWindowMs();
	let activeEntries = 0;
	try {
		for (const entry of this.store.values()) {
			const firedAt = getEntryFiredAt(entry);
			if (firedAt !== null && now - firedAt >= 0 && now - firedAt < windowMs) {
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
		windowMs,
	};
}

function createCrossTimeframeCooldown(options = {}) {
	// Duck-typed (not `instanceof Map` like signalRepeatCooldown) so the
	// fail-open path is testable with a Map-compatible throwing store.
	const store = options.store && typeof options.store.get === 'function'
		? options.store
		: new Map();
	const state = {
		store,
		suppressedCount: 0,
		lastSuppressedAt: null,
	};

	return {
		isEnabled() {
			return getRuntimeConfig().ENABLE_ALERT_CROSS_TF_SUPPRESSION === true;
		},
		reserve: reserve.bind(state),
		release: release.bind(state),
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

const singleton = createCrossTimeframeCooldown();

module.exports = {
	createCrossTimeframeCooldown,
	crossTimeframeCooldown: singleton,
	CROSS_TIMEFRAME_SUPPRESSION_REASON,
	DEFAULT_WINDOW_MS,
	MAX_WINDOW_MS,
	MAX_ENTRIES,
	MAX_CHANNELS_PER_ENTRY,
	buildCrossTimeframeKey,
	oppositeCrossTimeframeKeyOf,
	normalizeCrossTimeframe,
};