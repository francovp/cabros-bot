'use strict';

const remoteConfigService = require('../remoteConfig/RemoteConfigService');

const DEFAULT_ADMIN_PAGE_DEDUP_TTL_MS = 300000;
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Computes a stable deduplication fingerprint from an admin page failure context tuple:
 * (category, channel, requestId, errorCode)
 *
 * @param {Object} [params={}]
 * @param {string} [params.category] - Error category or type (e.g. 'RATE_LIMITED', 'PROVIDER_ERROR')
 * @param {string|string[]} [params.channel] - Channel name(s) (e.g. 'telegram', 'whatsapp')
 * @param {string} [params.requestId] - Correlation or request identifier
 * @param {string|number} [params.errorCode] - HTTP status code or error identifier
 * @returns {string} Colon-separated normalized fingerprint string
 */
function computePagingFingerprint(params = {}) {
	let cleanChannel = 'unknown';
	if (Array.isArray(params.channels)) {
		cleanChannel = params.channels.map(ch => String(ch || '').trim().toLowerCase()).filter(Boolean).sort().join(',');
	} else if (params.channel) {
		cleanChannel = String(params.channel).trim().toLowerCase();
	}

	const cleanCategory = String(params.category || params.failureCategory || 'unknown').trim().toLowerCase();
	const cleanRequestId = String(params.requestId || params.correlationId || 'none').trim();
	const cleanErrorCode = String(params.errorCode ?? params.statusCode ?? params.error ?? 'none').trim().toLowerCase();

	return `${cleanCategory}:${cleanChannel}:${cleanRequestId}:${cleanErrorCode}`;
}

class AdminPagingDeduplicator {
	/**
	 * @param {Object} [options={}]
	 * @param {number} [options.ttlMs] - Fixed TTL in milliseconds (if provided, overrides env and remote config)
	 * @param {number} [options.maxEntries=1000] - Maximum capacity of in-memory LRU cache
	 * @param {Object} [options.logger=console] - Logger instance
	 */
	constructor(options = {}) {
		this.fixedTtlMs = options.ttlMs;
		this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
			? options.maxEntries
			: DEFAULT_MAX_ENTRIES;
		this.cache = new Map();
		this.dedupHits = 0;
		this.lastDedupAt = null;
		this.logger = options.logger || console;
	}

	/**
	 * Resolves effective TTL window in milliseconds.
	 * Returns 0 if disabled.
	 *
	 * @returns {number}
	 */
	getDedupWindowMs() {
		if (this.fixedTtlMs !== undefined) {
			return this.fixedTtlMs;
		}

		try {
			const runtimeConfig = remoteConfigService?.getRuntimeConfig?.();
			if (runtimeConfig && runtimeConfig.ADMIN_PAGE_DEDUP_TTL_MS !== undefined && runtimeConfig.ADMIN_PAGE_DEDUP_TTL_MS !== null) {
				const remoteVal = Number(runtimeConfig.ADMIN_PAGE_DEDUP_TTL_MS);
				if (Number.isFinite(remoteVal) && remoteVal >= 0) {
					return remoteVal;
				}
			}
		} catch {
			// Remote config unavailable or threw; fall through
		}

		if (process.env.ADMIN_PAGE_DEDUP_TTL_MS !== undefined) {
			const parsed = Number(process.env.ADMIN_PAGE_DEDUP_TTL_MS);
			if (Number.isFinite(parsed) && parsed >= 0) {
				return parsed;
			}
		}

		return DEFAULT_ADMIN_PAGE_DEDUP_TTL_MS;
	}

	/**
	 * Whether deduplication is active (> 0 ms window).
	 *
	 * @returns {boolean}
	 */
	isEnabled() {
		return this.getDedupWindowMs() > 0;
	}

	/**
	 * Computes fingerprint tuple using the helper.
	 *
	 * @param {Object} params
	 * @returns {string}
	 */
	computeFingerprint(params) {
		return computePagingFingerprint(params);
	}

	/**
	 * Checks whether an admin page with the given fingerprint should be suppressed.
	 * If not suppressed, registers/refreshes the fingerprint timestamp in the LRU cache.
	 * If suppressed, increments dedupHits, updates lastDedupAt, and logs at info level.
	 *
	 * @param {string} fingerprint
	 * @param {number} [now=Date.now()]
	 * @returns {boolean} true if duplicate and should be suppressed, false otherwise
	 */
	shouldSuppress(fingerprint, now = Date.now()) {
		if (!this.isEnabled() || !fingerprint) {
			return false;
		}

		const key = String(fingerprint).trim();
		if (!key) {
			return false;
		}

		const windowMs = this.getDedupWindowMs();
		const entry = this.cache.get(key);

		if (entry !== undefined) {
			const elapsed = now - entry;
			if (elapsed >= 0 && elapsed < windowMs) {
				this.dedupHits += 1;
				this.lastDedupAt = new Date(now).toISOString();

				// Maintain LRU position without shifting the original burst window
				this.cache.delete(key);
				this.cache.set(key, entry);

				this.logger?.info?.(
					`[AdminPagingDeduplicator] Suppressed duplicate admin page for fingerprint: ${key}`
				);
				return true;
			}

			// Entry is older than window; refresh to current time and allow page
			this.cache.delete(key);
			this.cache.set(key, now);
			return false;
		}

		// New entry: ensure cache size stays within maxEntries bound
		if (this.cache.size >= this.maxEntries) {
			const oldestKey = this.cache.keys().next().value;
			this.cache.delete(oldestKey);
		}

		this.cache.set(key, now);
		return false;
	}

	/**
	 * Returns current status and telemetry counters for status/capabilities reporting.
	 *
	 * @returns {{enabled: boolean, dedupHits: number, dedupWindowMs: number, lastDedupAt: string|null}}
	 */
	getStatus() {
		return {
			enabled: this.isEnabled(),
			dedupHits: this.dedupHits,
			dedupWindowMs: this.getDedupWindowMs(),
			lastDedupAt: this.lastDedupAt,
		};
	}

	/**
	 * Resets cache and counters for tests or maintenance.
	 */
	reset() {
		this.cache.clear();
		this.dedupHits = 0;
		this.lastDedupAt = null;
	}
}

function createAdminPagingDeduplicator(options) {
	return new AdminPagingDeduplicator(options);
}

const adminPagingDeduplicator = new AdminPagingDeduplicator();

module.exports = {
	AdminPagingDeduplicator,
	adminPagingDeduplicator,
	createAdminPagingDeduplicator,
	computePagingFingerprint,
	DEFAULT_ADMIN_PAGE_DEDUP_TTL_MS,
	DEFAULT_MAX_ENTRIES,
};
