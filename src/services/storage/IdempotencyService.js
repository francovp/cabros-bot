'use strict';

const crypto = require('crypto');

class IdempotencyService {
	constructor() {
		this.cache = new Map(); // key -> { payloadHash, state, waiterCount, statusCode, responseBody, headers, createdAt, expiresAt }
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
			if (this.shouldDeleteExpiredRecord(record, now)) {
				this.cache.delete(key);
			}
		}
	}

	/**
	 * Pending reservations must survive TTL expiry until the original request finishes.
	 * @param {Object} record
	 * @param {number} [now]
	 * @returns {boolean}
	 */
	shouldDeleteExpiredRecord(record, now = Date.now()) {
		return record.state === 'completed' && now > record.expiresAt;
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

		if (this.shouldDeleteExpiredRecord(record)) {
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

		return record.state === 'completed' ? record : null;
	}

	/**
	 * Reserve a key before request processing begins so retries cannot duplicate side effects.
	 * @param {string} key
	 * @param {any} payload
	 * @returns {{state: 'fresh'} | {state: 'pending', promise: Promise<Object>} | {state: 'completed', record: Object}}
	 */
	reserve(key, payload) {
		this.cleanup();

		const existing = this.cache.get(key);
		if (existing) {
			if (this.shouldDeleteExpiredRecord(existing)) {
				this.cache.delete(key);
			} else {
				const currentHash = this.hashPayload(payload);
				if (existing.payloadHash !== currentHash) {
					const error = new Error('Idempotency key was reused with a different payload');
					error.code = 'IDEMPOTENCY_CONFLICT';
					error.statusCode = 409;
					throw error;
				}

				if (existing.state === 'completed') {
					return { state: 'completed', record: existing };
				}

				existing.waiterCount = (existing.waiterCount || 0) + 1;
				return { state: 'pending', promise: existing.completionPromise };
			}
		}

		if (this.cache.size >= this.maxKeys) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				this.cache.delete(firstKey);
			}
		}

		const payloadHash = this.hashPayload(payload);
		const now = Date.now();
		const ttl = this.getTtlMs();
		let resolveCompletion;
		let rejectCompletion;
		const completionPromise = new Promise((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});

		this.cache.set(key, {
			payloadHash,
			state: 'pending',
			waiterCount: 0,
			createdAt: now,
			expiresAt: now + ttl,
			completionPromise,
			resolveCompletion,
			rejectCompletion,
		});

		return { state: 'fresh' };
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
		const existing = this.cache.get(key);
		if (!existing && this.cache.size >= this.maxKeys) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey) {
				this.cache.delete(firstKey);
			}
		}

		const payloadHash = this.hashPayload(payload);
		const now = Date.now();
		const ttl = this.getTtlMs();
		const completedRecord = {
			payloadHash,
			state: 'completed',
			statusCode,
			responseBody: body,
			headers: headers || {},
			createdAt: now,
			expiresAt: now + ttl,
		};

		this.cache.set(key, completedRecord);

		if (existing && existing.state === 'pending' && typeof existing.resolveCompletion === 'function') {
			existing.resolveCompletion(completedRecord);
		}
		console.debug(`[IdempotencyService] Cached result for key: ${key} (TTL: ${ttl}ms)`);
	}

	/**
	 * Release a pending key without caching a response so future retries can process normally.
	 * @param {string} key
	 * @param {any} payload
	 * @param {Error} [error]
	 */
	release(key, payload, error) {
		const existing = this.cache.get(key);
		if (!existing || existing.state !== 'pending') {
			return;
		}

		const payloadHash = this.hashPayload(payload);
		if (existing.payloadHash !== payloadHash) {
			return;
		}

		this.cache.delete(key);

		if ((existing.waiterCount || 0) > 0 && typeof existing.rejectCompletion === 'function') {
			existing.rejectCompletion(error || new Error('Idempotency reservation released'));
		}
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
