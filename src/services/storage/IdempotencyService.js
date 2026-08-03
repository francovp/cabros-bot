'use strict';

const crypto = require('crypto');
const idempotencyStorageService = require('./IdempotencyStorageService');

class IdempotencyService {
	constructor() {
		this.cache = new Map(); // key -> { payloadHash, state, waiterCount, statusCode, responseBody, headers, createdAt, expiresAt, completionPromise, resolveCompletion, rejectCompletion }
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
	 * Reuse a same-payload local reservation instead of replacing it during a
	 * concurrent durable pending response or fail-open fallback.
	 * @param {string} key
	 * @param {string} payloadHash
	 * @returns {{state: 'completed', record: Object} | {state: 'pending', promise: Promise<Object>} | null}
	 */
	getExistingLocalReservation(key, payloadHash) {
		const existing = this.cache.get(key);
		if (!existing || existing.payloadHash !== payloadHash) {
			return null;
		}

		if (existing.state === 'completed') {
			return { state: 'completed', record: existing };
		}

		if (existing.state === 'pending') {
			existing.waiterCount = (existing.waiterCount || 0) + 1;
			return { state: 'pending', promise: existing.completionPromise };
		}

		return null;
	}

	/**
	 * Prefer evicting completed records only; pending reservations must remain replayable.
	 * @returns {boolean}
	 */
	evictOldestCompletedRecord() {
		for (const [key, record] of this.cache.entries()) {
			if (record.state === 'completed') {
				this.cache.delete(key);
				return true;
			}
		}

		return false;
	}

	/**
	 * Canonicalize JSON-compatible payloads so object member order does not
	 * change the idempotency fingerprint while array order remains significant.
	 * @param {any} payload
	 * @returns {any}
	 */
	canonicalizePayload(payload) {
		if (Array.isArray(payload)) {
			return payload.map((item) => this.canonicalizePayload(item));
		}

		if (payload && typeof payload === 'object') {
			return Object.keys(payload)
				.sort()
				.reduce((canonical, key) => {
					canonical[key] = this.canonicalizePayload(payload[key]);
					return canonical;
				}, {});
		}

		return payload;
	}

	/**
	 * Hash the request body/payload to verify it hasn't changed on retry
	 * @param {any} payload
	 * @returns {string} SHA-256 hash of serialized payload
	 */
	hashPayload(payload) {
		const serialized = typeof payload === 'string'
			? payload
			: JSON.stringify(this.canonicalizePayload(payload || {}));
		return crypto.createHash('sha256').update(serialized).digest('hex');
	}

	/**
	 * Retrieve a cached response.
	 * Throws a conflict error (409) if the key is reused with a different payload.
	 * @param {string} key - Idempotency key
	 * @param {any} currentPayload - Current request payload
	 * @returns {Promise<Object|null>} Cached record details, or null if not found/expired
	 */
	/**
	 * Retrieve a cached response.
	 * Throws a conflict error (409) if the key is reused with a different payload.
	 * @param {string} key - Idempotency key
	 * @param {any} currentPayload - Current request payload
	 * @returns {Object|Promise<Object|null>|null} Cached record details, or null if not found/expired
	 */
	get(key, currentPayload) {
		this.cleanup();
		const currentHash = this.hashPayload(currentPayload);

		const record = this.cache.get(key);
		if (record) {
			if (this.shouldDeleteExpiredRecord(record)) {
				this.cache.delete(key);
			} else {
				if (record.payloadHash !== currentHash) {
					const error = new Error('Idempotency key was reused with a different payload');
					error.code = 'IDEMPOTENCY_CONFLICT';
					error.statusCode = 409;
					throw error;
				}
				return record.state === 'completed' ? record : null;
			}
		}

		if (idempotencyStorageService.isEnabled()) {
			return idempotencyStorageService.getEntry(key, currentHash).then((durableRecord) => {
				if (durableRecord) {
					this.cache.set(key, durableRecord);
					return durableRecord;
				}
				return null;
			});
		}

		return null;
	}

	/**
	 * Reserve a key before request processing begins so retries cannot duplicate side effects.
	 * @param {string} key
	 * @param {any} payload
	 * @returns {{state: 'fresh'} | {state: 'pending', promise: Promise<Object>} | {state: 'completed', record: Object} | Promise<any>}
	 */
	reserve(key, payload) {
		this.cleanup();
		const payloadHash = this.hashPayload(payload);
		const ttl = this.getTtlMs();

		const existing = this.cache.get(key);
		if (existing) {
			if (this.shouldDeleteExpiredRecord(existing)) {
				this.cache.delete(key);
			} else {
				if (existing.payloadHash !== payloadHash) {
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

		if (idempotencyStorageService.isEnabled()) {
			return this._reserveDurable(key, payloadHash, ttl);
		}

		// Fast memory-only path (or fallback when Firestore is disabled)
		if (this.cache.size >= this.maxKeys) {
			const evicted = this.evictOldestCompletedRecord();
			if (!evicted) {
				const error = new Error('Server is currently processing too many requests with idempotency keys');
				error.code = 'IDEMPOTENCY_LIMIT_EXCEEDED';
				error.statusCode = 429;
				throw error;
			}
		}

		const now = Date.now();
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

	async _reserveDurable(key, payloadHash, ttl) {
		try {
			const durableRes = await idempotencyStorageService.reserveEntry(key, payloadHash, ttl);
			if (durableRes) {
				if (durableRes.state === 'conflict') {
					const error = new Error('Idempotency key was reused with a different payload');
					error.code = 'IDEMPOTENCY_CONFLICT';
					error.statusCode = 409;
					throw error;
				}

				if (durableRes.state === 'completed' && durableRes.record) {
					this.cache.set(key, durableRes.record);
					return { state: 'completed', record: durableRes.record };
				}

				if (durableRes.state === 'pending') {
					const existingLocal = this.getExistingLocalReservation(key, payloadHash);
					if (existingLocal) {
						return existingLocal;
					}

					if (this.cache.size >= this.maxKeys) {
						const evicted = this.evictOldestCompletedRecord();
						if (!evicted) {
							const error = new Error('Server is currently processing too many requests with idempotency keys');
							error.code = 'IDEMPOTENCY_LIMIT_EXCEEDED';
							error.statusCode = 429;
							throw error;
						}
					}

					let resolveCompletion;
					let rejectCompletion;
					const completionPromise = new Promise((resolve, reject) => {
						resolveCompletion = resolve;
						rejectCompletion = reject;
					});

					const pendingRecord = {
						payloadHash,
						state: 'pending',
						waiterCount: 1,
						createdAt: Date.now(),
						expiresAt: Date.now() + ttl,
						completionPromise,
						resolveCompletion,
						rejectCompletion,
					};
					this.cache.set(key, pendingRecord);

					// Poll Firestore for completion across replicas with a bounded wait timeout
					const pendingWaitMs = Math.min(ttl, 15000);
					idempotencyStorageService.waitForPendingCompletion(key, payloadHash, pendingWaitMs)
						.then((pollResult) => {
							if (pollResult.state === 'completed' && pollResult.record) {
								this.cache.set(key, pollResult.record);
								resolveCompletion(pollResult.record);
							} else if (pollResult.state === 'conflict') {
								const err = new Error('Idempotency key was reused with a different payload');
								err.code = 'IDEMPOTENCY_CONFLICT';
								err.statusCode = 409;
								this.cache.delete(key);
								rejectCompletion(err);
							} else {
								const err = new Error('Initial idempotent request failed before a replayable response was available');
								err.code = 'IDEMPOTENCY_RELEASED';
								err.statusCode = 409;
								this.cache.delete(key);
								rejectCompletion(err);
							}
						})
						.catch((pollErr) => {
							this.cache.delete(key);
							rejectCompletion(pollErr);
						});

					return { state: 'pending', promise: completionPromise };
				}

				// Fresh reservation claimed in Firestore
				if (durableRes.state === 'fresh') {
					if (this.cache.size >= this.maxKeys) {
						const evicted = this.evictOldestCompletedRecord();
						if (!evicted) {
							const error = new Error('Server is currently processing too many requests with idempotency keys');
							error.code = 'IDEMPOTENCY_LIMIT_EXCEEDED';
							error.statusCode = 429;
							throw error;
						}
					}

					let resolveCompletion;
					let rejectCompletion;
					const completionPromise = new Promise((resolve, reject) => {
						resolveCompletion = resolve;
						rejectCompletion = reject;
					});

					this.cache.set(key, {
						payloadHash,
						state: 'pending',
						claimToken: durableRes.claimToken,
						waiterCount: 0,
						createdAt: Date.now(),
						expiresAt: Date.now() + ttl,
						completionPromise,
						resolveCompletion,
						rejectCompletion,
					});

					return { state: 'fresh' };
				}
			}
		} catch (err) {
			if (err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'IDEMPOTENCY_LIMIT_EXCEEDED') {
				throw err;
			}
			console.warn('[IdempotencyService] Error during durable reserve (fail-open to memory):', err.message);
		}

		// Fallback to in-memory path if Firestore fails or returns null
		const existingLocal = this.getExistingLocalReservation(key, payloadHash);
		if (existingLocal) {
			return existingLocal;
		}

		if (this.cache.size >= this.maxKeys) {
			const evicted = this.evictOldestCompletedRecord();
			if (!evicted) {
				const error = new Error('Server is currently processing too many requests with idempotency keys');
				error.code = 'IDEMPOTENCY_LIMIT_EXCEEDED';
				error.statusCode = 429;
				throw error;
			}
		}

		const now = Date.now();
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
			this.evictOldestCompletedRecord();
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

		if (idempotencyStorageService.isEnabled()) {
			const claimToken = existing && existing.state === 'pending' ? existing.claimToken : undefined;
			idempotencyStorageService.setEntry(key, payloadHash, { statusCode, body, headers }, ttl, claimToken)
				.catch((err) => console.warn('[IdempotencyService] Error saving durable entry:', err.message));
		}

		console.debug(`[IdempotencyService] Cached result for key: ${idempotencyStorageService.hashKey(key)} (TTL: ${ttl}ms)`);
	}

	/**
	 * Release a pending key without caching a response so future retries can process normally.
	 * @param {string} key
	 * @param {any} payload
	 * @param {Error} [error]
	 */
	release(key, payload, error) {
		const existing = this.cache.get(key);
		const payloadHash = this.hashPayload(payload);

		if (existing && existing.state === 'pending' && existing.payloadHash === payloadHash) {
			this.cache.delete(key);
			if ((existing.waiterCount || 0) > 0 && typeof existing.rejectCompletion === 'function') {
				existing.rejectCompletion(error || new Error('Idempotency reservation released'));
			}
		}

		if (idempotencyStorageService.isEnabled()) {
			const claimToken = existing && existing.state === 'pending' ? existing.claimToken : undefined;
			idempotencyStorageService.releaseEntry(key, payloadHash, claimToken)
				.catch((err) => console.warn('[IdempotencyService] Error releasing durable entry:', err.message));
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
