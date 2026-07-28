'use strict';

/**
 * IdempotencyStorageService — Firestore-backed persistence layer for IdempotencyService.
 *
 * Feature-gated: ENABLE_FIRESTORE_IDEMPOTENCY=true (or ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE=true).
 * Fail-open: all Firestore operations catch errors and log warnings using hashed keys.
 *   API endpoints and alert delivery will fail-open to in-memory idempotency.
 *
 * Collection: idempotency_keys
 * Document ID: SHA-256 hash of "idempotency:<rawKey>" (raw caller keys are never stored as document IDs or logged).
 *
 * Document Schema:
 *   docId         - string (SHA-256 of idempotency:<key>)
 *   payloadHash   - string (SHA-256 of canonicalized request fingerprint)
 *   state         - string ('pending' | 'completed')
 *   statusCode    - number (e.g. 200, 202, 400)
 *   responseBody  - object|string|null
 *   headers       - object
 *   createdAt     - Timestamp
 *   expiresAt     - Timestamp
 *   updatedAt     - Timestamp
 */

const crypto = require('crypto');
const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('./firestoreConfig');

const COLLECTION_NAME = 'idempotency_keys';
const PENDING_STALE_TIMEOUT_MS = 180000; // 3 minutes max pending claim lifetime to cover 120s webhook limits

let db = null;

function isEnabled() {
	return process.env.ENABLE_FIRESTORE_IDEMPOTENCY === 'true'
		|| process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE === 'true';
}

function hashKey(key) {
	if (typeof key !== 'string') {
		key = String(key || '');
	}
	return crypto.createHash('sha256').update(`idempotency:${key}`).digest('hex');
}

/**
 * Initialize Firebase Admin (idempotent) and return Firestore client.
 * Reuses existing admin app if initialized by other storage services.
 * Returns null when feature is disabled or credentials missing/invalid.
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
		console.debug('[IdempotencyStorageService] Firestore client initialized');
	} catch (error) {
		console.warn('[IdempotencyStorageService] Failed to initialize Firestore client:', error.message);
		db = null;
	}

	return db;
}

function isReady() {
	if (!isEnabled()) {
		return false;
	}
	return isFirestoreConfigured() && getFirestore() !== null;
}

function getStorageStatus() {
	const enabled = isEnabled();
	const configured = isFirestoreConfigured();

	return {
		enabled,
		configured,
		ready: enabled && configured,
		status: enabled ? (configured ? 'ready' : 'misconfigured') : 'disabled',
		mode: enabled && configured ? 'durable' : 'ephemeral',
		backend: enabled && configured ? 'firestore' : 'memory',
	};
}

/**
 * Atomically claim or reserve an idempotency key in Firestore.
 *
 * @param {string} key - Raw idempotency key (hashed internally)
 * @param {string} payloadHash - SHA-256 hash of canonicalized request payload
 * @param {number} ttlMs - Time to live in ms
 * @returns {Promise<{state: 'fresh' | 'pending' | 'completed' | 'conflict', record?: Object}|null>}
 */
async function reserveEntry(key, payloadHash, ttlMs) {
	const firestore = getFirestore();
	if (!firestore) {
		return null;
	}

	const docId = hashKey(key);
	const docRef = firestore.collection(COLLECTION_NAME).doc(docId);

	try {
		const result = await firestore.runTransaction(async (transaction) => {
			const snapshot = await transaction.get(docRef);
			const nowMs = Date.now();
			const nowTimestamp = admin.firestore.Timestamp.fromMillis(nowMs);
			const expiresAtTimestamp = admin.firestore.Timestamp.fromMillis(nowMs + ttlMs);

			if (snapshot.exists) {
				const data = snapshot.data();
				const expiresAtMs = data.expiresAt && typeof data.expiresAt.toMillis === 'function'
					? data.expiresAt.toMillis()
					: 0;

				// Check if non-expired existing claim exists
				if (expiresAtMs > nowMs) {
					if (data.payloadHash !== payloadHash) {
						return { state: 'conflict' };
					}

					if (data.state === 'completed') {
						return {
							state: 'completed',
							record: {
								payloadHash: data.payloadHash,
								state: 'completed',
								statusCode: data.statusCode,
								responseBody: data.responseBody,
								headers: data.headers || {},
								createdAt: data.createdAt ? data.createdAt.toMillis() : nowMs,
								expiresAt: expiresAtMs,
							},
						};
					}

					// Check if pending claim is active vs stale
					const createdAtMs = data.createdAt && typeof data.createdAt.toMillis === 'function'
						? data.createdAt.toMillis()
						: 0;
					if (nowMs - createdAtMs < PENDING_STALE_TIMEOUT_MS) {
						return { state: 'pending', record: data };
					}
					// Stale pending claim: overwrite below
				}
			}

			// Create fresh pending claim
			transaction.set(docRef, {
				docId,
				payloadHash,
				state: 'pending',
				createdAt: nowTimestamp,
				expiresAt: expiresAtTimestamp,
				updatedAt: nowTimestamp,
			});

			return { state: 'fresh' };
		});

		return result;
	} catch (error) {
		console.warn(`[IdempotencyStorageService] reserveEntry error for hash ${docId} (fail-open):`, error.message);
		return null;
	}
}

/**
 * Poll Firestore for an in-flight pending claim created by another replica.
 *
 * @param {string} key - Raw key
 * @param {string} payloadHash - Canonical request hash
 * @param {number} [maxWaitMs=15000] - Bounded maximum wait time in ms
 * @param {number} [pollIntervalMs=300] - Polling interval in ms
 * @returns {Promise<{state: 'completed' | 'conflict' | 'released' | 'timeout', record?: Object}>}
 */
async function waitForPendingCompletion(key, payloadHash, maxWaitMs = 15000, pollIntervalMs = 300) {
	const firestore = getFirestore();
	if (!firestore) {
		return { state: 'released' };
	}

	const docId = hashKey(key);
	const docRef = firestore.collection(COLLECTION_NAME).doc(docId);
	const startTime = Date.now();

	while (Date.now() - startTime < maxWaitMs) {
		try {
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
			const snapshot = await docRef.get();
			if (!snapshot.exists) {
				return { state: 'released' };
			}

			const data = snapshot.data();
			if (data.payloadHash !== payloadHash) {
				return { state: 'conflict' };
			}

			if (data.state === 'completed') {
				return {
					state: 'completed',
					record: {
						payloadHash: data.payloadHash,
						state: 'completed',
						statusCode: data.statusCode,
						responseBody: data.responseBody,
						headers: data.headers || {},
						createdAt: data.createdAt ? data.createdAt.toMillis() : Date.now(),
						expiresAt: data.expiresAt ? data.expiresAt.toMillis() : Date.now(),
					},
				};
			}
		} catch (error) {
			console.warn(`[IdempotencyStorageService] waitForPendingCompletion poll error for hash ${docId}:`, error.message);
			return { state: 'released' };
		}
	}

	return { state: 'timeout' };
}

/**
 * Update or set a completed response in Firestore.
 *
 * @param {string} key - Raw key
 * @param {string} payloadHash - Canonical request hash
 * @param {Object} responseDetails - { statusCode, body, headers }
 * @param {number} ttlMs - TTL in ms
 * @returns {Promise<void>}
 */
async function setEntry(key, payloadHash, { statusCode, body, headers }, ttlMs) {
	const firestore = getFirestore();
	if (!firestore) {
		return;
	}

	const docId = hashKey(key);
	const docRef = firestore.collection(COLLECTION_NAME).doc(docId);

	try {
		const nowMs = Date.now();
		const now = admin.firestore.Timestamp.fromMillis(nowMs);
		const expiresAt = admin.firestore.Timestamp.fromMillis(nowMs + ttlMs);

		const cleanHeaders = {};
		if (headers && typeof headers === 'object') {
			for (const [k, v] of Object.entries(headers)) {
				if (v !== undefined) {
					cleanHeaders[k] = v;
				}
			}
		}

		await docRef.set({
			docId,
			payloadHash,
			state: 'completed',
			statusCode,
			responseBody: body !== undefined ? body : null,
			headers: cleanHeaders,
			createdAt: now,
			expiresAt,
			updatedAt: now,
		});
		console.debug(`[IdempotencyStorageService] Completed record stored for hash: ${docId}`);
	} catch (error) {
		console.warn(`[IdempotencyStorageService] setEntry error for hash ${docId} (fail-open):`, error.message);
	}
}

/**
 * Release a pending claim from Firestore on failure so retries can process normally.
 *
 * @param {string} key - Raw key
 * @param {string} payloadHash - Canonical request hash
 * @returns {Promise<void>}
 */
async function releaseEntry(key, payloadHash) {
	const firestore = getFirestore();
	if (!firestore) {
		return;
	}

	const docId = hashKey(key);
	const docRef = firestore.collection(COLLECTION_NAME).doc(docId);

	try {
		const snapshot = await docRef.get();
		if (snapshot.exists) {
			const data = snapshot.data();
			if (data.state === 'pending' && data.payloadHash === payloadHash) {
				await docRef.delete();
				console.debug(`[IdempotencyStorageService] Released pending record for hash: ${docId}`);
			}
		}
	} catch (error) {
		console.warn(`[IdempotencyStorageService] releaseEntry error for hash ${docId} (fail-open):`, error.message);
	}
}

/**
 * Retrieve a stored record from Firestore if valid and completed.
 *
 * @param {string} key
 * @param {string} payloadHash
 * @returns {Promise<Object|null>}
 */
async function getEntry(key, payloadHash) {
	const firestore = getFirestore();
	if (!firestore) {
		return null;
	}

	const docId = hashKey(key);
	const docRef = firestore.collection(COLLECTION_NAME).doc(docId);

	try {
		const snapshot = await docRef.get();
		if (!snapshot.exists) {
			return null;
		}

		const data = snapshot.data();
		const nowMs = Date.now();
		const expiresAtMs = data.expiresAt && typeof data.expiresAt.toMillis === 'function'
			? data.expiresAt.toMillis()
			: 0;

		if (expiresAtMs <= nowMs) {
			docRef.delete().catch(() => {});
			return null;
		}

		if (data.payloadHash !== payloadHash) {
			const error = new Error('Idempotency key was reused with a different payload');
			error.code = 'IDEMPOTENCY_CONFLICT';
			error.statusCode = 409;
			throw error;
		}

		if (data.state === 'completed') {
			return {
				payloadHash: data.payloadHash,
				state: 'completed',
				statusCode: data.statusCode,
				responseBody: data.responseBody,
				headers: data.headers || {},
				createdAt: data.createdAt ? data.createdAt.toMillis() : nowMs,
				expiresAt: expiresAtMs,
			};
		}

		return null;
	} catch (error) {
		if (error.code === 'IDEMPOTENCY_CONFLICT') {
			throw error;
		}
		console.warn(`[IdempotencyStorageService] getEntry error for hash ${docId} (fail-open):`, error.message);
		return null;
	}
}

module.exports = {
	isEnabled,
	isReady,
	hashKey,
	getStorageStatus,
	reserveEntry,
	waitForPendingCompletion,
	setEntry,
	releaseEntry,
	getEntry,
	COLLECTION_NAME,
	_resetForTesting() {
		db = null;
	},
};
