'use strict';

const admin = require('firebase-admin');
const { round10 } = require('../../controllers/helpers');
const { resolveRemoteOverride } = require('../remoteConfig/resolveRemoteOverride');
const { firestoreWriteMetricsService } = require('./FirestoreWriteMetricsService');
const { classifyFirestoreError, FIRESTORE_ERROR_CATEGORIES } = require('./firestoreErrorCategories');
const sentryService = require('../monitoring/SentryService');

const DAILY_COLLECTION_NAME = 'tradingSignalOutcomesDaily';
const SOURCE_COLLECTION_NAME = 'tradingSignalOutcomes';

const DEFAULT_ROLLUP_TTL_DAYS = 180;
const MIN_ROLLUP_TTL_DAYS = 30;
const MAX_ROLLUP_TTL_DAYS = 365;
const MAX_TREND_DAYS = 180;
const DEFAULT_TREND_DAYS = 30;

const VALID_TREND_WINDOWS = Object.freeze(['1h', '4h', '1D', '1W']);

const WINDOW_MATURITY_MS = Object.freeze({
	'1h': 60 * 60 * 1000,
	'4h': 4 * 60 * 60 * 1000,
	'1D': 24 * 60 * 60 * 1000,
	'1W': 7 * 24 * 60 * 60 * 1000,
});

const lastUnfinishedDocByWindow = new Map();

function isOutcomeRollupEnabled() {
	const remote = resolveRemoteOverride('SIGNAL_OUTCOME_ROLLUP_ENABLED');
	if (typeof remote === 'boolean') {
		return remote;
	}
	return process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED !== 'false';
}

function getRollupTtlDays() {
	const remote = resolveRemoteOverride('SIGNAL_OUTCOME_ROLLUP_TTL_DAYS');
	const configured = typeof remote === 'number'
		? remote
		: Number(process.env.SIGNAL_OUTCOME_ROLLUP_TTL_DAYS);

	if (Number.isFinite(configured) && configured >= MIN_ROLLUP_TTL_DAYS && configured <= MAX_ROLLUP_TTL_DAYS) {
		return Math.floor(configured);
	}
	return DEFAULT_ROLLUP_TTL_DAYS;
}

function buildDailyDocId(dateStr, bucket, window) {
	const safeDate = String(dateStr).trim();
	const safeBucket = String(bucket || 'all')
		.trim()
		.toLowerCase()
		.replace(/[\/\s#?]+/g, '_')
		.replace(/[^a-z0-9_-]/g, '_');
	const safeWindow = String(window || '1D').trim();
	return `${safeDate}_${safeBucket || 'all'}_${safeWindow}`;
}

function isCohortMature(dateStr, window, now = Date.now()) {
	const delayMs = WINDOW_MATURITY_MS[window];
	if (delayMs === undefined) return false;

	const parts = String(dateStr).split('-');
	if (parts.length !== 3) return false;
	const year = parseInt(parts[0], 10);
	const month = parseInt(parts[1], 10) - 1;
	const day = parseInt(parts[2], 10);
	if (isNaN(year) || isNaN(month) || isNaN(day)) return false;

	const endOfDayUtc = Date.UTC(year, month, day, 23, 59, 59, 999);
	const matureTimestamp = endOfDayUtc + delayMs;

	const nowMs = now instanceof Date ? now.getTime() : Number(now);
	return nowMs >= matureTimestamp;
}

function matchesBucket(data, bucket) {
	if (!bucket || bucket === 'all') return true;
	const b = String(bucket).trim().toLowerCase();
	if (data.assetClass && String(data.assetClass).trim().toLowerCase() === b) return true;
	if (data.setupType && String(data.setupType).trim().toLowerCase() === b) return true;
	if (data.side && String(data.side).trim().toLowerCase() === b) return true;
	return false;
}

function computeDailyMetrics(docs, window, bucket = 'all') {
	let signals = 0;
	let evaluated = 0;
	let wins = 0;
	let losses = 0;
	let invalidated = 0;
	let pending = 0;
	let totalMfe = 0;
	let countMfe = 0;
	let totalMae = 0;
	let countMae = 0;
	let totalReturn = 0;
	let countReturn = 0;

	for (const doc of docs) {
		const data = typeof doc.data === 'function' ? doc.data() : doc;
		if (!matchesBucket(data, bucket)) continue;

		const outcomeMap = data.outcomes || {};
		const winOutcome = outcomeMap[window];

		// If this record did not configure the requested window, exclude it from this window's metrics
		if (!winOutcome) {
			continue;
		}

		signals++;

		if (winOutcome.status === 'pending') {
			pending++;
			continue;
		}

		if (winOutcome.status === 'invalidated' || winOutcome.status === 'unavailable') {
			invalidated++;
			continue;
		}

		if (winOutcome.status === 'evaluated') {
			evaluated++;
			const ret = typeof winOutcome.returnPercent === 'number' && Number.isFinite(winOutcome.returnPercent)
				? winOutcome.returnPercent
				: (typeof winOutcome.return === 'number' && Number.isFinite(winOutcome.return) ? winOutcome.return : null);

			if (ret !== null) {
				totalReturn += ret;
				countReturn++;
				if (ret > 0) {
					wins++;
				} else if (ret < 0) {
					losses++;
				}
			} else if (winOutcome.targetHit === true || winOutcome.firstHit === 'target') {
				wins++;
			} else if (winOutcome.stopHit === true || winOutcome.firstHit === 'stop') {
				losses++;
			}

			const mfe = typeof winOutcome.mfe === 'number' && Number.isFinite(winOutcome.mfe)
				? winOutcome.mfe
				: (typeof winOutcome.maxFavorableExcursion === 'number' && Number.isFinite(winOutcome.maxFavorableExcursion) ? winOutcome.maxFavorableExcursion : null);
			if (mfe !== null) {
				totalMfe += mfe;
				countMfe++;
			}

			const mae = typeof winOutcome.mae === 'number' && Number.isFinite(winOutcome.mae)
				? winOutcome.mae
				: (typeof winOutcome.maxAdverseExcursion === 'number' && Number.isFinite(winOutcome.maxAdverseExcursion) ? winOutcome.maxAdverseExcursion : null);
			if (mae !== null) {
				totalMae += mae;
				countMae++;
			}
		}
	}

	const hitRatePercent = evaluated > 0
		? round10((wins / evaluated) * 100, -2)
		: null;

	const avgMfe = countMfe > 0 ? round10(totalMfe / countMfe, -2) : null;
	const avgMae = countMae > 0 ? round10(totalMae / countMae, -2) : null;
	const avgReturnPercent = countReturn > 0 ? round10(totalReturn / countReturn, -4) : null;

	return {
		signals,
		sampleSize: evaluated,
		wins,
		losses,
		invalidated,
		pending,
		hitRatePercent,
		avgMfe,
		avgMae,
		avgReturnPercent,
	};
}

function getMaturityDaysOffsets(window) {
	switch (window) {
		case '1h':
		case '4h':
			return [1, 2];
		case '1D':
			return [2, 3];
		case '1W':
			return [8, 9];
		default:
			return [1, 2];
	}
}

function getDateStringFromOffset(nowMs, daysOffset) {
	const d = new Date(nowMs - daysOffset * 24 * 60 * 60 * 1000);
	return d.toISOString().split('T')[0];
}

async function rollupOutcomesDaily(options = {}) {
	const { firestore, date, window, bucket = 'all', force = false, now = new Date(), ttlDays: customTtlDays, buckets } = options;
	if (!isOutcomeRollupEnabled()) {
		return { skipped: true, reason: 'disabled', scannedCohorts: 0, finalizedSnapshots: 0, skippedCohorts: 0 };
	}
	if (!firestore) {
		return { skipped: true, reason: 'firestore_unconfigured', scannedCohorts: 0, finalizedSnapshots: 0, skippedCohorts: 0 };
	}

	try {
		const nowMs = now instanceof Date ? now.getTime() : Number(now);
		const windows = window ? [window] : VALID_TREND_WINDOWS;
		const results = [];
		let scannedCohorts = 0;
		let finalizedSnapshots = 0;
		let skippedCohorts = 0;

		const ttlDays = customTtlDays || getRollupTtlDays();
		const expiresAt = admin.firestore.Timestamp.fromDate(new Date(nowMs + ttlDays * 24 * 60 * 60 * 1000));
		const batch = firestore.batch ? firestore.batch() : null;

		for (const targetWin of windows) {
			const candidateDates = date
				? [date]
				: getMaturityDaysOffsets(targetWin).map((offset) => getDateStringFromOffset(nowMs, offset));

			if (!date) {
				try {
					const cursorKey = `${targetWin}_${bucket || 'all'}`;
					let query = firestore
						.collection(DAILY_COLLECTION_NAME)
						.where('evaluationWindow', '==', targetWin);

					if (bucket && bucket !== 'all') {
						query = query.where('bucket', '==', String(bucket).trim().toLowerCase());
					}

					query = query.where('finalized', '==', false);
					const lastDoc = lastUnfinishedDocByWindow.get(cursorKey);
					if (lastDoc && typeof query.startAfter === 'function') {
						query = query.startAfter(lastDoc);
					}
					query = query.limit(10);
					let unfinishedSnapshot = await query.get();

					if ((!unfinishedSnapshot || unfinishedSnapshot.empty) && lastDoc) {
						lastUnfinishedDocByWindow.delete(cursorKey);
						let restartQuery = firestore
							.collection(DAILY_COLLECTION_NAME)
							.where('evaluationWindow', '==', targetWin);
						if (bucket && bucket !== 'all') {
							restartQuery = restartQuery.where('bucket', '==', String(bucket).trim().toLowerCase());
						}
						query = restartQuery.where('finalized', '==', false).limit(10);
						unfinishedSnapshot = await query.get();
					}

					if (unfinishedSnapshot && !unfinishedSnapshot.empty) {
						const docs = unfinishedSnapshot.docs;
						if (docs && docs.length > 0) {
							lastUnfinishedDocByWindow.set(cursorKey, docs[docs.length - 1]);
							for (const unfinishedDoc of docs) {
								const unfinishedData = typeof unfinishedDoc.data === 'function' ? unfinishedDoc.data() : unfinishedDoc;
								const unfinishedDate = unfinishedData?.date;
								if (unfinishedDate && !candidateDates.includes(unfinishedDate)) {
									candidateDates.push(unfinishedDate);
								}
							}
						}
					}
				} catch (queryErr) {
					// fail-open: do not fail sweep if historical unfinished query fails
				}
			}

			for (const targetDate of candidateDates) {
				scannedCohorts++;

				const mature = isCohortMature(targetDate, targetWin, nowMs);
				if (!mature && !force) {
					skippedCohorts++;
					continue;
				}

				const parts = String(targetDate).split('-');
				if (parts.length !== 3) {
					skippedCohorts++;
					continue;
				}
				const year = parseInt(parts[0], 10);
				const month = parseInt(parts[1], 10) - 1;
				const day = parseInt(parts[2], 10);
				if (isNaN(year) || isNaN(month) || isNaN(day)) {
					skippedCohorts++;
					continue;
				}
				const dayStart = new Date(Date.UTC(year, month, day, 0, 0, 0));
				const dayEnd = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
				if (isNaN(dayStart.getTime()) || isNaN(dayEnd.getTime())) {
					skippedCohorts++;
					continue;
				}

				const snapshot = await firestore
					.collection(SOURCE_COLLECTION_NAME)
					.where('receivedAt', '>=', admin.firestore.Timestamp.fromDate(dayStart))
					.where('receivedAt', '<=', admin.firestore.Timestamp.fromDate(dayEnd))
					.get();

				const docs = snapshot && !snapshot.empty ? snapshot.docs : [];

				let bucketsToRollup;
				if (Array.isArray(buckets) && buckets.length > 0) {
					bucketsToRollup = new Set(buckets.map((b) => String(b).trim().toLowerCase()));
				} else if (bucket && bucket !== 'all') {
					bucketsToRollup = new Set([String(bucket).trim().toLowerCase()]);
				} else {
					bucketsToRollup = new Set(['all']);
					for (const doc of docs) {
						const data = typeof doc.data === 'function' ? doc.data() : doc;
						if (data.assetClass) bucketsToRollup.add(String(data.assetClass).trim().toLowerCase());
						if (data.setupType) bucketsToRollup.add(String(data.setupType).trim().toLowerCase());
						if (data.side) bucketsToRollup.add(String(data.side).trim().toLowerCase());
					}
				}

				let cohortSkipped = true;
				for (const currentBucket of bucketsToRollup) {
					const docId = buildDailyDocId(targetDate, currentBucket, targetWin);
					const docRef = firestore.collection(DAILY_COLLECTION_NAME).doc(docId);

					let existing = null;
					if (!force) {
						existing = await docRef.get();
						if (existing && existing.exists && existing.data() && existing.data().finalized === true) {
							results.push({ docId, status: 'already_finalized' });
							continue;
						}
					}

					const metrics = computeDailyMetrics(docs, targetWin, currentBucket);

					if (metrics.signals === 0 && currentBucket !== 'all' && (!existing || !existing.exists)) {
						continue;
					}

					cohortSkipped = false;
					const isFinalized = (mature || force) && metrics.pending === 0;

					const dailyDoc = {
						date: targetDate,
						bucket: currentBucket,
						evaluationWindow: targetWin,
						signals: metrics.signals,
						sampleSize: metrics.sampleSize,
						wins: metrics.wins,
						losses: metrics.losses,
						invalidated: metrics.invalidated,
						pending: metrics.pending,
						hitRatePercent: metrics.hitRatePercent,
						avgMfe: metrics.avgMfe,
						avgMae: metrics.avgMae,
						avgReturnPercent: metrics.avgReturnPercent,
						finalized: isFinalized,
						updatedAt: new Date(nowMs).toISOString(),
						expiresAt,
					};

					if (batch) {
						batch.set(docRef, dailyDoc, { merge: true });
					} else {
						await docRef.set(dailyDoc, { merge: true });
					}

					if (isFinalized) finalizedSnapshots++;
					results.push({ docId, status: 'upserted', finalized: isFinalized });
				}

				if (cohortSkipped) {
					skippedCohorts++;
				}
			}
		}

		if (batch) {
			await batch.commit();
		}

		return {
			success: true,
			scannedCohorts,
			finalizedSnapshots,
			skippedCohorts,
			results,
		};
	} catch (error) {
		console.warn('[SignalOutcomeDailyRollupService] rollupOutcomesDaily failed:', error.message);
		sentryService.captureRuntimeError({
			feature: 'outcome-rollup',
			error,
		});
		return { success: false, error: error.message };
	}
}

async function getOutcomesTrend({ firestore, window = '1D', from, to, bucket = 'all' } = {}) {
	if (!firestore) {
		const category = FIRESTORE_ERROR_CATEGORIES?.UNINITIALIZED || 'uninitialized';
		firestoreWriteMetricsService.recordReadFailure('signalOutcomes', category);
		const error = new Error('Signal outcome tracking is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
		error.code = 'STORAGE_UNAVAILABLE';
		error.category = category;
		throw error;
	}

	const normalizedWindow = VALID_TREND_WINDOWS.includes(window) ? window : null;
	if (!normalizedWindow) {
		const error = new Error('Invalid window. Use 1h, 4h, 1D, or 1W.');
		error.code = 'INVALID_REQUEST';
		throw error;
	}

	const now = new Date();
	const todayUtc = now.toISOString().split('T')[0];

	let toDateStr = todayUtc;
	if (to) {
		const parsedTo = new Date(to);
		if (isNaN(parsedTo.getTime())) {
			const error = new Error('Invalid to date. Use an ISO-8601 string or YYYY-MM-DD date.');
			error.code = 'INVALID_REQUEST';
			throw error;
		}
		toDateStr = typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to)
			? to
			: parsedTo.toISOString().split('T')[0];
	}

	let fromDateStr;
	if (from) {
		const parsedFrom = new Date(from);
		if (isNaN(parsedFrom.getTime())) {
			const error = new Error('Invalid from date. Use an ISO-8601 string or YYYY-MM-DD date.');
			error.code = 'INVALID_REQUEST';
			throw error;
		}
		fromDateStr = typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from)
			? from
			: parsedFrom.toISOString().split('T')[0];
	} else {
		const defaultFromDate = new Date(new Date(toDateStr).getTime() - DEFAULT_TREND_DAYS * 24 * 60 * 60 * 1000);
		fromDateStr = defaultFromDate.toISOString().split('T')[0];
	}

	if (fromDateStr > toDateStr) {
		const error = new Error('Invalid time window. from must be before or equal to to.');
		error.code = 'INVALID_REQUEST';
		throw error;
	}

	const msDiff = new Date(toDateStr).getTime() - new Date(fromDateStr).getTime();
	const daysDiff = msDiff / (24 * 60 * 60 * 1000);
	if (daysDiff > MAX_TREND_DAYS) {
		const error = new Error(`Date range must not exceed ${MAX_TREND_DAYS} days.`);
		error.code = 'INVALID_REQUEST';
		throw error;
	}

	const normalizedBucket = String(bucket || 'all').trim().toLowerCase();

	let snapshot;
	try {
		snapshot = await firestore
			.collection(DAILY_COLLECTION_NAME)
			.where('evaluationWindow', '==', normalizedWindow)
			.where('bucket', '==', normalizedBucket)
			.where('date', '>=', fromDateStr)
			.where('date', '<=', toDateStr)
			.get();
		firestoreWriteMetricsService.recordReadSuccess('signalOutcomes');
	} catch (err) {
		const category = typeof classifyFirestoreError === 'function' ? classifyFirestoreError(err) : 'unknown';
		firestoreWriteMetricsService.recordReadFailure('signalOutcomes', category);
		const error = new Error('Signal outcome tracking is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
		error.code = 'STORAGE_UNAVAILABLE';
		error.category = category;
		throw error;
	}

	const points = [];
	if (snapshot && !snapshot.empty) {
		for (const doc of snapshot.docs) {
			const data = doc.data() || {};
			points.push({
				date: data.date,
				bucket: data.bucket,
				evaluationWindow: data.evaluationWindow,
				window: data.evaluationWindow,
				signals: data.signals ?? 0,
				sampleSize: data.sampleSize ?? data.signals ?? 0,
				wins: data.wins ?? 0,
				losses: data.losses ?? 0,
				invalidated: data.invalidated ?? 0,
				pending: data.pending ?? 0,
				hitRatePercent: data.hitRatePercent ?? null,
				avgMfe: data.avgMfe ?? null,
				avgMae: data.avgMae ?? null,
				avgReturnPercent: data.avgReturnPercent ?? null,
				finalized: Boolean(data.finalized),
				updatedAt: data.updatedAt || null,
			});
		}
	}

	points.sort((a, b) => a.date.localeCompare(b.date));

	return {
		success: true,
		window: normalizedWindow,
		bucket: normalizedBucket,
		from: fromDateStr,
		to: toDateStr,
		points,
		totalPoints: points.length,
		trend: points,
		totalDays: points.length,
	};
}

function _resetForTesting() {
	lastUnfinishedDocByWindow.clear();
}

module.exports = {
	DAILY_COLLECTION_NAME,
	SOURCE_COLLECTION_NAME,
	DEFAULT_ROLLUP_TTL_DAYS,
	MIN_ROLLUP_TTL_DAYS,
	MAX_ROLLUP_TTL_DAYS,
	MAX_TREND_DAYS,
	DEFAULT_TREND_DAYS,
	VALID_TREND_WINDOWS,
	WINDOW_MATURITY_MS,
	isOutcomeRollupEnabled,
	getRollupTtlDays,
	buildDailyDocId,
	formatDocId: buildDailyDocId,
	isCohortMature,
	matchesBucket,
	computeDailyMetrics,
	getMaturityDaysOffsets,
	rollupOutcomesDaily,
	getOutcomesTrend,
	_resetForTesting,
};
