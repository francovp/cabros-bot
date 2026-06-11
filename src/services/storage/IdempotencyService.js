'use strict';

const crypto = require('crypto');

class IdempotencyService {
	constructor() {
		this.cache = new Map(); // key -> { payloadHash, statusCode, responseBody, headers, createdAt, expiresAt }
		this.defaultTtlMs = 300000; // 5 minutes default
		this.maxKeys = 10000; // Protect against memory exhaustion

		// Periodic cleanup of expired entries
		this.cleanupInterval = setInterval(() => {
			this.cleanup();
		}, 60000).unref();
	}

	/**
	 * Get the configurable TTL from environment
	 * @returns {number}
	 */
	getTtlMs() {
		const envTtl = process.env.WEBHOOK_IDEMPOTENCY_TTL_MS;
		if (envTtl !== undefined) {
			const parsed = parseInt(envTtl, 10);
			if (Number.isFinite(parsed) && parsed >= 0) {
				return parsed;
			}
		}
		return this.defaultTtlMs;
	}

	/**
	 * Remove expired keys from cache
	 */
	cleanup() {
		const now = Date.now();
		for (const [key, record] of this.cache.entries()) {
			if (now > record.expiresAt) {
				this.cache.delete(key);
			}
		}
	}

	/**
	 * Hash the request body/payload to verify it hasn't changed on retry
	 * @param {any} payload
	 * @returns {string} SHA-256 hash of serialized payload
	 */
	hashPayload(payload) {
		const serialized = typeof payload === 'string'
			? payload
			: JSON.stringify(payload || {});
		return crypto.createHash('sha256').update(serialized).digest('hex');
	}

	/**
	 * Retrieve a cached response.
	 * Throws a conflict error (409) if the key is reused with a different payload.
	 * @param {string} key - Idempotency key
	 * @param {any} currentPayload - Current request payload
	 * @returns {Object|null} Cached record details, or null if not found/expired
	 */
	get(key, currentPayload) {
		this.cleanup();
		const record = this.cache.get(key);
		if (!record) {
			return null;
		}

		if (Date.now() > record.expiresAt) {
			this.cache.delete(key);
			return null;
		}

		// Verify payload matches
		const currentHash = this.hashPayload(currentPayload);
		if (record.payloadHash !== currentHash) {
			const error = new Error('Idempotency key was reused with a different payload');
			error.code = 'IDEMPOTENCY_CONFLICT';
			error.statusCode = 409;
			throw error;
		}

		return record;
	}

	/**
	 * Cache a response.
	 * @param {string} key - Idempotency key
	 * @param {any} payload - Request payload
	 * @param {Object} responseDetails
	 * @param {number} responseDetails.statusCode
	 * @param {any} responseDetails.body
	 * @param {Object} responseDetails.headers
	 */
	set(key, payload, { statusCode, body, headers }) {
		if (this.cache.size >= this.maxKeys) {
			// Evict oldest (Map maintains insertion order, keys().next().value returns the first key inserted)
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				this.cache.delete(firstKey);
			}
		}

		const payloadHash = this.hashPayload(payload);
		const now = Date.now();
		const ttl = this.getTtlMs();

		this.cache.set(key, {
			payloadHash,
			statusCode,
			responseBody: body,
			headers: headers || {},
			createdAt: now,
			expiresAt: now + ttl,
		});
		console.debug(`[IdempotencyService] Cached result for key: ${key} (TTL: ${ttl}ms)`);
	}

	/**
	 * Clear the cache (primarily for tests)
	 */
	clear() {
		this.cache.clear();
	}
}

// Singleton instance
const idempotencyService = new IdempotencyService();

module.exports = {
	idempotencyService,
	IdempotencyService,
};
