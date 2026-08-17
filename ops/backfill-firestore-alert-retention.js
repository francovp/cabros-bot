'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');

const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 400;
const COLLECTIONS = [
	{ name: 'alerts', timestampField: 'receivedAt' },
	{ name: 'alertReplays', timestampField: 'replayedAt' },
	{
		name: 'tradingviewJobs',
		timestampField: 'createdAt',
		retentionDays: 1 / 24,
		shouldBackfill: (data) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(data.status),
	},
];

function getRetentionDays(rawValue = process.env.ALERT_STORAGE_RETENTION_DAYS) {
	if (rawValue === undefined) {
		return DEFAULT_RETENTION_DAYS;
	}

	const normalizedValue = String(rawValue).trim();
	const parsedValue = Number(normalizedValue);
	if (!/^\d+$/.test(normalizedValue)
		|| !Number.isSafeInteger(parsedValue)
		|| parsedValue < 1
		|| parsedValue > MAX_RETENTION_DAYS) {
		console.warn(JSON.stringify({
			event: 'firestore_alert_retention_invalid_config',
			setting: 'ALERT_STORAGE_RETENTION_DAYS',
			fallback: DEFAULT_RETENTION_DAYS,
		}));
		return DEFAULT_RETENTION_DAYS;
	}

	return parsedValue;
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

function buildRetentionExpiry(data, timestampField, retentionDays = getRetentionDays(), fallbackTimestamp = null) {
	const eventMillis = getTimestampMillis(data && data[timestampField])
		?? getTimestampMillis(fallbackTimestamp);
	if (eventMillis === null) {
		return null;
	}

	return admin.firestore.Timestamp.fromDate(new Date(eventMillis + (retentionDays * DAY_MS)));
}

async function backfillCollection(firestore, collectionName, timestampField, options = {}) {
	const retentionDays = options.retentionDays ?? getRetentionDays();
	const pageSize = options.pageSize ?? PAGE_SIZE;
	const shouldBackfill = options.shouldBackfill || (() => true);
	const result = { scanned: 0, updated: 0, skipped: 0, existing: 0 };
	let lastDocument = null;

	while (true) {
		// Order by document ID so legacy documents missing the event timestamp are scanned and reported.
		let query = firestore.collection(collectionName).orderBy('__name__').limit(pageSize);
		if (lastDocument) {
			query = query.startAfter(lastDocument);
		}

		const snapshot = await query.get();
		if (snapshot.empty) {
			break;
		}

		const batch = firestore.batch();
		let batchUpdates = 0;
		for (const document of snapshot.docs) {
			result.scanned += 1;
			const data = document.data() || {};
			if (!shouldBackfill(data)) {
				continue;
			}
			const currentExpiryMillis = getTimestampMillis(data.expiresAt);
			const expiresAt = buildRetentionExpiry(data, timestampField, retentionDays, document.createTime);
			const update = {};
			if (expiresAt) {
				const nextExpiryMillis = getTimestampMillis(expiresAt);
				if (currentExpiryMillis === null || nextExpiryMillis < currentExpiryMillis) {
					update.expiresAt = expiresAt;
				}
			} else if (currentExpiryMillis === null) {
				result.skipped += 1;
			}

			if (collectionName === 'alertReplays'
				&& Object.prototype.hasOwnProperty.call(data, 'idempotencyKey')) {
				if (typeof data.idempotencyKey === 'string'
					&& typeof data.idempotencyKeyHash !== 'string') {
					update.idempotencyKeyHash = crypto.createHash('sha256').update(data.idempotencyKey).digest('hex');
				}
				update.idempotencyKey = admin.firestore.FieldValue.delete();
			}

			if (Object.keys(update).length === 0) {
				if (currentExpiryMillis !== null) {
					result.existing += 1;
				}
				continue;
			}

			batch.update(document.ref, update);
			batchUpdates += 1;
			result.updated += 1;
		}

		if (batchUpdates > 0) {
			await batch.commit();
		}

		if (snapshot.docs.length < pageSize) {
			break;
		}
		lastDocument = snapshot.docs.at(-1);
	}

	return result;
}

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

async function main() {
	const firestore = initializeFirestore();
	const retentionDays = getRetentionDays();
	const collections = {};

	for (const collection of COLLECTIONS) {
		try {
			collections[collection.name] = await backfillCollection(
				firestore,
				collection.name,
				collection.timestampField,
				{
					retentionDays: collection.retentionDays ?? retentionDays,
					shouldBackfill: collection.shouldBackfill,
				},
			);
		} catch (error) {
			console.error(JSON.stringify({
				event: 'firestore_alert_retention_backfill_failed',
				collection: collection.name,
				error: error.message,
			}));
			throw error;
		}
	}

	const skipped = Object.values(collections).reduce((total, collection) => total + collection.skipped, 0);
	if (skipped > 0) {
		throw new Error(`Retention backfill skipped ${skipped} document(s) without a usable event timestamp`);
	}

	console.log(JSON.stringify({
		event: 'firestore_alert_retention_backfill_completed',
		retentionDays,
		collections,
	}));
}

if (require.main === module) {
	main().catch((error) => {
		console.error(JSON.stringify({
			event: 'firestore_alert_retention_backfill_failed',
			error: error.message,
		}));
		process.exitCode = 1;
	});
}

module.exports = {
	backfillCollection,
	buildRetentionExpiry,
	getRetentionDays,
};
