'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { isFirestoreConfigured } = require('./firestoreConfig');
const { initializeFirebaseAdminApp } = require('./firebaseAdminCredentials');
const { firestoreWriteMetricsService } = require('./FirestoreWriteMetricsService');
const {
	FIRESTORE_ERROR_CATEGORIES,
	classifyFirestoreError,
	isMissingIndexError,
} = require('./firestoreErrorCategories');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const COLLECTION_NAME = 'news_analysis';
const WRITE_METRICS_DOMAIN = 'newsAnalysis';

/**
 * Environment-only, deliberately absent from the Remote Config allow-list exactly
 * like `ENABLE_FIRESTORE_ALERT_STORAGE` / `_JOB_STORAGE` / `_SCANNER_PRESETS` /
 * `_IDEMPOTENCY`: it decides where a collection lives, it is not a tuning knob.
 *
 * Issue #1180 is why this is load-bearing rather than stylistic. The key *was* in
 * the published server template as `"false"`, and a template parameter's
 * `defaultValue` is reported by the Admin SDK with source `remote`, so
 * `getRemoteValue()` accepts it as an override that beats `process.env` — enabling
 * the variable in `render.yaml` alone would have been silently reverted to `false`
 * the moment Remote Config loads recovered. `NEWS_ANALYSIS_RETENTION_DAYS` is the
 * genuine tuning knob and stays remote-config eligible.
 */
function isEnabled() {
	return process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS === 'true';
}

/**
 * `lastErrorReason` reuses the repository-wide closed Firestore error category
 * enum. Every Firestore failure in this service is swallowed, so this is the only
 * evidence an operator gets that persistence silently stopped working, and a raw
 * provider message must never reach a status payload: Firestore embeds the
 * fully-qualified project/database path and the missing index definition in it.
 * `missingIndex` is reported separately as a boolean for the same reason.
 */
const KNOWN_REASONS = new Set(Object.values(FIRESTORE_ERROR_CATEGORIES));

/**
 * `unverified` is deliberately distinct from `ready` (and from `degraded`):
 * before the first observed durable operation there is no evidence that analysis
 * records actually persist, and reporting that as `ready` is what would make the
 * production enablement unverifiable.
 */
const READINESS = Object.freeze({
	UNVERIFIED: 'unverified',
	VERIFIED: 'verified',
	DEGRADED: 'degraded',
});

let db = null;

/**
 * Process-local window of observed durable outcomes. Readiness is derived from
 * real Firestore work rather than credential shape, so a deployment whose
 * credentials look valid but cannot reach Firestore reports `degraded` instead of
 * `ready`. Counters reset on restart and every recorder is fail-open: telemetry
 * must never block alert delivery or reject an admin read.
 */
const durableReadiness = {
	operationsAttempted: 0,
	operationsSucceeded: 0,
	operationsFailed: 0,
	consecutiveFailures: 0,
	lastSuccessAt: null,
	lastFailureAt: null,
	lastErrorReason: null,
	lastMissingIndex: false,
};

function _resetReadinessForTesting() {
	durableReadiness.operationsAttempted = 0;
	durableReadiness.operationsSucceeded = 0;
	durableReadiness.operationsFailed = 0;
	durableReadiness.consecutiveFailures = 0;
	durableReadiness.lastSuccessAt = null;
	durableReadiness.lastFailureAt = null;
	durableReadiness.lastErrorReason = null;
	durableReadiness.lastMissingIndex = false;
}

// A durable use attempt is counted even when Firebase initialization fails, because
// asking for durable storage and not getting it is exactly the event an operator
// needs to see. `operationsFailed` therefore never exceeds `operationsAttempted`.
function _recordDurableAttempt() {
	durableReadiness.operationsAttempted += 1;
}

function _recordDurableSuccess() {
	durableReadiness.operationsSucceeded += 1;
	durableReadiness.consecutiveFailures = 0;
	durableReadiness.lastSuccessAt = new Date().toISOString();
}

function _recordDurableFailure(reason, missingIndex = false) {
	durableReadiness.operationsFailed += 1;
	durableReadiness.consecutiveFailures += 1;
	durableReadiness.lastFailureAt = new Date().toISOString();
	durableReadiness.lastErrorReason = typeof reason === 'string' && KNOWN_REASONS.has(reason)
		? reason
		: FIRESTORE_ERROR_CATEGORIES.UNAVAILABLE;
	durableReadiness.lastMissingIndex = missingIndex === true;
}

function _resolveDurableReadiness() {
	if (durableReadiness.consecutiveFailures > 0) {
		return READINESS.DEGRADED;
	}
	if (durableReadiness.operationsSucceeded > 0) {
		return READINESS.VERIFIED;
	}
	return READINESS.UNVERIFIED;
}

// Telemetry must never be able to reject a write or an admin read: every readiness
// mutation runs through this guard so a counter error cannot fail the caller.
function recordReadinessSafely(record) {
	try {
		record();
	} catch (error) {
		console.warn('[NewsAnalysisStorageService] readiness recording failed:', error && error.message);
	}
}

function _classifyAndRecordFailure(error) {
	recordReadinessSafely(() => {
		_recordDurableFailure(classifyFirestoreError(error), isMissingIndexError(error));
	});
}

/**
 * `mode` and `backend` report configured **intent** and must not flip to `memory`
 * while the gate is on, or an operator reading `memory` concludes the flag is off.
 * `ready` is the proof question: true only after an observed successful durable
 * operation, cleared by the first failure so a transient error self-heals without
 * a restart. This function performs no I/O, so a status read cannot register a
 * durable attempt. `failOpen` is always `true` and is stated rather than implied:
 * a `degraded` verdict still delivers news alerts, it just stops recording them.
 */
function getStorageStatus() {
	const enabled = isEnabled();
	const configured = isFirestoreConfigured();
	const durableIntent = enabled && configured;
	const readiness = _resolveDurableReadiness();

	let status;
	if (!enabled) {
		status = 'disabled';
	} else if (!configured) {
		status = 'misconfigured';
	} else if (readiness === READINESS.DEGRADED) {
		status = 'degraded';
	} else if (readiness === READINESS.VERIFIED) {
		status = 'ready';
	} else {
		status = READINESS.UNVERIFIED;
	}

	return {
		enabled,
		configured,
		ready: status === 'ready',
		status,
		mode: durableIntent ? 'durable' : 'ephemeral',
		backend: durableIntent ? 'firestore' : 'memory',
		failOpen: true,
		readiness,
		collection: COLLECTION_NAME,
		retentionDays: getRetentionDays(),
		operationsAttempted: durableReadiness.operationsAttempted,
		operationsSucceeded: durableReadiness.operationsSucceeded,
		operationsFailed: durableReadiness.operationsFailed,
		consecutiveFailures: durableReadiness.consecutiveFailures,
		lastSuccessAt: durableReadiness.lastSuccessAt,
		lastFailureAt: durableReadiness.lastFailureAt,
		lastErrorReason: durableReadiness.lastErrorReason,
		lastMissingIndex: durableReadiness.lastMissingIndex,
	};
}

function getRetentionDays() {
	try {
		const days = getRuntimeConfig().NEWS_ANALYSIS_RETENTION_DAYS;
		return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_RETENTION_DAYS;
	} catch {
		const parsed = Number.parseInt(process.env.NEWS_ANALYSIS_RETENTION_DAYS, 10);
		return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : DEFAULT_RETENTION_DAYS;
	}
}

function buildRetentionExpiryTimestamp(nowMs = Date.now()) {
	const retentionDays = getRetentionDays();
	return admin.firestore.Timestamp.fromDate(new Date(nowMs + (retentionDays * DAY_MS)));
}

function stripUndefinedFieldsDeep(value) {
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.filter((item) => item !== undefined)
			.map((item) => stripUndefinedFieldsDeep(item));
	}

	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		return value;
	}

	const result = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) {
			result[key] = stripUndefinedFieldsDeep(item);
		}
	}
	return result;
}

function getTimestampMillis(value) {
	if (value && typeof value.toMillis === 'function') {
		return value.toMillis();
	}
	if (value && typeof value.toDate === 'function') {
		return value.toDate().getTime();
	}
	if (value instanceof Date) {
		return value.getTime();
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return null;
}

function getDocTimestamp(value) {
	const millis = getTimestampMillis(value);
	return millis !== null ? new Date(millis).toISOString() : null;
}

function getFirestore() {
	if (!isEnabled()) {
		return null;
	}

	if (db) {
		return db;
	}

	try {
		// Issue #1128: never call `initializeApp({})` for credentials that are
		// configured but invalid. The shared bootstrap classifies the credential
		// document first, so an inline `authorized_user` / `external_account`
		// document is refused instead of authenticating with a *different*
		// credential than the operator configured, and an ADC-only deployment
		// (GOOGLE_APPLICATION_CREDENTIALS file or well-known gcloud path) works
		// instead of paying for default-auth discovery on the first read.
		const initialization = initializeFirebaseAdminApp({ admin });
		if (!initialization.ok) {
			console.warn(
				`[NewsAnalysisStorageService] Firebase credentials are configured but invalid (${initialization.error.code}); skipping Firestore and keeping analysis ephemeral.`,
			);
			db = null;
			recordReadinessSafely(() => {
				_recordDurableAttempt();
				_recordDurableFailure(FIRESTORE_ERROR_CATEGORIES.UNINITIALIZED);
			});
			return null;
		}

		db = admin.firestore();
		console.debug('[NewsAnalysisStorageService] Firestore client initialized');
	} catch (error) {
		console.warn('[NewsAnalysisStorageService] Failed to initialize Firestore client:', error.message);
		db = null;
		recordReadinessSafely(() => {
			_recordDurableAttempt();
			_recordDurableFailure(classifyFirestoreError(error));
		});
	}

	return db;
}

function formatAnalysisDoc(doc) {
	const data = typeof doc.data === 'function' ? doc.data() : (doc || {});
	const id = doc.id || data.id;
	return {
		id,
		createdAt: getDocTimestamp(data.createdAt),
		symbol: data.symbol || '',
		eventCategory: data.eventCategory || 'none',
		sentiment: typeof data.sentiment === 'number' ? data.sentiment : 0,
		confidence: typeof data.confidence === 'number' ? data.confidence : 0,
		headline: typeof data.headline === 'string' ? data.headline : '',
		alertSent: Boolean(data.alertSent),
		promptVersion: typeof data.promptVersion === 'string' ? data.promptVersion : null,
		tokens: typeof data.tokens === 'number' ? data.tokens : null,
		expiresAt: getDocTimestamp(data.expiresAt),
	};
}

/**
 * Persist a single news analysis record to Firestore.
 * Fails open (never throws, returns null on error).
 */
async function recordAnalysis(record = {}) {
	if (!isEnabled()) {
		return null;
	}

	const firestore = getFirestore();
	if (!firestore) {
		return null;
	}

	recordReadinessSafely(_recordDurableAttempt);

	try {
		const id = (record.id && String(record.id).trim()) || crypto.randomUUID();
		const symbol = String(record.symbol || '').trim().toUpperCase();
		const eventCategory = String(record.eventCategory || 'none').trim().toLowerCase();
		const sentiment = typeof record.sentiment === 'number' && Number.isFinite(record.sentiment)
			? record.sentiment
			: (Number.isFinite(Number(record.sentiment)) ? Number(record.sentiment) : 0);
		const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
			? record.confidence
			: (Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 0);
		const headline = typeof record.headline === 'string' ? record.headline.trim() : '';
		const alertSent = Boolean(record.alertSent);
		const promptVersion = typeof record.promptVersion === 'string' && record.promptVersion.trim().length > 0
			? record.promptVersion.trim()
			: (record.promptVersion != null && String(record.promptVersion).trim().length > 0 ? String(record.promptVersion).trim() : undefined);
		const tokens = typeof record.tokens === 'number' && Number.isFinite(record.tokens)
			? Math.round(record.tokens)
			: (Number.isFinite(Number(record.tokens)) ? Math.round(Number(record.tokens)) : null);

		const dataToSave = stripUndefinedFieldsDeep({
			id,
			symbol,
			eventCategory,
			sentiment,
			confidence,
			headline,
			alertSent,
			promptVersion,
			tokens,
			createdAt: admin.firestore.FieldValue.serverTimestamp(),
			expiresAt: buildRetentionExpiryTimestamp(),
		});

		await firestore.collection(COLLECTION_NAME).doc(id).set(dataToSave);
		firestoreWriteMetricsService.recordWriteSuccess(WRITE_METRICS_DOMAIN);
		recordReadinessSafely(_recordDurableSuccess);
		return id;
	} catch (error) {
		firestoreWriteMetricsService.recordWriteFailure(WRITE_METRICS_DOMAIN);
		_classifyAndRecordFailure(error);
		console.warn('[NewsAnalysisStorageService] Failed to record news analysis:', error.message);
		return null;
	}
}

/**
 * Persist multiple news analysis records to Firestore asynchronously.
 * Fails open (never throws).
 */
async function recordAnalyses(records = []) {
	if (!isEnabled() || !Array.isArray(records) || records.length === 0) {
		return [];
	}

	const results = await Promise.allSettled(records.map(record => recordAnalysis(record)));
	return results
		.filter(r => r.status === 'fulfilled' && r.value != null)
		.map(r => r.value);
}

/**
 * Summarize news analyses in a time window.
 */
async function summarizeAnalyses({ from, to, limit = 500, symbol, threshold = 0.7 } = {}) {
	if (!isEnabled()) {
		const error = new Error('News analysis storage feature is disabled. Set ENABLE_FIRESTORE_NEWS_ANALYSIS=true to enable.');
		error.code = 'FEATURE_DISABLED';
		throw error;
	}

	const firestore = getFirestore();
	if (!firestore) {
		const error = new Error('News analysis storage is enabled but Firestore is unavailable.');
		error.code = 'STORAGE_UNAVAILABLE';
		throw error;
	}

	let query = firestore.collection(COLLECTION_NAME);
	if (symbol) {
		query = query.where('symbol', '==', String(symbol).trim().toUpperCase());
	}

	let fromDate = null;
	let toDate = null;
	if (from) {
		fromDate = new Date(from);
		query = query.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(fromDate));
	}
	if (to) {
		toDate = new Date(to);
		query = query.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(toDate));
	}

	const boundedLimit = Math.min(Math.max(1, limit || 500), 1000);
	query = query.orderBy('createdAt', 'desc').limit(boundedLimit);

	recordReadinessSafely(_recordDurableAttempt);
	let snapshot;
	try {
		snapshot = await query.get();
	} catch (error) {
		// Issue #1285: a rejected *query* is a storage-availability failure, not an
		// internal bug. A missing composite index is the common cause here, because
		// Firestore does not merge single-field indexes for an equality filter plus a
		// sort on another field, and neither the unit double (orderBy is a no-op) nor
		// the emulator (which auto-creates indexes) can observe a missing declaration.
		firestoreWriteMetricsService.recordReadFailure(WRITE_METRICS_DOMAIN, classifyFirestoreError(error));
		_classifyAndRecordFailure(error);
		console.warn('[NewsAnalysisStorageService] Failed to read news analyses for summary:', error.message);
		const storageError = new Error('News analysis storage read failed. See dependencies.newsAnalysisStorage for the classified reason.');
		storageError.code = 'STORAGE_UNAVAILABLE';
		throw storageError;
	}
	firestoreWriteMetricsService.recordReadSuccess(WRITE_METRICS_DOMAIN);
	recordReadinessSafely(_recordDurableSuccess);

	const rawDocs = snapshot && snapshot.docs ? snapshot.docs : [];
	const items = rawDocs.map(formatAnalysisDoc);

	const totalAnalyses = items.length;
	let totalAlertsSent = 0;
	const bySymbol = {};
	const byEventCategory = {};

	for (const item of items) {
		const sym = item.symbol || 'UNKNOWN';
		if (!bySymbol[sym]) {
			bySymbol[sym] = {
				totalAnalyses: 0,
				alertsSent: 0,
				confidenceSum: 0,
			};
		}
		bySymbol[sym].totalAnalyses += 1;
		bySymbol[sym].confidenceSum += item.confidence;
		if (item.alertSent) {
			bySymbol[sym].alertsSent += 1;
			totalAlertsSent += 1;
		}

		const cat = item.eventCategory || 'none';
		if (!byEventCategory[cat]) {
			byEventCategory[cat] = {
				total: 0,
				alertsSent: 0,
				confidenceSum: 0,
			};
		}
		byEventCategory[cat].total += 1;
		byEventCategory[cat].confidenceSum += item.confidence;
		if (item.alertSent) {
			byEventCategory[cat].alertsSent += 1;
		}
	}

	for (const sym of Object.keys(bySymbol)) {
		const s = bySymbol[sym];
		s.averageConfidence = s.totalAnalyses > 0
			? Math.round((s.confidenceSum / s.totalAnalyses) * 100) / 100
			: 0;
		delete s.confidenceSum;
	}

	for (const cat of Object.keys(byEventCategory)) {
		const c = byEventCategory[cat];
		c.averageConfidence = c.total > 0
			? Math.round((c.confidenceSum / c.total) * 100) / 100
			: 0;
		delete c.confidenceSum;
	}

	// False-positive proxy:
	// Delivered alerts with confidence >= threshold that had NO subsequent delivered alert
	// for the same symbol within 24h. Records that never sent an alert are excluded: the
	// proxy measures delivered-alert outcomes, not raw analysis scores.
	const numericThreshold = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.7;
	const highConfidenceAlerts = items
		.filter(item => item.alertSent === true && item.confidence >= numericThreshold && item.eventCategory !== 'none')
		.map(item => ({
			...item,
			timestampMs: getTimestampMillis(item.createdAt) || 0,
		}))
		.sort((a, b) => a.timestampMs - b.timestampMs);

	let totalEvaluated = 0;
	let noFollowupCount = 0;

	for (let i = 0; i < highConfidenceAlerts.length; i += 1) {
		const current = highConfidenceAlerts[i];
		totalEvaluated += 1;

		let hasFollowup = false;
		for (let j = i + 1; j < highConfidenceAlerts.length; j += 1) {
			const candidate = highConfidenceAlerts[j];
			if (candidate.symbol === current.symbol) {
				const diff = candidate.timestampMs - current.timestampMs;
				if (diff > 0 && diff <= DAY_MS) {
					hasFollowup = true;
					break;
				}
				if (diff > DAY_MS) {
					break;
				}
			}
		}

		if (!hasFollowup) {
			noFollowupCount += 1;
		}
	}

	const ratePercent = totalEvaluated > 0
		? Math.round((noFollowupCount / totalEvaluated) * 10000) / 100
		: 0;

	return {
		window: {
			from: fromDate ? fromDate.toISOString() : (items.length > 0 ? items[items.length - 1].createdAt : null),
			to: toDate ? toDate.toISOString() : (items.length > 0 ? items[0].createdAt : null),
			limit: boundedLimit,
		},
		totalAnalyses,
		totalAlertsSent,
		bySymbol,
		byEventCategory,
		falsePositiveProxy: {
			threshold: numericThreshold,
			totalEvaluated,
			noFollowupCount,
			ratePercent,
		},
	};
}

/**
 * List paginated news analyses.
 */
async function listAnalyses({ from, to, limit = 50, symbol, eventCategory, beforeCursor } = {}) {
	if (!isEnabled()) {
		const error = new Error('News analysis storage feature is disabled. Set ENABLE_FIRESTORE_NEWS_ANALYSIS=true to enable.');
		error.code = 'FEATURE_DISABLED';
		throw error;
	}

	const firestore = getFirestore();
	if (!firestore) {
		const error = new Error('News analysis storage is enabled but Firestore is unavailable.');
		error.code = 'STORAGE_UNAVAILABLE';
		throw error;
	}

	let query = firestore.collection(COLLECTION_NAME);
	if (symbol) {
		query = query.where('symbol', '==', String(symbol).trim().toUpperCase());
	}
	if (eventCategory) {
		query = query.where('eventCategory', '==', String(eventCategory).trim().toLowerCase());
	}
	if (from) {
		query = query.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(from)));
	}
	if (to) {
		query = query.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(new Date(to)));
	}

	const boundedLimit = Math.min(Math.max(1, limit || 50), 100);
	query = query.orderBy('createdAt', 'desc');

	if (beforeCursor) {
		const cursorDoc = await firestore.collection(COLLECTION_NAME).doc(beforeCursor).get();
		if (cursorDoc && cursorDoc.exists) {
			query = query.startAfter(cursorDoc);
		}
	}

	query = query.limit(boundedLimit);
	recordReadinessSafely(_recordDurableAttempt);
	let snapshot;
	try {
		snapshot = await query.get();
	} catch (error) {
		firestoreWriteMetricsService.recordReadFailure(WRITE_METRICS_DOMAIN, classifyFirestoreError(error));
		_classifyAndRecordFailure(error);
		console.warn('[NewsAnalysisStorageService] Failed to list news analyses:', error.message);
		const storageError = new Error('News analysis storage read failed. See dependencies.newsAnalysisStorage for the classified reason.');
		storageError.code = 'STORAGE_UNAVAILABLE';
		throw storageError;
	}
	firestoreWriteMetricsService.recordReadSuccess(WRITE_METRICS_DOMAIN);
	recordReadinessSafely(_recordDurableSuccess);

	const docs = snapshot && snapshot.docs ? snapshot.docs : [];

	const analyses = docs.map(formatAnalysisDoc);
	const nextCursor = docs.length === boundedLimit ? docs[docs.length - 1].id : null;

	return {
		analyses,
		nextCursor,
	};
}

function __resetFirestoreClient() {
	db = null;
}

module.exports = {
	isEnabled,
	getRetentionDays,
	buildRetentionExpiryTimestamp,
	stripUndefinedFieldsDeep,
	recordAnalysis,
	recordAnalyses,
	summarizeAnalyses,
	listAnalyses,
	formatAnalysisDoc,
	getFirestore,
	getStorageStatus,
	COLLECTION_NAME,
	READINESS,
	__resetFirestoreClient,
	__resetReadinessForTesting: _resetReadinessForTesting,
};
