'use strict';

/**
 * backfill-operational-collection-retention.js
 *
 * Backfills the `expiresAt` field on legacy documents in the two operational
 * collections that use Firestore TTL:
 *
 *   - idempotency_keys  — defaults to WEBHOOK_IDEMPOTENCY_TTL_MS (5 min) from createdAt
 *   - news-monitor-dedup — defaults to NEWS_CACHE_TTL_HOURS (6 h) from createdAt
 *
 * Both collections write `expiresAt` on document creation, so legacy documents
 * only exist when the service was running an older version that did not set the
 * field. The backfill is a safety measure and is idempotent: documents that
 * already have a future `expiresAt` are left unchanged.
 *
 * Active pending idempotency claims (`state === 'pending'` and `createdAt` within
 * PENDING_STALE_TIMEOUT_MS) are left untouched — their current `expiresAt` is
 * already set by the reservation logic and must not be shortened.
 *
 * Run via: ops/configure-operational-collection-retention.sh (with BACKFILL=true)
 * or directly: node ops/backfill-operational-collection-retention.js
 */

const admin = require('firebase-admin');

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 400;
const PENDING_STALE_TIMEOUT_MS = 180_000; // 3 min — mirrors IdempotencyStorageService

// Defaults mirror service defaults; operators may override via env vars.
const DEFAULT_IDEMPOTENCY_TTL_MS = 300_000; // 5 min  (WEBHOOK_IDEMPOTENCY_TTL_MS default)
const MAX_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 1 day hard cap

const DEFAULT_DEDUP_TTL_HOURS = 6; // NEWS_CACHE_TTL_HOURS default
const MAX_DEDUP_TTL_HOURS = 720; // 30 days hard cap

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseIdempotencyTtlMs(raw = process.env.WEBHOOK_IDEMPOTENCY_TTL_MS) {
	const val = Number(raw);
	if (!Number.isFinite(val) || val <= 0 || val > MAX_IDEMPOTENCY_TTL_MS) {
		return DEFAULT_IDEMPOTENCY_TTL_MS;
	}
	return Math.floor(val);
}

function parseDedupTtlMs(raw = process.env.NEWS_CACHE_TTL_HOURS) {
	const val = Number(raw);
	if (!Number.isFinite(val) || val <= 0 || val > MAX_DEDUP_TTL_HOURS) {
		return DEFAULT_DEDUP_TTL_HOURS * 60 * 60 * 1000;
	}
	return Math.floor(val * 60 * 60 * 1000);
}

function getTimestampMillis(value) {
	if (value && typeof value.toMillis === 'function') {
		const millis = value.toMillis();
		return Number.isFinite(millis) ? millis : null;
	}
	if (value && typeof value.toDate === 'function') {
		const millis = value.toDate().getTime();
		return Number.isFinite(millis) ? millis : null;
	}
	if (value instanceof Date) {
		const millis = value.getTime();
		return Number.isFinite(millis) ? millis : null;
	}
	return null;
}

// ─── Backfill logic ──────────────────────────────────────────────────────────

/**
 * Backfill `expiresAt` on documents in a collection using the given TTL.
 *
 * @param {admin.firestore.Firestore} firestore
 * @param {string} collectionName
 * @param {number} ttlMs  — expiry offset from `createdAt` (milliseconds)
 * @param {object} [options]
 * @param {boolean} [options.protectActivePending]  — skip active pending idempotency claims
 * @returns {Promise<{scanned: number, updated: number, skipped: number, existing: number}>}
 */
async function backfillCollection(firestore, collectionName, ttlMs, options = {}) {
	const { protectActivePending = false } = options;
	const result = { scanned: 0, updated: 0, skipped: 0, existing: 0 };
	let lastDocument = null;
	const nowMs = Date.now();

	while (true) {
		let query = firestore.collection(collectionName).orderBy('__name__').limit(PAGE_SIZE);
		if (lastDocument) {
			query = query.startAfter(lastDocument);
		}

		const snapshot = await query.get();
		if (snapshot.empty) {
			break;
		}

		const batch = firestore.batch();
		let batchUpdates = 0;

		for (const doc of snapshot.docs) {
			result.scanned += 1;
			const data = doc.data() || {};
			const currentExpiryMs = getTimestampMillis(data.expiresAt);

			// Skip documents that already have a future expiresAt.
			if (currentExpiryMs !== null && currentExpiryMs > nowMs) {
				result.existing += 1;
				continue;
			}

			// Protect active pending idempotency claims from being shortened.
			if (protectActivePending && data.state === 'pending') {
				const createdMs = getTimestampMillis(data.createdAt) ?? 0;
				if (nowMs - createdMs < PENDING_STALE_TIMEOUT_MS) {
					result.skipped += 1;
					continue;
				}
			}

			// Compute the baseline timestamp for the TTL offset.
			const baseMs = getTimestampMillis(data.createdAt)
				?? getTimestampMillis(doc.createTime)
				?? nowMs;

			const newExpiresAt = admin.firestore.Timestamp.fromMillis(baseMs + ttlMs);
			batch.update(doc.ref, { expiresAt: newExpiresAt });
			batchUpdates += 1;
			result.updated += 1;
		}

		if (batchUpdates > 0) {
			await batch.commit();
		}

		if (snapshot.docs.length < PAGE_SIZE) {
			break;
		}
		lastDocument = snapshot.docs.at(-1);
	}

	return result;
}

// ─── Firebase init ───────────────────────────────────────────────────────────

function initializeFirestore() {
	let credential;
	if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
		credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
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

	return admin.firestore();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const firestore = initializeFirestore();
	const idempotencyTtlMs = parseIdempotencyTtlMs();
	const dedupTtlMs = parseDedupTtlMs();

	const collections = {};

	// idempotency_keys — protect active pending claims from TTL shortening
	try {
		collections.idempotency_keys = await backfillCollection(
			firestore,
			'idempotency_keys',
			idempotencyTtlMs,
			{ protectActivePending: true },
		);
	} catch (error) {
		console.error(JSON.stringify({
			event: 'operational_retention_backfill_failed',
			collection: 'idempotency_keys',
			error: error.message,
		}));
		throw error;
	}

	// news-monitor-dedup — no active-pending concept; all documents use createdAt
	try {
		collections['news-monitor-dedup'] = await backfillCollection(
			firestore,
			'news-monitor-dedup',
			dedupTtlMs,
		);
	} catch (error) {
		console.error(JSON.stringify({
			event: 'operational_retention_backfill_failed',
			collection: 'news-monitor-dedup',
			error: error.message,
		}));
		throw error;
	}

	console.log(JSON.stringify({
		event: 'operational_retention_backfill_completed',
		idempotencyTtlMs,
		dedupTtlMs,
		collections,
	}));
}

if (require.main === module) {
	main().catch((error) => {
		console.error(JSON.stringify({
			event: 'operational_retention_backfill_failed',
			error: error.message,
		}));
		process.exitCode = 1;
	});
}

module.exports = {
	backfillCollection,
	parseIdempotencyTtlMs,
	parseDedupTtlMs,
};
