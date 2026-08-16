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
const { trackBackgroundTask } = require('../../../../lib/backgroundTaskTracker');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { randomUUID } = require('node:crypto');

const DELIVERY_LOCK_TTL_MS = 30_000;
const DELIVERY_LOCK_RENEW_INTERVAL_MS = 10_000;
const DELIVERY_ROUTING_FIELDS = {
	telegram: 'telegramChatId',
	whatsapp: 'whatsappChatId',
	discord: 'discordWebhookFingerprint',
};

function mergeRoutingData(existingRouting = {}, updatedRouting = {}, channels) {
	if (!Array.isArray(channels)) {
		return updatedRouting;
	}

	const mergedRouting = { ...existingRouting };
	if (Object.prototype.hasOwnProperty.call(updatedRouting, 'channels')) {
		mergedRouting.channels = updatedRouting.channels;
	}
	for (const channel of channels) {
		const field = DELIVERY_ROUTING_FIELDS[channel];
		if (field && Object.prototype.hasOwnProperty.call(updatedRouting, field)) {
			mergedRouting[field] = updatedRouting[field];
			if (channel === 'discord') {
				delete mergedRouting.discordWebhookUrl;
			}
		}
	}
	return mergedRouting;
}

function mergeDeliveryData(existingData = {}, updatedData = {}, channels) {
	const deliveryChannels = Array.isArray(channels) ? channels : null;
	if (!deliveryChannels
		&& (!Array.isArray(existingData.deliveryResults) || !Array.isArray(updatedData.deliveryResults))) {
		return updatedData;
	}
	const updatedResults = deliveryChannels
		? (Array.isArray(updatedData.deliveryResults) ? updatedData.deliveryResults : [])
			.filter((result) => result && deliveryChannels.includes(result.channel))
		: updatedData.deliveryResults;
	const mergedData = {
		...existingData,
		...updatedData,
	};

	if (Array.isArray(existingData.deliveryResults) && Array.isArray(updatedResults)) {
		const resultByChannel = new Map();
		for (const result of [...existingData.deliveryResults, ...updatedResults]) {
			if (result && result.channel) {
				resultByChannel.set(result.channel, result);
			}
		}
		mergedData.deliveryResults = Array.from(resultByChannel.values());
	}

	if (deliveryChannels && (existingData.routing || updatedData.routing)) {
		mergedData.routing = mergeRoutingData(existingData.routing, updatedData.routing, deliveryChannels);
	}

	return mergedData;
}

function getDeliveryDelta(data = {}, channels = []) {
	const channelSet = new Set(channels);
	const routing = {
		channels: Array.isArray(data.routing?.channels) ? [...data.routing.channels] : null,
	};

	for (const channel of channelSet) {
		const field = DELIVERY_ROUTING_FIELDS[channel];
		if (!field) continue;
		routing[field] = typeof data.routing?.[field] === 'string' ? data.routing[field] : null;
	}

	return {
		deliveryResults: (Array.isArray(data.deliveryResults) ? data.deliveryResults : [])
			.filter((result) => result && channelSet.has(result.channel)),
		routing,
	};
}

/**
 * Parse and validate NEWS_CACHE_TTL_HOURS configuration.
 *
 * Rules:
 * - undefined, null, or empty/whitespace string -> fallback (default: 6)
 * - valid non-negative finite number (including 0 and decimals) -> parsed number
 * - malformed, NaN, Infinite, negative -> warn and fallback (default: 6)
 *
 * @param {any} value - Input value to parse
 * @param {number} fallback - Fallback TTL in hours (default: 6)
 * @returns {number} Validated TTL in hours
 */
function parseNewsCacheTtlHours(value, fallback = 6) {
	if (value === undefined || value === null) {
		return fallback;
	}
	const str = String(value).trim();
	if (str === '') {
		return fallback;
	}
	if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(str)) {
		console.warn('[NewsCache] Invalid NEWS_CACHE_TTL_HOURS configuration, using default');
		return fallback;
	}
	const parsed = Number(str);
	if (!Number.isFinite(parsed) || parsed < 0) {
		console.warn('[NewsCache] Invalid NEWS_CACHE_TTL_HOURS configuration, using default');
		return fallback;
	}
	return parsed;
}

class NewsCache {
	constructor(ttlHours) {
		this.cache = new Map();
		this._explicitTtlHours = ttlHours;
		if (ttlHours !== undefined) {
			this._explicitTtlHours = parseNewsCacheTtlHours(ttlHours);
		} else if (process.env.NEWS_CACHE_TTL_HOURS !== undefined) {
			parseNewsCacheTtlHours(process.env.NEWS_CACHE_TTL_HOURS);
		}
		this.cleanupInterval = null;
		this.deliveryLocks = new Map();
	}

	get ttlMs() {
		if (this._ttlMs !== undefined) {
			return this._ttlMs;
		}
		if (this._explicitTtlHours !== undefined) {
			const hours = parseNewsCacheTtlHours(this._explicitTtlHours);
			return hours * 60 * 60 * 1000;
		}
		const hours = getRuntimeConfig().NEWS_CACHE_TTL_HOURS;
		return hours * 60 * 60 * 1000;
	}

	set ttlMs(val) {
		this._ttlMs = val;
	}

	/**
   * Returns the active deduplication mode.
   * @returns {{ mode: 'persistent'|'in-memory', backend: 'firestore'|null }}
   */
	get dedupMode() {
		const persistent = newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady();
		return {
			mode: persistent ? 'persistent' : 'in-memory',
			backend: persistent ? 'firestore' : null,
		};
	}

	/**
   * Initialize cache with periodic cleanup
   */
	initialize() {
		if (this.cleanupInterval) {
			return;
		}

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
		return Number.isFinite(entry.expiresAt)
			? Date.now() >= entry.expiresAt
			: Date.now() - entry.timestamp >= this.ttlMs;
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

		let localData = null;
		if (entry) {
			if (this.isExpired(entry)) {
				this.cache.delete(key);
			} else {
				localData = entry.data;
			}
		}

		// Persistent dedup: refresh Firestore state before reusing local data so
		// another replica's delivery updates are visible before retry decisions.
		if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
			try {
				const entryRecord = await newsDedupStorageService.getEntryRecord(key);
				if (entryRecord) {
					if (localData && localData.status !== 'claiming' && entryRecord.data?.status === 'claiming') {
						return localData;
					}
					// Warm the local cache to avoid repeated Firestore lookups
					this.cache.set(key, {
						key,
						timestamp: Date.now(),
						expiresAt: entryRecord.expiresAtMs,
						data: entryRecord.data,
					});
					return entryRecord.data;
				}
			} catch (error) {
				console.warn('[NewsCache] Firestore getEntry failed (fail-open):', error.message);
			}
		}

		return localData;
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
	 * @param {{preserveTtl?: boolean, deliveryChannels?: string[], awaitPersistence?: boolean}} options - Preserve TTL, optionally persist only claimed channel deltas, and optionally wait for that write
   * @returns {Promise<void>}
   */
	async set(symbol, eventCategory, data, options = {}) {
		const key = this.generateKey(symbol, eventCategory);
		const existingEntry = options.preserveTtl ? this.cache.get(key) : null;
		if (options.preserveTtl && (!existingEntry || this.isExpired(existingEntry))) {
			return;
		}
		const dataToStore = existingEntry ? mergeDeliveryData(existingEntry.data, data, options.deliveryChannels) : data;
		const timestamp = existingEntry?.timestamp ?? Date.now();
		this.cache.set(key, {
			key,
			timestamp,
			expiresAt: existingEntry?.expiresAt ?? timestamp + this.ttlMs,
			data: dataToStore,
		});

		// Persistent dedup: write to Firestore (fail-open)
		if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
			let write;
			if (options.preserveTtl) {
				write = Array.isArray(options.deliveryChannels)
					? newsDedupStorageService.updateEntry(
						key,
						getDeliveryDelta(data, options.deliveryChannels),
						{ deliveryChannels: options.deliveryChannels },
					)
					: newsDedupStorageService.updateEntry(key, dataToStore);
			} else {
				write = newsDedupStorageService.setEntry(key, this.ttlMs, dataToStore);
			}
			const trackedWrite = trackBackgroundTask(write).catch(err => {
				console.warn('[NewsCache] Firestore cache write failed (fail-open):', err.message);
			});
			if (options.awaitPersistence) {
				await trackedWrite;
			}
		}
	}

	/**
	 * Claim a channel-specific cached redelivery lease.
	 *
	 * Local leases suppress same-process races. Persistent leases use the same
	 * atomic Firestore claim primitive so separate replicas cannot retry the
	 * same channel concurrently.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @param {string} channel
	 * @returns {Promise<boolean>} true when this process may deliver
	 */
	async claimDelivery(symbol, eventCategory, channel) {
		const key = `${this.generateKey(symbol, eventCategory)}:delivery:${channel}`;
		const existingLease = this.deliveryLocks.get(key);
		const now = Date.now();
		if (existingLease?.active) {
			return false;
		}

		const persistentLeaseActive = existingLease && existingLease.persistentUntil > now;
		const claimToken = persistentLeaseActive && existingLease.claimToken
			? existingLease.claimToken
			: randomUUID();
		this.deliveryLocks.set(key, {
			active: true,
			claimToken,
			persistentUntil: persistentLeaseActive ? existingLease.persistentUntil : 0,
		});

		if (persistentLeaseActive || !(newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady())) {
			return true;
		}

		try {
			const claimed = await newsDedupStorageService.claimEntry(key, DELIVERY_LOCK_TTL_MS, claimToken);
			if (!claimed) {
				this.deliveryLocks.delete(key);
				return false;
			}
			this.deliveryLocks.set(key, {
				active: true,
				claimToken,
				persistentUntil: Date.now() + DELIVERY_LOCK_TTL_MS,
			});
		} catch (error) {
			console.warn('[NewsCache] Delivery claim failed (fail-open):', error.message);
		}

		return true;
	}

	/**
	 * Renew a persistent channel retry lease while delivery is in progress.
	 */
	async renewDelivery(symbol, eventCategory, channel) {
		const key = `${this.generateKey(symbol, eventCategory)}:delivery:${channel}`;
		const lease = this.deliveryLocks.get(key);
		if (!(newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady())) {
			return true;
		}
		if (!lease?.active || lease.persistentUntil <= Date.now()) {
			return false;
		}

		try {
			const renewed = await newsDedupStorageService.renewEntry(key, DELIVERY_LOCK_TTL_MS, lease.claimToken);
			if (renewed) {
				lease.persistentUntil = Date.now() + DELIVERY_LOCK_TTL_MS;
			}
			return renewed;
		} catch (error) {
			console.warn('[NewsCache] Delivery lease renewal failed (fail-open):', error.message);
			return null;
		}
	}

	/**
	 * Return the interval used by callers to keep a delivery lease alive.
	 */
	getDeliveryLeaseRenewIntervalMs() {
		return DELIVERY_LOCK_RENEW_INTERVAL_MS;
	}

	/**
	 * Release the local portion of a channel-specific cached redelivery lease.
	 * Persistent leases expire automatically so another replica cannot race the
	 * cache update immediately after delivery.
	 */
	releaseDelivery(symbol, eventCategory, channel) {
		const key = `${this.generateKey(symbol, eventCategory)}:delivery:${channel}`;
		const lease = this.deliveryLocks.get(key);
		if (!lease) {
			return;
		}
		lease.active = false;
		if (lease.persistentUntil <= Date.now()) {
			this.deliveryLocks.delete(key);
		}
	}

	/**
	 * Claim a cache key atomically to prevent concurrent replica alerts.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @returns {Promise<boolean>} true if claim succeeded, false if already claimed/exists
	 */
	async claim(symbol, eventCategory) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);

		if (entry && !this.isExpired(entry)) {
			return false;
		}

		// Persistent check/write
		if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
			try {
				const claimed = await newsDedupStorageService.claimEntry(key, this.ttlMs);
				if (claimed) {
					// Warm local cache so we don't hit Firestore on future calls
					this.cache.set(key, {
						key,
						timestamp: Date.now(),
						data: { status: 'claiming' },
					});
					return true;
				}
				return false;
			} catch (error) {
				console.warn('[NewsCache] Firestore claimEntry failed (fail-open):', error.message);
				// Fail-open: continue to local check/claim
			}
		}

		// Local claim
		this.cache.set(key, {
			key,
			timestamp: Date.now(),
			data: { status: 'claiming' },
		});
		return true;
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
		for (const [key, lease] of this.deliveryLocks.entries()) {
			if (!lease.active && lease.persistentUntil <= Date.now()) {
				this.deliveryLocks.delete(key);
			}
		}
	}

	/**
   * Clear all cache entries (mainly for testing)
   */
	clear() {
		this.cache.clear();
		this.deliveryLocks.clear();
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
		this.deliveryLocks.clear();
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
	parseNewsCacheTtlHours,
};
