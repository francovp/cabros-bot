'use strict';

/**
 * PriceQuoteCache — bounded, process-local TTL cache for `/precio` quotes.
 *
 * Goal
 *   Cut provider quota burn (Twelve Data RPM, Binance weight) and repeated-query
 *   latency for chat replies without changing public contracts.
 *
 * Design
 *   - Two TTL buckets (crypto and equity) so chat tolerance (~15 s for crypto,
 *     ~60 s for equities) maps cleanly to provider pacing without one overriding
 *     the other.
 *   - Bounded size with LRU eviction to honor the project precedent set by
 *     issue #689 — unbounded growth is forbidden.
 *   - Fail-open: provider errors are never cached; cache misses always fall
 *     through to the caller. Storage failures are logged, never thrown.
 *   - Process-local only (matches the existing in-memory news/cache pattern);
 *     cross-replica freshness is out of scope.
 *
 * Public surface
 *   - get(key)         → cached entry or null
 *   - set(key, value)  → bounded write, no-ops on storage errors
 *   - invalidate(key)  → remove one key
 *   - clear()          → remove all keys (test-only)
 *   - getStats()       → counters for /api/status exposure
 *   - getStatus()      → safe metadata for /api/status exposure
 */

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_TTL_MS_CRYPTO = 15000;        // 15 s — chat tolerance for crypto
const DEFAULT_TTL_MS_EQUITY = 60000;        // 60 s — chat tolerance for equities
const MAX_ENTRIES_PER_BUCKET = 256;         // mirrors scanner preset precedent
const MAX_KEY_LENGTH = 128;                  // avoid unbounded keys / DoS

const BUCKET_PROVIDERS = Object.freeze({
	CRYPTO: 'crypto',
	EQUITY: 'equity',
});

function parsePositiveInteger(value, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

function clampInt(value, min, max, fallback) {
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		return fallback;
	}
	return Math.max(min, Math.min(value, max));
}

function resolveBucketConfig(provider) {
	const rc = getRuntimeConfig?.() || {};
	if (provider === BUCKET_PROVIDERS.CRYPTO) {
		const ttl = clampInt(
			parsePositiveInteger(rc.PRICE_CACHE_TTL_MS_CRYPTO, DEFAULT_TTL_MS_CRYPTO),
			1000,
			600000,
			DEFAULT_TTL_MS_CRYPTO
		);
		const max = clampInt(
			parsePositiveInteger(rc.PRICE_CACHE_MAX_ENTRIES_PER_BUCKET, MAX_ENTRIES_PER_BUCKET),
			1,
			10000,
			MAX_ENTRIES_PER_BUCKET
		);
		return { ttlMs: ttl, maxEntries: max };
	}
	if (provider === BUCKET_PROVIDERS.EQUITY) {
		const ttl = clampInt(
			parsePositiveInteger(rc.PRICE_CACHE_TTL_MS_EQUITY, DEFAULT_TTL_MS_EQUITY),
			1000,
			600000,
			DEFAULT_TTL_MS_EQUITY
		);
		const max = clampInt(
			parsePositiveInteger(rc.PRICE_CACHE_MAX_ENTRIES_PER_BUCKET, MAX_ENTRIES_PER_BUCKET),
			1,
			10000,
			MAX_ENTRIES_PER_BUCKET
		);
		return { ttlMs: ttl, maxEntries: max };
	}
	return { ttlMs: DEFAULT_TTL_MS_CRYPTO, maxEntries: MAX_ENTRIES_PER_BUCKET };
}

function normalizeKey(provider, symbol) {
	if (typeof symbol !== 'string') return null;
	const trimmed = symbol.trim().toUpperCase();
	if (!trimmed) return null;
	const key = `${provider}:${trimmed}`;
	return key.length > MAX_KEY_LENGTH ? null : key;
}

function createBucket() {
	return new Map();
}

function evictIfNeeded(bucket, maxEntries) {
	if (bucket.size <= maxEntries) return 0;
	const overflow = bucket.size - maxEntries;
	let removed = 0;
	// Map iteration order = insertion order; drop the oldest entries to bound size.
	for (const key of bucket.keys()) {
		if (removed >= overflow) break;
		bucket.delete(key);
		removed += 1;
	}
	return removed;
}

const buckets = {
	crypto: createBucket(),
	equity: createBucket(),
};

const counters = {
	crypto: { hits: 0, misses: 0, sets: 0, evictions: 0, errors: 0 },
	equity: { hits: 0, misses: 0, sets: 0, evictions: 0, errors: 0 },
};

let disabled = false;

function setDisabled(next) {
	disabled = next === true;
	if (disabled) {
		buckets.crypto.clear();
		buckets.equity.clear();
	}
}

function isEnabled() {
	return !disabled;
}

function pickBucket(provider) {
	if (provider === BUCKET_PROVIDERS.CRYPTO) return buckets.crypto;
	if (provider === BUCKET_PROVIDERS.EQUITY) return buckets.equity;
	return null;
}

function pickCounters(provider) {
	if (provider === BUCKET_PROVIDERS.CRYPTO) return counters.crypto;
	if (provider === BUCKET_PROVIDERS.EQUITY) return counters.equity;
	return null;
}

function get(provider, symbol) {
	if (disabled) return null;
	const bucket = pickBucket(provider);
	const stats = pickCounters(provider);
	if (!bucket || !stats) return null;
	const key = normalizeKey(provider, symbol);
	if (!key) return null;

	let entry;
	try {
		entry = bucket.get(key);
	} catch (e) {
		stats.errors += 1;
		console.warn(`[PriceQuoteCache] get() failed for ${provider} ${symbol}:`, e.message);
		return null;
	}

	if (!entry) {
		stats.misses += 1;
		return null;
	}
	if (typeof entry.expiresAt !== 'number' || entry.expiresAt <= Date.now()) {
		bucket.delete(key);
		stats.misses += 1;
		return null;
	}
	stats.hits += 1;
	// refresh LRU order: re-insert to move to the most-recent end
	bucket.delete(key);
	bucket.set(key, entry);
	return entry.value;
}

function setValue(provider, symbol, value) {
	if (disabled) return false;
	const bucket = pickBucket(provider);
	const stats = pickCounters(provider);
	if (!bucket || !stats) return false;
	if (value === undefined || value === null) return false;

	const key = normalizeKey(provider, symbol);
	if (!key) return false;

	const { ttlMs, maxEntries } = resolveBucketConfig(provider);
	const expiresAt = Date.now() + ttlMs;

	try {
		bucket.delete(key);
		bucket.set(key, { value, expiresAt });
		stats.sets += 1;
		const evicted = evictIfNeeded(bucket, maxEntries);
		stats.evictions += evicted;
		return true;
	} catch (e) {
		stats.errors += 1;
		console.warn(`[PriceQuoteCache] set() failed for ${provider} ${symbol}:`, e.message);
		return false;
	}
}

function invalidate(provider, symbol) {
	if (disabled) return false;
	const bucket = pickBucket(provider);
	if (!bucket) return false;
	const key = normalizeKey(provider, symbol);
	if (!key) return false;
	return bucket.delete(key);
}

function clearAll() {
	buckets.crypto.clear();
	buckets.equity.clear();
	counters.crypto = { hits: 0, misses: 0, sets: 0, evictions: 0, errors: 0 };
	counters.equity = { hits: 0, misses: 0, sets: 0, evictions: 0, errors: 0 };
}

function getStats() {
	return {
		disabled,
		crypto: { ...counters.crypto, size: buckets.crypto.size },
		equity: { ...counters.equity, size: buckets.equity.size },
	};
}

function getStatus() {
	const cryptoCfg = resolveBucketConfig(BUCKET_PROVIDERS.CRYPTO);
	const equityCfg = resolveBucketConfig(BUCKET_PROVIDERS.EQUITY);
	const stats = getStats();
	return {
		enabled: isEnabled(),
		disabled,
		mode: 'in-memory',
		storage: 'memory',
		ttlMs: {
			crypto: cryptoCfg.ttlMs,
			equity: equityCfg.ttlMs,
		},
		maxEntriesPerBucket: cryptoCfg.maxEntries,
		buckets: {
			crypto: {
				size: stats.crypto.size,
				hits: stats.crypto.hits,
				misses: stats.crypto.misses,
				sets: stats.crypto.sets,
				evictions: stats.crypto.evictions,
				errors: stats.crypto.errors,
			},
			equity: {
				size: stats.equity.size,
				hits: stats.equity.hits,
				misses: stats.equity.misses,
				sets: stats.equity.sets,
				evictions: stats.equity.evictions,
				errors: stats.equity.errors,
			},
		},
	};
}

function _resetForTesting() {
	clearAll();
	disabled = false;
}

module.exports = {
	PROVIDERS: BUCKET_PROVIDERS,
	DEFAULT_TTL_MS_CRYPTO,
	DEFAULT_TTL_MS_EQUITY,
	MAX_ENTRIES_PER_BUCKET,
	get,
	set: setValue,
	clear: clearAll,
	invalidate,
	setDisabled,
	isEnabled,
	getStats,
	getStatus,
	_resetForTesting,
};