'use strict';

/**
 * NewsDedupStorageService — Firestore-backed deduplication backend for news-monitor.
 *
 * Feature-gated: ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP=true required.
 * Fail-open: any Firestore error is caught and logged; dedup falls back to
 *   the in-memory cache (alert delivery is never blocked by storage errors).
 *
 * Collection: news-monitor-dedup
 * Document ID: the dedup key (e.g. "BTCUSDT:price_surge")
 *
 * Document schema:
 *   key        - string  — the dedup key
 *   createdAt  - Timestamp — when the dedup entry was first written
 *   expiresAt  - Timestamp — when the dedup entry expires (createdAt + TTL)
 */

const admin = require('firebase-admin');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const COLLECTION_NAME = 'news-monitor-dedup';
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
		}
	}
	return mergedRouting;
}

function mergeDeliveryData(existingData = {}, updatedData = {}, options = {}) {
	const deliveryChannels = Array.isArray(options.deliveryChannels) ? options.deliveryChannels : null;
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

// Lazy Firestore singleton (shared with AlertStorageService via firebase-admin)
let db = null;

function isEnabled() {
	return getRuntimeConfig().ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
}

/**
 * Initialize Firebase Admin (idempotent) and return Firestore client.
 * Reuses existing admin app if already initialized by AlertStorageService.
 * Returns null when the feature is disabled or initialization fails.
 *
 * @returns {FirebaseFirestore.Firestore | null}
 */
function getFirestore() {
	if (!isEnabled()) {
		return null;
	}

	if (db) {
		return db;
	}

	try {
		let credential;

		// Inline JSON (preferred for Render.com secret env vars)
		if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
			const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
			credential = admin.credential.cert(serviceAccount);
		}

		const appOptions = {};
		if (credential) {
			appOptions.credential = credential;
		}
		if (process.env.FIREBASE_PROJECT_ID) {
			appOptions.projectId = process.env.FIREBASE_PROJECT_ID;
		}

		if (!admin.apps.length) {
			admin.initializeApp(appOptions);
		}

		db = admin.firestore();
		console.debug('[NewsDedupStorageService] Firestore client initialized');
	} catch (error) {
		console.warn('[NewsDedupStorageService] Failed to initialize Firestore client:', error.message);
		db = null;
	}

	return db;
}

/**
 * Check if a dedup entry exists in Firestore and is not expired.
 *
 * Fail-open: returns false on any Firestore error (allows the alert through).
 *
 * @param {string} key - Dedup key (e.g. "BTCUSDT:price_surge")
 * @returns {Promise<boolean>} true if a valid (non-expired) entry exists
 */
async function hasEntry(key) {
	const entry = await getEntry(key);
	return entry !== null;
}

/**
 * Retrieve cached entry data and its absolute Firestore expiry.
 *
 * @param {string} key - Dedup key (e.g. "BTCUSDT:price_surge")
 * @returns {Promise<{data: Object, expiresAtMs: number}|null>}
 */
async function getEntryRecord(key) {
	const firestore = getFirestore();
	if (!firestore) {
		return null;
	}

	try {
		const docRef = firestore.collection(COLLECTION_NAME).doc(key);
		const doc = await docRef.get();

		if (!doc.exists) {
			return null;
		}

		const data = doc.data();
		if (!data || !data.expiresAt || typeof data.expiresAt.toMillis !== 'function') {
			return null;
		}

		const expiresAtMs = data.expiresAt.toMillis();
		const now = admin.firestore.Timestamp.now();
		if (expiresAtMs <= now.toMillis()) {
			// Expired — delete it asynchronously (fire-and-forget)
			docRef.delete().catch(err => {
				console.debug('[NewsDedupStorageService] Failed to delete expired entry:', err.message);
			});
			return null;
		}

		return {
			data: data.data || {},
			expiresAtMs,
		};
	} catch (error) {
		console.warn('[NewsDedupStorageService] getEntryRecord error (fail-open):', error.message);
		return null;
	}
}

/**
 * Retrieve cached entry data from Firestore if valid and not expired.
 *
 * Fail-open: returns null on any Firestore error.
 *
 * @param {string} key - Dedup key (e.g. "BTCUSDT:price_surge")
 * @returns {Promise<Object|null>} Stored data object or null if not found/expired
 */
async function getEntry(key) {
	const record = await getEntryRecord(key);
	return record ? record.data : null;
}

/**
 * Claim a dedup entry atomically, replacing it only when its TTL has expired.
 *
 * @param {string} key - Dedup key
 * @param {number} ttlMs - TTL in milliseconds
 * @param {string} [claimToken] - Optional owner token for a delivery lease
 * @returns {Promise<boolean>} true if claim succeeded, false if already claimed/exists
 */
async function claimEntry(key, ttlMs, claimToken) {
	const firestore = getFirestore();
	if (!firestore) {
		return false;
	}

	try {
		const now = admin.firestore.Timestamp.now();
		const expiresAtMs = now.toMillis() + ttlMs;
		const expiresAt = admin.firestore.Timestamp.fromMillis(expiresAtMs);
		const docRef = firestore.collection(COLLECTION_NAME).doc(key);
		const claimed = await firestore.runTransaction(async transaction => {
			const existing = await transaction.get(docRef);
			const existingData = existing.exists && existing.data();

			if (existing.exists && (typeof existingData?.expiresAt?.toMillis !== 'function'
				|| existingData.expiresAt.toMillis() > now.toMillis())) {
				return false;
			}

			transaction.set(docRef, {
				key,
				createdAt: now,
				expiresAt,
				data: claimToken ? { status: 'claiming', claimToken } : { status: 'claiming' },
			});
			return true;
		});
		if (!claimed) {
			console.debug('[NewsDedupStorageService] Dedup entry already exists during claim:', key);
			return false;
		}
		console.debug('[NewsDedupStorageService] Dedup entry claimed:', key);
		return true;
	} catch (error) {
		console.warn('[NewsDedupStorageService] claimEntry error (fail-open):', error.message);
		// Fail-open: allow claim to succeed so the replica can alert
		return true;
	}
}

/**
 * Write a dedup entry to Firestore.
 *
 * Fail-open: errors are logged and swallowed; alert delivery is not affected.
 *
 * Persistence state (`originalPersistedState`) transitions are guarded:
 *   - `pending` may be applied when the existing state is absent or `pending`.
 *   - terminal states (`owned`, `none`) overwrite any prior state, including
 *     stale `pending` writes that started before the terminal transition
 *     landed on another replica.
 *
 * @param {string} key - Dedup key
 * @param {number} ttlMs - TTL in milliseconds
 * @param {Object} data - Cache data payload to store
 * @param {{deliveryChannels?: string[]}} options - Optional claimed-channel delta scope
 * @returns {Promise<void>}
 */
async function setEntry(key, ttlMs, data, options = {}) {
	const firestore = getFirestore();
	if (!firestore) {
		return;
	}

	try {
		const now = admin.firestore.Timestamp.now();
		const expiresAtMs = now.toMillis() + ttlMs;
		const expiresAt = admin.firestore.Timestamp.fromMillis(expiresAtMs);

		await firestore.runTransaction(async transaction => {
			const docRef = firestore.collection(COLLECTION_NAME).doc(key);
			const existing = await transaction.get(docRef);
			const existingData = existing.exists ? existing.data() : null;
			const baseData = existingData?.data && typeof existingData.data === 'object'
				? existingData.data
				: {};
			const incomingData = data || {};
			const incomingState = incomingData.originalPersistedState;
			const existingState = baseData.originalPersistedState;

			const isTerminalIncoming = incomingState === 'owned' || incomingState === 'none';
			const isPendingIncoming = incomingState === 'pending';
			let baseForMerge = baseData;
			let incomingForMerge = incomingData;

			if (isPendingIncoming && (existingState === 'owned' || existingState === 'none')) {
				// Stale `pending` (fire-and-forget that lost the race to a terminal
				// write on another replica): drop the `originalPersistedState`
				// overwrite but still merge channel-scoped delivery/routing deltas
				// via the regular path.
				const { originalPersistedState: _drop, ...rest } = incomingData;
				incomingForMerge = rest;
			} else if (isTerminalIncoming && existingState === 'pending') {
				// Terminal write arriving after a still-pending predecessor: keep
				// the terminal value so concurrent pending writes cannot resurrect
				// ownership that has already been resolved.
				baseForMerge = { ...baseData, originalPersistedState: incomingState };
				const { originalPersistedState: _drop, ...rest } = incomingData;
				incomingForMerge = rest;
			}

			// Merge channel-scoped delivery/routing deltas so a retry cannot erase
			// concurrent field-scoped writes (e.g. `originalPersistedState`
			// committed by another replica between this transaction's read and
			// write).
			const mergedData = mergeDeliveryData(baseForMerge, incomingForMerge, options) || {};
			// Preserve the originalPersistedState transition resolved above
			// (e.g. dropping a stale `pending` or promoting an older `pending`
			// to the incoming terminal value) only when the merge did not
			// already carry it. Skip the propagation when the existing value is
			// absent so we do not introduce an explicit `undefined` field that
			// would silently propagate into the durable payload.
			if (!mergedData.originalPersistedState && baseForMerge.originalPersistedState) {
				mergedData.originalPersistedState = baseForMerge.originalPersistedState;
			}
			transaction.set(docRef, {
				key,
				createdAt: existingData?.createdAt ?? now,
				expiresAt,
				data: mergedData,
			});
		});
		console.debug('[NewsDedupStorageService] Dedup entry written with data:', key);
	} catch (error) {
		console.warn('[NewsDedupStorageService] setEntry error (fail-open):', error.message);
	}
}

/**
 * Update an existing dedup entry without extending its original TTL.
 *
 * @param {string} key - Dedup key
 * @param {Object} data - Updated cache payload
 * @param {{deliveryChannels?: string[], mergeFields?: string[], expectedField?: string, expectedValues?: string[], expectedExpirableField?: string}} options - Optional claimed-channel delta scope and expected-state guards
 * @returns {Promise<boolean>} true when an active entry was updated
 */
async function updateEntry(key, data, options = {}) {
	const firestore = getFirestore();
	if (!firestore) {
		return false;
	}

	try {
		const now = admin.firestore.Timestamp.now();
		const docRef = firestore.collection(COLLECTION_NAME).doc(key);
		return await firestore.runTransaction(async transaction => {
			const existing = await transaction.get(docRef);
			const existingData = existing.exists && existing.data();
			if (!existing.exists || !existingData?.expiresAt
				|| typeof existingData.expiresAt.toMillis !== 'function'
				|| existingData.expiresAt.toMillis() <= now.toMillis()) {
				return false;
			}

			let nextData;
			if (Array.isArray(options.mergeFields)) {
				if (options.expectedField !== undefined) {
					const currentValue = existingData.data
						? existingData.data[options.expectedField]
						: undefined;
					const allowed = Array.isArray(options.expectedValues)
						? options.expectedValues
						: [];
					const valueAllowed = currentValue === undefined || allowed.includes(currentValue);
					if (!valueAllowed) {
						// Allow takeover when an `expectedExpirableField` deadline has
						// expired so a crashed prior owner does not lock out
						// later redeliveries until the full dedup TTL expires.
						if (options.expectedExpirableField) {
							const deadline = existingData.data
								? existingData.data[options.expectedExpirableField]
								: undefined;
							const deadlineMs = typeof deadline === 'number'
								? deadline
								: Number.isFinite(deadline?.toMillis?.())
									? deadline.toMillis()
									: null;
							if (deadlineMs === null || deadlineMs > now.toMillis()) {
								return false;
							}
						} else {
							return false;
						}
					} else if (options.expectedExpirableField
						&& currentValue !== undefined
						&& Array.isArray(options.expectedExpirableValues)
						&& options.expectedExpirableValues.includes(currentValue)) {
						// The current value is one of the expirable allowed
						// states (e.g. `'claimed'`). Reject when its deadline
						// is still in the future so an active lease is not
						// stolen, allow takeover once the deadline has passed.
						const deadline = existingData.data
							? existingData.data[options.expectedExpirableField]
							: undefined;
						const deadlineMs = typeof deadline === 'number'
							? deadline
							: Number.isFinite(deadline?.toMillis?.())
								? deadline.toMillis()
								: null;
						if (deadlineMs === null || deadlineMs > now.toMillis()) {
							return false;
						}
					}
				}
				nextData = { ...(existingData.data || {}) };
				for (const field of options.mergeFields) {
					if (Object.prototype.hasOwnProperty.call(data, field)) {
						nextData[field] = data[field];
					}
				}
			} else {
				nextData = mergeDeliveryData(existingData.data, data, options) || null;
			}

			transaction.set(docRef, {
				key,
				createdAt: existingData.createdAt,
				expiresAt: existingData.expiresAt,
				data: nextData,
			});
			return true;
		});
	} catch (error) {
		console.warn('[NewsDedupStorageService] updateEntry error (fail-open):', error.message);
		return false;
	}
}

/**
 * Renew an active delivery lease without changing its payload.
 *
 * @param {string} key - Lease key
 * @param {number} ttlMs - Lease duration in milliseconds
 * @param {string} [claimToken] - Optional owner token that must match the active lease
 * @returns {Promise<boolean|null>} true when renewed, false when ownership loss is proven, null when storage state is indeterminate
 */
async function renewEntry(key, ttlMs, claimToken) {
	const firestore = getFirestore();
	if (!firestore) {
		return false;
	}

	try {
		const now = admin.firestore.Timestamp.now();
		const expiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + ttlMs);
		const docRef = firestore.collection(COLLECTION_NAME).doc(key);
		return await firestore.runTransaction(async transaction => {
			const existing = await transaction.get(docRef);
			const existingData = existing.exists && existing.data();
			if (!existing.exists || !existingData?.expiresAt
				|| typeof existingData.expiresAt.toMillis !== 'function'
				|| existingData.expiresAt.toMillis() <= now.toMillis()) {
				return false;
			}
			if (claimToken && existingData.data?.claimToken !== claimToken) {
				return false;
			}

			transaction.set(docRef, {
				key,
				createdAt: existingData.createdAt,
				expiresAt,
				data: existingData.data || null,
			});
			return true;
		});
	} catch (error) {
		console.warn('[NewsDedupStorageService] renewEntry error (fail-open):', error.message);
		return null;
	}
}

/**
 * Delete a dedup entry (mainly for testing / manual invalidation).
 *
 * @param {string} key - Dedup key
 * @returns {Promise<void>}
 */
async function deleteEntry(key) {
	const firestore = getFirestore();
	if (!firestore) {
		return;
	}

	try {
		await firestore.collection(COLLECTION_NAME).doc(key).delete();
	} catch (error) {
		console.warn('[NewsDedupStorageService] deleteEntry error:', error.message);
	}
}

/**
 * Checks if the service is ready for operation (i.e. Firestore is initialized).
 * @returns {boolean}
 */
function isReady() {
	if (!isEnabled()) {
		return false;
	}
	return getFirestore() !== null;
}

module.exports = {
	isEnabled,
	isReady,
	hasEntry,
	getEntryRecord,
	getEntry,
	claimEntry,
	setEntry,
	updateEntry,
	renewEntry,
	deleteEntry,
	COLLECTION_NAME,
	// Exported for testing — reset the cached db singleton between tests
	_resetForTesting() {
		db = null;
	},
};
