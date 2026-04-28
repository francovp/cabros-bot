/**
 * News Monitor Cache Module
 * Handles in-memory deduplication with TTL support
 * Key format: "${symbol}:${eventCategory}"
 */

class NewsCache {
	constructor() {
		this.cache = new Map();
		this.ttlMs = (process.env.NEWS_CACHE_TTL_HOURS || 6) * 60 * 60 * 1000;
		this.cleanupInterval = null;
	}

	/**
   * Initialize cache with periodic cleanup
   */
	initialize() {
		// Cleanup every 1 hour
		this.cleanupInterval = setInterval(() => {
			this.cleanup();
		}, 60 * 60 * 1000);
		console.debug('[NewsCache] Initialized with TTL:', this.ttlMs / 1000 / 60 / 60, 'hours');
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
   * Get cached analysis result if valid
   * @param {string} symbol - Financial symbol
   * @param {string} eventCategory - Event category
   * @returns {Object|null} Cached analysis data or null if not found/expired
   */
	get(symbol, eventCategory) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);

		if (!entry) {
			return null;
		}

		if (this.isExpired(entry)) {
			this.cache.delete(key);
			return null;
		}

		return entry.data;
	}

	/**
   * Store analysis result in cache
   * @param {string} symbol - Financial symbol
   * @param {string} eventCategory - Event category
   * @param {Object} data - Analysis data to cache
   */
	set(symbol, eventCategory, data) {
		const key = this.generateKey(symbol, eventCategory);
		this.cache.set(key, {
			key,
			timestamp: Date.now(),
			data,
		});
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
