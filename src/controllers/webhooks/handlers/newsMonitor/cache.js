/**
 * News Monitor Cache Module
 * Handles deduplication with TTL support.
 *
 * When ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP=true the cache writes entries to
 * both the in-memory Map AND Firestore (via NewsDedupStorageService). Reads
 * check the in-memory Map first, then fall back to Firestore so cross-replica
 * duplicates are suppressed even if the current replica has never seen the key.
 *
 * When the env var is false/absent the behaviour is identical to the original
 * in-memory-only implementation — no external I/O at all.
 *
 * Key format: "${symbol}:${eventCategory}"
 */

const newsDedupStorageService = require('../../../../services/storage/NewsDedupStorageService');

class NewsCache {
	constructor() {
		this.cache = new Map();
		this.ttlMs = (process.env.NEWS_CACHE_TTL_HOURS || 6) * 60 * 60 * 1000;
		this.cleanupInterval = null;
	}

	/**
   * Returns the active deduplication mode.
   * @returns {{ mode: 'persistent'|'in-memory', backend: 'firestore'|null }}
   */
	get dedupMode() {
		return newsDedupStorageService.isEnabled()
			? { mode: 'persistent', backend: 'firestore' }
			: { mode: 'in-memory', backend: null };
	}

	/**
   * Initialize cache with periodic cleanup
   */
	initialize() {
		// Cleanup every 1 hour
		this.cleanupInterval = setInterval(() => {
			this.cleanup();
		}, 60 * 60 * 1000);
		const mode = this.dedupMode;
		console.debug('[NewsCache] Initialized with TTL:', this.ttlMs / 1000 / 60 / 60, 'hours | dedup mode:', mode.mode, '| backend:', mode.backend);
	}

	/**
   * Generate cache key from symbol and event category
   * @param {string} symbol - Financial symbol
   * @param {string} eventCategory - Event category
   * @returns {string} Cache key
   */
	generateKey(symbol, eventCategory) {
		return `${symbol}:${eventCategory}`;
	}

	/**
   * Check if cache entry is expired
   * @param {Object} entry - Cache entry with timestamp
   * @returns {boolean} True if expired
   */
	isExpired(entry) {
		return Date.now() - entry.timestamp > this.ttlMs;
	}

	/**
   * Get cached analysis result if valid.
   *
   * Check order:
   *   1. In-memory Map (fast path)
   *   2. If not found locally AND persistent dedup is enabled -> Firestore
   *
   * @param {string} symbol - Financial symbol
   * @param {string} eventCategory - Event category
   * @returns {Promise<Object|null>} Cached analysis data or null if not found/expired
   */
	async get(symbol, eventCategory) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);

		if (entry) {
			if (this.isExpired(entry)) {
				this.cache.delete(key);
				// Fall through to Firestore check below
			} else {
				return entry.data;
			}
		}

		// Persistent dedup: check Firestore for cross-replica hits
		if (newsDedupStorageService.isEnabled()) {
			try {
				const exists = await newsDedupStorageService.hasEntry(key);
				if (exists) {
					// Warm the local cache to avoid repeated Firestore lookups
					this.cache.set(key, {
						key,
						timestamp: Date.now(),
						data: { _dedupSource: 'firestore' },
					});
					return { _dedupSource: 'firestore' };
				}
			} catch (error) {
				console.warn('[NewsCache] Firestore hasEntry failed (fail-open):', error.message);
			}
		}

		return null;
	}

	/**
   * Store analysis result in cache.
   *
   * Writes to the in-memory Map. When persistent dedup is enabled, also writes
   * to Firestore asynchronously (fire-and-forget, fail-open).
   *
   * @param {string} symbol - Financial symbol
   * @param {string} eventCategory - Event category
   * @param {Object} data - Analysis data to cache
   * @returns {Promise<void>}
   */
	async set(symbol, eventCategory, data) {
		const key = this.generateKey(symbol, eventCategory);
		this.cache.set(key, {
			key,
			timestamp: Date.now(),
			data,
		});

		// Persistent dedup: write to Firestore (fail-open)
		if (newsDedupStorageService.isEnabled()) {
			newsDedupStorageService.setEntry(key, this.ttlMs).catch(err => {
				console.warn('[NewsCache] Firestore setEntry failed (fail-open):', err.message);
			});
		}
	}

	/**
   * Remove expired entries from cache
   * Called periodically by setInterval
   */
	cleanup() {
		let removed = 0;
		for (const [key, entry] of this.cache.entries()) {
			if (this.isExpired(entry)) {
				this.cache.delete(key);
				removed++;
			}
		}
		if (removed > 0) {
			console.debug('[NewsCache] Cleanup removed', removed, 'expired entries. Cache size:', this.cache.size);
		}
	}

	/**
   * Clear all cache entries (mainly for testing)
   */
	clear() {
		this.cache.clear();
	}

	/**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
	getStats() {
		return {
			size: this.cache.size,
			ttlHours: this.ttlMs / 1000 / 60 / 60,
			entries: Array.from(this.cache.keys()),
			deduplication: this.dedupMode,
		};
	}

	/**
   * Shutdown cache (stop cleanup interval)
   */
	shutdown() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
			console.debug('[NewsCache] Shutdown complete');
		}
	}
}

// Singleton instance
let instance = null;

function getCacheInstance() {
	if (!instance) {
		instance = new NewsCache();
	}
	return instance;
}

module.exports = {
	getCacheInstance,
	NewsCache,
};
