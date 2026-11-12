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
const USAGE_CLAIM_LEASE_MS = 120_000;
const USAGE_CLAIM_RENEW_INTERVAL_MS = 30_000;
const USAGE_CLAIM_STATE = 'claimed';
const USAGE_CLAIM_TOKEN_FIELD = 'usageClaimToken';
const USAGE_CLAIM_EXPIRES_FIELD = 'usageClaimExpiresAt';
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

function isUsageClaimExpired(data, nowMs = Date.now()) {
	const deadline = data ? data[USAGE_CLAIM_EXPIRES_FIELD] : undefined;
	return !(typeof deadline === 'number' && Number.isFinite(deadline) && deadline > nowMs);
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

function parsePositiveInteger(value, fallback, envVarName, maxBound) {
	if (value === undefined || value === null) {
		return fallback;
	}
	const str = String(value).trim();
	if (str === '') {
		return fallback;
	}
	if (!/^\d+$/.test(str)) {
		console.warn(`[NewsCache] Invalid ${envVarName} configuration, using default`);
		return fallback;
	}
	const parsed = Number(str);
	if (!Number.isFinite(parsed) || parsed < 1 || (maxBound !== undefined && parsed > maxBound)) {
		console.warn(`[NewsCache] Invalid ${envVarName} configuration, using default`);
		return fallback;
	}
	return parsed;
}

const DEFAULT_NEWS_CACHE_MAX_ENTRIES = 5000;
const MAX_NEWS_CACHE_ENTRIES = 1_000_000;
const DEFAULT_NEWS_DELIVERY_LOCK_MAX_ENTRIES = 1000;
const MAX_NEWS_DELIVERY_LOCK_ENTRIES = 100_000;
const ESTIMATED_CACHE_ENTRY_OVERHEAD_BYTES = 128;
const BATCH_CACHE_EVICTION_THRESHOLD = 64;

class NewsCache {
	constructor(ttlHours, options = {}) {
		this.cache = new Map();
		this._estimatedEntryBytes = new WeakMap();
		this._expirationRoot = null;
		this._expirationNodesByKey = new Map();
		this._estimatedMemoryBytes = 0;
		this._explicitTtlHours = ttlHours;
		if (ttlHours !== undefined) {
			this._explicitTtlHours = parseNewsCacheTtlHours(ttlHours);
		} else if (process.env.NEWS_CACHE_TTL_HOURS !== undefined) {
			parseNewsCacheTtlHours(process.env.NEWS_CACHE_TTL_HOURS);
		}
		this.cleanupInterval = null;
		this.deliveryLocks = new Map();
		this._explicitMaxEntries = options.maxEntries !== undefined
			? parsePositiveInteger(options.maxEntries, DEFAULT_NEWS_CACHE_MAX_ENTRIES, 'maxEntries', MAX_NEWS_CACHE_ENTRIES)
			: undefined;
		this._explicitDeliveryLockMaxEntries = options.deliveryLockMaxEntries !== undefined
			? parsePositiveInteger(options.deliveryLockMaxEntries, DEFAULT_NEWS_DELIVERY_LOCK_MAX_ENTRIES, 'deliveryLockMaxEntries', MAX_NEWS_DELIVERY_LOCK_ENTRIES)
			: undefined;
		this._evictionCount = 0;
		this._deliveryLockEvictionCount = 0;
		this._metrics = {
			hits: 0,
			misses: 0,
			evictions: 0,
			lastHitAt: null,
			lastMissAt: null,
		};
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

	get maxEntries() {
		if (this._explicitMaxEntries !== undefined) {
			return this._explicitMaxEntries;
		}
		const runtime = getRuntimeConfig().NEWS_CACHE_MAX_ENTRIES;
		return parsePositiveInteger(runtime, DEFAULT_NEWS_CACHE_MAX_ENTRIES, 'NEWS_CACHE_MAX_ENTRIES', MAX_NEWS_CACHE_ENTRIES);
	}

	set maxEntries(val) {
		this._explicitMaxEntries = val !== undefined
			? parsePositiveInteger(val, DEFAULT_NEWS_CACHE_MAX_ENTRIES, 'maxEntries', MAX_NEWS_CACHE_ENTRIES)
			: undefined;
		this._evictIfOverCapacity();
	}

	get deliveryLockMaxEntries() {
		if (this._explicitDeliveryLockMaxEntries !== undefined) {
			return this._explicitDeliveryLockMaxEntries;
		}
		const runtime = getRuntimeConfig().NEWS_DELIVERY_LOCK_MAX_ENTRIES;
		return parsePositiveInteger(runtime, DEFAULT_NEWS_DELIVERY_LOCK_MAX_ENTRIES, 'NEWS_DELIVERY_LOCK_MAX_ENTRIES', MAX_NEWS_DELIVERY_LOCK_ENTRIES);
	}

	set deliveryLockMaxEntries(val) {
		this._explicitDeliveryLockMaxEntries = val !== undefined
			? parsePositiveInteger(val, DEFAULT_NEWS_DELIVERY_LOCK_MAX_ENTRIES, 'deliveryLockMaxEntries', MAX_NEWS_DELIVERY_LOCK_ENTRIES)
			: undefined;
		this._evictDeliveryLocksIfOverCapacity();
	}

	/**
	 * Insert or update a cache entry, refreshing LRU recency and enforcing maxEntries.
	 */
	_setCacheEntry(key, entry) {
		const previous = this._removeCacheEntry(key);
		if (previous && this.isExpired(previous)) {
			this._metrics.evictions++;
		}
		const cacheEntry = Number.isFinite(entry.expiresAt)
			? entry
			: { ...entry, expiresAt: entry.timestamp + this.ttlMs };
		this.cache.set(key, cacheEntry);
		let dataBytes = 0;
		try {
			dataBytes = Buffer.byteLength(JSON.stringify(cacheEntry.data ?? null) || '', 'utf8');
		} catch {
			// Keep cache writes fail-open when a value cannot be serialized for metrics.
		}
		const estimatedEntryBytes = Buffer.byteLength(key, 'utf8') + ESTIMATED_CACHE_ENTRY_OVERHEAD_BYTES + dataBytes;
		this._estimatedEntryBytes.set(cacheEntry, estimatedEntryBytes);
		this._estimatedMemoryBytes += estimatedEntryBytes;
		this._addExpirationIndex(key, cacheEntry);
		this._evictIfOverCapacity();
	}

	// An expiry-ordered treap provides exact expired-entry counts in O(log n).
	_addExpirationIndex(key, entry) {
		const node = {
			key,
			expiresAt: entry.expiresAt,
			priority: Math.random(),
			size: 1,
			left: null,
			right: null,
		};
		this._expirationNodesByKey.set(key, node);
		this._expirationRoot = this._insertExpirationNode(this._expirationRoot, node);
	}

	_expirationSubtreeSize(node) {
		return node?.size ?? 0;
	}

	_compareExpirationNodes(left, right) {
		if (left.expiresAt !== right.expiresAt) {
			return left.expiresAt - right.expiresAt;
		}
		return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
	}

	_updateExpirationNode(node) {
		node.size = 1 + this._expirationSubtreeSize(node.left) + this._expirationSubtreeSize(node.right);
		return node;
	}

	_rotateExpirationRight(root) {
		const pivot = root.left;
		root.left = pivot.right;
		pivot.right = this._updateExpirationNode(root);
		return this._updateExpirationNode(pivot);
	}

	_rotateExpirationLeft(root) {
		const pivot = root.right;
		root.right = pivot.left;
		pivot.left = this._updateExpirationNode(root);
		return this._updateExpirationNode(pivot);
	}

	_insertExpirationNode(root, node) {
		if (!root) {
			return node;
		}
		if (this._compareExpirationNodes(node, root) < 0) {
			root.left = this._insertExpirationNode(root.left, node);
			if (root.left.priority < root.priority) {
				root = this._rotateExpirationRight(root);
			}
		} else {
			root.right = this._insertExpirationNode(root.right, node);
			if (root.right.priority < root.priority) {
				root = this._rotateExpirationLeft(root);
			}
		}
		return this._updateExpirationNode(root);
	}

	_mergeExpirationTrees(left, right) {
		if (!left) return right;
		if (!right) return left;
		if (left.priority < right.priority) {
			left.right = this._mergeExpirationTrees(left.right, right);
			return this._updateExpirationNode(left);
		}
		right.left = this._mergeExpirationTrees(left, right.left);
		return this._updateExpirationNode(right);
	}

	_removeExpirationNode(root, target) {
		if (!root) {
			return null;
		}
		const comparison = this._compareExpirationNodes(target, root);
		if (comparison === 0) {
			return this._mergeExpirationTrees(root.left, root.right);
		}
		if (comparison < 0) {
			root.left = this._removeExpirationNode(root.left, target);
		} else {
			root.right = this._removeExpirationNode(root.right, target);
		}
		return this._updateExpirationNode(root);
	}

	_removeExpirationIndex(key) {
		const node = this._expirationNodesByKey.get(key);
		if (!node) {
			return;
		}
		this._expirationNodesByKey.delete(key);
		this._expirationRoot = this._removeExpirationNode(this._expirationRoot, node);
	}

	_countExpiredEntries(now) {
		let count = 0;
		let node = this._expirationRoot;
		while (node) {
			if (node.expiresAt <= now) {
				count += 1 + this._expirationSubtreeSize(node.left);
				node = node.right;
			} else {
				node = node.left;
			}
		}
		return count;
	}

	_splitExpiredExpirationNodes(root, now) {
		if (!root) {
			return [null, null];
		}
		if (root.expiresAt <= now) {
			const [expiredRight, activeRight] = this._splitExpiredExpirationNodes(root.right, now);
			root.right = expiredRight;
			return [this._updateExpirationNode(root), activeRight];
		}
		const [expiredLeft, activeLeft] = this._splitExpiredExpirationNodes(root.left, now);
		root.left = activeLeft;
		return [expiredLeft, this._updateExpirationNode(root)];
	}

	_removeExpiredCacheEntries(now) {
		const [expiredRoot, activeRoot] = this._splitExpiredExpirationNodes(this._expirationRoot, now);
		this._expirationRoot = activeRoot;
		if (!expiredRoot) {
			return 0;
		}

		let removed = 0;
		const pending = [expiredRoot];
		while (pending.length > 0) {
			const node = pending.pop();
			if (node.left) pending.push(node.left);
			if (node.right) pending.push(node.right);
			this._expirationNodesByKey.delete(node.key);

			const entry = this.cache.get(node.key);
			if (!entry) {
				continue;
			}
			this.cache.delete(node.key);
			const estimatedEntryBytes = this._estimatedEntryBytes.get(entry) ?? 0;
			this._estimatedMemoryBytes = Math.max(0, this._estimatedMemoryBytes - estimatedEntryBytes);
			this._estimatedEntryBytes.delete(entry);
			removed++;
			this._metrics.evictions++;
		}
		return removed;
	}

	_removeCacheEntry(key) {
		if (!this.cache.has(key)) {
			return null;
		}
		const entry = this.cache.get(key);
		this.cache.delete(key);
		this._removeExpirationIndex(key);
		const estimatedEntryBytes = this._estimatedEntryBytes.get(entry) ?? 0;
		this._estimatedMemoryBytes = Math.max(0, this._estimatedMemoryBytes - estimatedEntryBytes);
		this._estimatedEntryBytes.delete(entry);
		return entry;
	}

	_removeCacheEntries(keys) {
		let removed = 0;
		for (const key of keys) {
			const entry = this.cache.get(key);
			if (!entry) {
				continue;
			}
			this.cache.delete(key);
			this._expirationNodesByKey.delete(key);
			const estimatedEntryBytes = this._estimatedEntryBytes.get(entry) ?? 0;
			this._estimatedMemoryBytes = Math.max(0, this._estimatedMemoryBytes - estimatedEntryBytes);
			this._estimatedEntryBytes.delete(entry);
			removed++;
		}

		if (removed > 0) {
			this._rebuildExpirationIndex();
		}
		return removed;
	}

	_rebuildExpirationIndex() {
		const orderedNodes = [];
		const traversal = [];
		let node = this._expirationRoot;
		while (node || traversal.length > 0) {
			while (node) {
				traversal.push(node);
				node = node.left;
			}
			node = traversal.pop();
			if (this._expirationNodesByKey.has(node.key)) {
				orderedNodes.push(node);
			}
			node = node.right;
		}

		const treapStack = [];
		for (const orderedNode of orderedNodes) {
			orderedNode.left = null;
			orderedNode.right = null;
			orderedNode.size = 1;
			let previous = null;
			while (treapStack.length > 0 && treapStack[treapStack.length - 1].priority > orderedNode.priority) {
				previous = treapStack.pop();
			}
			orderedNode.left = previous;
			if (treapStack.length > 0) {
				treapStack[treapStack.length - 1].right = orderedNode;
			}
			treapStack.push(orderedNode);
		}
		this._expirationRoot = treapStack[0] ?? null;

		if (this._expirationRoot) {
			const pending = [[this._expirationRoot, false]];
			while (pending.length > 0) {
				const [current, visited] = pending.pop();
				if (visited) {
					this._updateExpirationNode(current);
					continue;
				}
				pending.push([current, true]);
				if (current.right) pending.push([current.right, false]);
				if (current.left) pending.push([current.left, false]);
			}
		}
	}

	_isActiveClaimEntry(entry) {
		return entry?.data?.status === 'claiming' && !this.isExpired(entry);
	}

	/**
	 * Enforce the cache size bound by evicting the oldest entry (LRU eviction).
	 * JavaScript Map iteration order is insertion order, so the first key is
	 * the least-recently inserted entry.
	 */
	_evictIfOverCapacity() {
		const max = this.maxEntries;
		if (this.cache.size <= max) {
			return;
		}
		const keysToEvict = [];
		for (const [key, entry] of this.cache.entries()) {
			if (this.cache.size - keysToEvict.length <= max) {
				break;
			}
			if (!this._isActiveClaimEntry(entry)) {
				keysToEvict.push(key);
			}
		}
		const estimatedIndividualRemovalWork = keysToEvict.length * Math.log2(this.cache.size);
		const shouldBatchEvictions = keysToEvict.length >= BATCH_CACHE_EVICTION_THRESHOLD
			&& estimatedIndividualRemovalWork >= this.cache.size;
		const evicted = shouldBatchEvictions
			? this._removeCacheEntries(keysToEvict)
			: keysToEvict.reduce((count, key) => count + (this._removeCacheEntry(key) ? 1 : 0), 0);
		if (evicted > 0) {
			this._evictionCount += evicted;
			this._metrics.evictions += evicted;
			console.debug('[NewsCache] Evicted', evicted, 'LRU entries; cache size:', this.cache.size);
		}
	}

	/**
	 * Enforce the deliveryLocks size bound by evicting inactive leases.
	 * Active leases (lease.active === true) must NEVER be evicted so concurrent
	 * webhooks or retries cannot claim a duplicate delivery lease.
	 */
	_evictDeliveryLocksIfOverCapacity({ reserveSlot = false } = {}) {
		const max = this.deliveryLockMaxEntries;
		const targetSize = reserveSlot ? max - 1 : max;
		if (this.deliveryLocks.size <= targetSize) {
			return;
		}
		const now = Date.now();
		let evicted = 0;
		// First pass: evict inactive leases whose persistent lease has expired
		for (const [key, lease] of this.deliveryLocks.entries()) {
			if (this.deliveryLocks.size <= targetSize) {
				break;
			}
			if (!lease.active && (!lease.persistentUntil || lease.persistentUntil <= now)) {
				this.deliveryLocks.delete(key);
				evicted++;
			}
		}
		// Second pass: evict any remaining inactive leases
		for (const [key, lease] of this.deliveryLocks.entries()) {
			if (this.deliveryLocks.size <= targetSize) {
				break;
			}
			if (!lease.active) {
				this.deliveryLocks.delete(key);
				evicted++;
			}
		}
		if (evicted > 0) {
			this._deliveryLockEvictionCount += evicted;
			console.debug('[NewsCache] Evicted', evicted, 'delivery lock entries; size:', this.deliveryLocks.size);
		}
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
		const abandonedClaim = entry?.data?.status === 'claiming-abandoned';

		let localData = null;
		if (entry) {
			if (this.isExpired(entry)) {
				const removed = this._removeCacheEntry(key);
				if (removed) {
					this._metrics.evictions++;
				}
				this._evictIfOverCapacity();
			} else {
				// Refresh LRU recency on hit: move entry to the most-recently used position in the Map
				this.cache.delete(key);
				this.cache.set(key, entry);
				this._evictIfOverCapacity();
				if (!abandonedClaim) {
					localData = entry.data;
				}
			}
		} else {
			this._evictIfOverCapacity();
		}

		// Persistent dedup: refresh Firestore state before reusing local data so
		// another replica's delivery updates are visible before retry decisions.
		if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
			try {
				const entryRecord = await newsDedupStorageService.getEntryRecord(key);
				if (entryRecord) {
					const latestEntry = this.cache.get(key);
					const latestLocalData = latestEntry && !this.isExpired(latestEntry) ? latestEntry.data : null;
					const refreshedLocalData = latestLocalData ?? localData;
					const localOnlyChannels = (latestEntry?.localOnlyChannels ?? entry?.localOnlyChannels ?? []).filter(channel => {
						const persistentResult = entryRecord.data?.deliveryResults?.find(result => result?.channel === channel);
						return persistentResult?.success !== true;
					});
					const refreshedData = refreshedLocalData && localOnlyChannels.length > 0
						? mergeDeliveryData(entryRecord.data, refreshedLocalData, localOnlyChannels)
						: entryRecord.data;
					if (abandonedClaim && entryRecord.data?.status === 'claiming') {
						this._recordHit();
						return null;
					}
					if (refreshedLocalData && refreshedLocalData.status !== 'claiming' && entryRecord.data?.status === 'claiming') {
						this._recordHit();
						return refreshedLocalData;
					}
					// Warm the local cache to avoid repeated Firestore lookups, enforcing LRU bounds
					this._setCacheEntry(key, {
						key,
						timestamp: Date.now(),
						expiresAt: entryRecord.expiresAtMs,
						data: refreshedData,
						localOnlyChannels,
					});
					this._recordHit();
					return refreshedData;
				}
			} catch (error) {
				console.warn('[NewsCache] Firestore getEntry failed (fail-open):', error.message);
			}
		}

		if (localData !== null && localData !== undefined) {
			this._recordHit();
			return localData;
		}

		this._recordMiss();
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
	 * @param {{preserveTtl?: boolean, deliveryChannels?: string[], localDeliveryChannels?: string[], localOnlyChannels?: string[], awaitPersistence?: boolean, skipPersistence?: boolean}} options - Preserve TTL, optionally persist only claimed channel deltas, and optionally wait for that write
   * @returns {Promise<void>}
   */
	async set(symbol, eventCategory, data, options = {}) {
		const key = this.generateKey(symbol, eventCategory);
		const existingEntry = options.preserveTtl ? this.cache.get(key) : null;
		if (options.preserveTtl && (!existingEntry || this.isExpired(existingEntry))) {
			return;
		}
		const localDeliveryChannels = options.localDeliveryChannels ?? options.deliveryChannels;
		const dataToStore = existingEntry ? mergeDeliveryData(existingEntry.data, data, localDeliveryChannels) : data;
		const persistedChannels = Array.isArray(options.deliveryChannels) ? options.deliveryChannels : null;
		const existingLocalOnlyChannels = existingEntry?.localOnlyChannels ?? [];
		const locallyUpdatedChannels = new Set([
			...(Array.isArray(localDeliveryChannels) ? localDeliveryChannels : []),
			...(persistedChannels ?? []),
		]);
		const localOnlyChannels = Array.from(new Set([
			...(options.localOnlyChannels ?? (options.skipPersistence ? localDeliveryChannels ?? [] : [])),
			...existingLocalOnlyChannels.filter(channel => !locallyUpdatedChannels.has(channel)),
		]));
		const timestamp = existingEntry?.timestamp ?? Date.now();
		// _setCacheEntry handles delete-then-set for LRU recency and enforces maxEntries
		this._setCacheEntry(key, {
			key,
			timestamp,
			expiresAt: existingEntry?.expiresAt ?? timestamp + this.ttlMs,
			data: dataToStore,
			localOnlyChannels,
		});

		// Persistent dedup: write to Firestore (fail-open)
		if (!options.skipPersistence && newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
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
	 * Record the original alert document's storage outcome on the cache entry.
	 *
	 * State machine: 'pending' when the fire-and-forget write is scheduled,
	 * 'owned' once some durable document carries this analysis usage (the
	 * original, or a promoted fallback redelivery), 'none' when the original
	 * failed before any document owned it. Updates the local entry
	 * synchronously and, when persistent dedup is enabled, merges ONLY this
	 * field into the durable Firestore payload transactionally so concurrent
	 * delivery updates from other replicas are preserved. Fail-open.
	 *
	 * `options.allowedCurrentStates` guards the shared durable state so an
	 * ordering mistake cannot regress it: a late 'pending' can no longer bury a
	 * terminal 'owned'/'none', and a terminal write cannot undo a newer one.
	 * `options.claimToken` additionally pins the transition to the owner of the
	 * current usage claim. The local mirror is refreshed from Firestore on the
	 * next get(), so it never outranks the durable value for long.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @param {'pending'|'owned'|'none'} state
	 * @param {{allowedCurrentStates?: Array, claimToken?: string|null, clearUsageClaim?: boolean}} [options]
	 * @returns {Promise<void>}
	 */
	async markOriginalPersistState(symbol, eventCategory, state, options = {}) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);
		if (!entry || this.isExpired(entry)) {
			return;
		}
		if (options.claimToken !== undefined
			&& entry.data[USAGE_CLAIM_TOKEN_FIELD]
			&& entry.data[USAGE_CLAIM_TOKEN_FIELD] !== options.claimToken) {
			console.debug('[NewsCache] Skipping persist-state write for a usage claim this replica does not own');
			return;
		}

		const mergeFields = ['originalPersistedState'];
		if (options.clearUsageClaim) {
			mergeFields.push(USAGE_CLAIM_TOKEN_FIELD, USAGE_CLAIM_EXPIRES_FIELD);
		}

		entry.data = {
			...entry.data,
			originalPersistedState: state,
			...(options.clearUsageClaim
				? { [USAGE_CLAIM_TOKEN_FIELD]: null, [USAGE_CLAIM_EXPIRES_FIELD]: null }
				: {}),
		};

		if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
			try {
				await newsDedupStorageService.updateEntry(
					key,
					{ originalPersistedState: state, ...(options.clearUsageClaim
						? { [USAGE_CLAIM_TOKEN_FIELD]: null, [USAGE_CLAIM_EXPIRES_FIELD]: null }
						: {}) },
					{
						mergeFields,
						...(Array.isArray(options.allowedCurrentStates)
							? {
								expectedField: 'originalPersistedState',
								expectedValues: options.allowedCurrentStates,
							}
							: {}),
						...(options.claimToken
							? { expectedTokenField: USAGE_CLAIM_TOKEN_FIELD, expectedToken: options.claimToken }
							: {}),
					},
				);
			} catch (error) {
				console.warn('[NewsCache] Failed to persist original-write state (fail-open):', error.message);
			}
		}
	}

	/**
	 * Atomically claim durable-usage ownership for a fallback record.
	 *
	 * Performs a synchronized local check-and-set first, then — when
	 * persistent dedup is enabled — commits the claim with an expected-state
	 * guard inside the Firestore transaction so concurrent replicas cannot
	 * double-claim. The claim carries an owner token and a bounded deadline, so
	 * a process that crashes between the claim and its terminal write releases
	 * the field within USAGE_CLAIM_LEASE_MS instead of stranding it until the
	 * dedup TTL. Callers must release via releaseUsageOwnershipClaim() with the
	 * returned token when the claimed record fails to persist. Fail-open:
	 * storage errors roll the local claim back.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @returns {Promise<string|null>} owner token when the caller holds the claim, else null
	 */
	async claimUsageOwnership(symbol, eventCategory) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);
		if (!entry || this.isExpired(entry)) {
			return null;
		}
		const previousState = entry.data.originalPersistedState;
		if (previousState === 'owned' || previousState === 'pending') {
			return null;
		}
		if (previousState === USAGE_CLAIM_STATE && !isUsageClaimExpired(entry.data)) {
			return null;
		}

		const claimToken = randomUUID();
		const claimExpiresAt = Date.now() + USAGE_CLAIM_LEASE_MS;
		entry.data = {
			...entry.data,
			originalPersistedState: USAGE_CLAIM_STATE,
			[USAGE_CLAIM_TOKEN_FIELD]: claimToken,
			[USAGE_CLAIM_EXPIRES_FIELD]: claimExpiresAt,
		};

		if (!newsDedupStorageService.isEnabled() || !newsDedupStorageService.isReady()) {
			return claimToken;
		}
		try {
			const committed = await newsDedupStorageService.updateEntry(
				key,
				{
					originalPersistedState: USAGE_CLAIM_STATE,
					[USAGE_CLAIM_TOKEN_FIELD]: claimToken,
					[USAGE_CLAIM_EXPIRES_FIELD]: claimExpiresAt,
				},
				{
					mergeFields: ['originalPersistedState', USAGE_CLAIM_TOKEN_FIELD, USAGE_CLAIM_EXPIRES_FIELD],
					expectedField: 'originalPersistedState',
					expectedValues: ['none'],
					reclaimStale: { states: [USAGE_CLAIM_STATE], expiresField: USAGE_CLAIM_EXPIRES_FIELD },
				},
			);
			if (committed) {
				return claimToken;
			}
		} catch (error) {
			console.warn('[NewsCache] Usage-ownership claim failed (fail-open):', error.message);
		}
		entry.data = { ...entry.data, originalPersistedState: previousState ?? 'none' };
		return null;
	}

	/**
	 * Extend a usage-ownership claim that is still being persisted.
	 *
	 * The claim lease is a fixed deadline, but the Firestore `add()` that
	 * follows it has no application-level deadline. A save that outlives the
	 * lease would otherwise let another replica reclaim the state and persist
	 * a SECOND document carrying the same token usage — the token-pinned
	 * terminal write would then be refused, but the duplicate alert document
	 * is already written and `/api/alerts/summary` double-counts. Renewing
	 * keeps the claim alive for as long as the write is genuinely in flight,
	 * while a crashed owner still releases it within USAGE_CLAIM_LEASE_MS
	 * because a dead process cannot renew.
	 *
	 * Only the deadline is extended; the claim state and owner token are
	 * untouched, and the write is token-pinned so a replica that lost the
	 * claim can never resurrect it. Fail-open on storage errors.
	 *
	 * Returns false for a refused write and for a storage fault alike:
	 * updateEntry() swallows Firestore errors, so the two are not
	 * distinguishable here. Callers must treat renewal as best-effort.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @param {string} claimToken - Token returned by claimUsageOwnership
	 * @returns {Promise<boolean>} true when the durable deadline was extended
	 */
	async renewUsageOwnership(symbol, eventCategory, claimToken) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);
		if (!entry || this.isExpired(entry)) {
			return false;
		}
		if (!claimToken || entry.data[USAGE_CLAIM_TOKEN_FIELD] !== claimToken) {
			return false;
		}
		const claimExpiresAt = Date.now() + USAGE_CLAIM_LEASE_MS;
		if (!newsDedupStorageService.isEnabled() || !newsDedupStorageService.isReady()) {
			entry.data = { ...entry.data, [USAGE_CLAIM_EXPIRES_FIELD]: claimExpiresAt };
			return true;
		}
		try {
			const renewed = await newsDedupStorageService.updateEntry(
				key,
				{ [USAGE_CLAIM_EXPIRES_FIELD]: claimExpiresAt },
				{
					mergeFields: [USAGE_CLAIM_EXPIRES_FIELD],
					expectedField: 'originalPersistedState',
					expectedValues: [USAGE_CLAIM_STATE],
					expectedTokenField: USAGE_CLAIM_TOKEN_FIELD,
					expectedToken: claimToken,
				},
			);
			if (renewed) {
				entry.data = { ...entry.data, [USAGE_CLAIM_EXPIRES_FIELD]: claimExpiresAt };
			}
			return renewed;
		} catch (error) {
			console.warn('[NewsCache] Usage-ownership renewal failed (fail-open):', error.message);
			return false;
		}
	}

	/**
	 * Return the interval callers use to keep a usage claim alive while the
	 * alert document is being persisted.
	 *
	 * @returns {number}
	 */
	getUsageClaimRenewIntervalMs() {
		return USAGE_CLAIM_RENEW_INTERVAL_MS;
	}

	/**
	 * Release a claim acquired via claimUsageOwnership after its record
	 * failed to persist, restoring 'none' so a later redelivery can own it.
	 *
	 * Defaults to the token held by the local entry so the owner token always
	 * matches the claim this replica took, even when the caller loses it.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @param {string} [claimToken] - Token returned by claimUsageOwnership
	 * @returns {Promise<void>}
	 */
	async releaseUsageOwnershipClaim(symbol, eventCategory, claimToken) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);
		const ownedToken = claimToken ?? (entry?.data?.[USAGE_CLAIM_TOKEN_FIELD] ?? null);
		await this.markOriginalPersistState(symbol, eventCategory, 'none', {
			allowedCurrentStates: [USAGE_CLAIM_STATE],
			claimToken: ownedToken,
			clearUsageClaim: true,
		});
	}

	/**
	 * Acquire an atomic delivery lease for an individual channel retry.
	 * Local leases suppress same-process races. Persistent leases use the same
	 * atomic Firestore claim primitive so separate replicas cannot retry the
	 * same channel concurrently.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @param {string} channel
	 * @param {Object} [options]
	 * @returns {Promise<boolean>} true when this process may deliver
	 */
	async claimDelivery(symbol, eventCategory, channel, options = {}) {
		const key = `${this.generateKey(symbol, eventCategory)}:delivery:${channel}`;
		const existingLease = this.deliveryLocks.get(key);
		const now = Date.now();
		if (existingLease?.active) {
			return false;
		}

		// Prune inactive/expired leases before capacity check
		this._evictDeliveryLocksIfOverCapacity({ reserveSlot: !existingLease });

		const isNewOrEvicted = !this.deliveryLocks.has(key);

		// If this is a new lease (or was evicted during pruning) and capacity is already saturated with active leases,
		// reject the claim to preserve existing active leases from eviction.
		if (isNewOrEvicted && this.deliveryLocks.size >= this.deliveryLockMaxEntries) {
			console.warn('[NewsCache] Delivery lock capacity saturated with active leases; rejecting new claim');
			return false;
		}

		const persistentLeaseActive = !isNewOrEvicted && existingLease && existingLease.persistentUntil > now;
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
			const claimed = await this._executeBoundedClaim(
				() => newsDedupStorageService.claimEntry(key, DELIVERY_LOCK_TTL_MS, claimToken),
				options,
			);
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
	 * Release a local and/or persistent channel delivery lease.
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
		this._evictDeliveryLocksIfOverCapacity();
	}

	/**
	 * Execute a durable claim bounded by deadline, timeout, and abort signal.
	 * Fails open (resolves true) when remaining delivery budget expires or signal aborts.
	 *
	 * @param {Function} fn
	 * @param {Object} [options]
	 * @returns {Promise<boolean>}
	 * @private
	 */
	async _executeBoundedClaim(fn, options = {}) {
		const { signal } = options;
		const deadline = typeof options.deliveryDeadline === 'number'
			? options.deliveryDeadline
			: (typeof options.deadline === 'number' ? options.deadline : undefined);

		let timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : undefined;
		if (typeof deadline === 'number') {
			const remainingMs = Math.max(0, deadline - Date.now());
			timeoutMs = typeof timeoutMs === 'number' ? Math.min(timeoutMs, remainingMs) : remainingMs;
		}

		if (signal?.aborted) {
			console.warn('[NewsCache] Claim aborted by signal (fail-open)');
			return true;
		}

		if (typeof timeoutMs === 'number' && timeoutMs <= 0) {
			console.warn('[NewsCache] Claim delivery budget expired (fail-open)');
			return true;
		}

		return new Promise((resolve, reject) => {
			let settled = false;
			let timer = null;
			let abortListener = null;

			const cleanup = () => {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				if (signal && abortListener) {
					signal.removeEventListener('abort', abortListener);
					abortListener = null;
				}
			};

			const failOpen = (reason) => {
				if (!settled) {
					settled = true;
					cleanup();
					console.warn(`[NewsCache] Firestore claimEntry ${reason} (fail-open)`);
					resolve(true);
				}
			};

			if (signal) {
				abortListener = () => failOpen('aborted by signal');
				signal.addEventListener('abort', abortListener, { once: true });
			}

			if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
				timer = setTimeout(() => failOpen('budget expired'), timeoutMs);
			}

			Promise.resolve()
				.then(fn)
				.then((result) => {
					if (!settled) {
						settled = true;
						cleanup();
						resolve(result);
					}
				})
				.catch((error) => {
					if (!settled) {
						settled = true;
						cleanup();
						reject(error);
					}
				});
		});
	}

	/**
	 * Claim a cache key atomically to prevent concurrent replica alerts.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @param {Object} [options]
	 * @returns {Promise<boolean>} true if claim succeeded, false if already claimed/exists
	 */
	async claim(symbol, eventCategory, options = {}) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);

		if (entry) {
			const expired = this.isExpired(entry);
			if (!expired) {
				if (entry.data?.status !== 'claiming-abandoned') {
					return false;
				}
				if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
					try {
						await this._executeBoundedClaim(
							() => newsDedupStorageService.deleteEntry(key),
							options,
						);
					} catch (error) {
						console.warn('[NewsCache] Retrying abandoned claim deletion failed:', error.message);
					}
				}
			}
			const removed = this._removeCacheEntry(key);
			if (removed) {
				this._metrics.evictions++;
			}
		}

		if (this.cache.size >= this.maxEntries) {
			let hasEvictable = false;
			for (const cacheEntry of this.cache.values()) {
				if (!this._isActiveClaimEntry(cacheEntry)) {
					hasEvictable = true;
					break;
				}
			}
			if (!hasEvictable) {
				console.warn('[NewsCache] Cache capacity saturated with active claims; rejecting new claim');
				return false;
			}
		}

		// Reserve a cache slot before awaiting Firestore to avoid pre-await capacity race
		this._setCacheEntry(key, {
			key,
			timestamp: Date.now(),
			data: { status: 'claiming' },
		});

		// Persistent check/write
		if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
			try {
				const claimed = await this._executeBoundedClaim(
					() => newsDedupStorageService.claimEntry(key, this.ttlMs),
					options,
				);
				if (claimed) {
					return true;
				}
				// Remote claim was denied (already claimed/exists elsewhere)
				this._removeCacheEntry(key);
				return false;
			} catch (error) {
				console.warn('[NewsCache] Firestore claimEntry failed (fail-open):', error.message);
				// Fail-open: keep reserved local claim
				return true;
			}
		}

		return true;
	}

	/**
	 * Release an in-flight claim when delivery is aborted or abandoned before dispatch.
	 *
	 * @param {string} symbol
	 * @param {string} eventCategory
	 * @returns {Promise<void>}
	 */
	async releaseClaim(symbol, eventCategory) {
		const key = this.generateKey(symbol, eventCategory);
		const entry = this.cache.get(key);
		if (newsDedupStorageService.isEnabled() && newsDedupStorageService.isReady()) {
			let deleted = false;
			try {
				deleted = await newsDedupStorageService.deleteEntry(key);
			} catch (error) {
				console.warn('[NewsCache] Firestore releaseClaim/deleteEntry failed (fail-open):', error.message);
			}
			if (!deleted && entry?.data?.status === 'claiming') {
				this._setCacheEntry(key, {
					...entry,
					timestamp: Date.now(),
					data: { status: 'claiming-abandoned' },
				});
				return;
			}
		}
		if (entry?.data?.status === 'claiming') {
			this._removeCacheEntry(key);
		}
	}

	/**
   * Remove expired entries from cache
   * Called periodically by setInterval
   */
	cleanup() {
		const now = Date.now();
		const removed = this._removeExpiredCacheEntries(now);
		if (removed > 0) {
			console.debug('[NewsCache] Cleanup removed', removed, 'expired entries. Cache size:', this.cache.size);
		}
		this._evictIfOverCapacity();
		for (const [key, lease] of this.deliveryLocks.entries()) {
			if (!lease.active && lease.persistentUntil <= now) {
				this.deliveryLocks.delete(key);
			}
		}
		this._evictDeliveryLocksIfOverCapacity();
	}

	/**
   * Clear all cache entries (mainly for testing)
   */
	clear() {
		this.cache.clear();
		this._expirationRoot = null;
		this._expirationNodesByKey.clear();
		this._estimatedEntryBytes = new WeakMap();
		this._estimatedMemoryBytes = 0;
		this.deliveryLocks.clear();
	}

	_recordHit() {
		this._metrics.hits++;
		this._metrics.lastHitAt = new Date().toISOString();
	}

	_recordMiss() {
		this._metrics.misses++;
		this._metrics.lastMissAt = new Date().toISOString();
	}

	resetMetrics() {
		this._metrics = {
			hits: 0,
			misses: 0,
			evictions: 0,
			lastHitAt: null,
			lastMissAt: null,
		};
	}

	getMetrics() {
		const readCount = this._metrics.hits + this._metrics.misses;
		return {
			...this._metrics,
			hitRate: readCount === 0 ? 0 : Math.round((this._metrics.hits / readCount) * 1000) / 1000,
			totalEntries: Math.max(0, this.cache.size - this._countExpiredEntries(Date.now())),
			estimatedMemoryBytes: this._estimatedMemoryBytes,
		};
	}

	getStatus(enabled) {
		const isEnabled = Boolean(enabled);
		const dedupMode = this.dedupMode;
		return {
			enabled: isEnabled,
			configured: isEnabled,
			ready: isEnabled,
			status: isEnabled ? 'ready' : 'disabled',
			mode: dedupMode.mode,
			backend: dedupMode.backend,
			metrics: this.getMetrics(),
		};
	}

	/**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
	getStats() {
		return {
			size: this.cache.size,
			maxEntries: this.maxEntries,
			evictionCount: this._evictionCount,
			deliveryLocksSize: this.deliveryLocks.size,
			deliveryLockMaxEntries: this.deliveryLockMaxEntries,
			deliveryLockEvictionCount: this._deliveryLockEvictionCount,
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
	USAGE_CLAIM_LEASE_MS,
	USAGE_CLAIM_RENEW_INTERVAL_MS,
};
