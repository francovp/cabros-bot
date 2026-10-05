'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('./firestoreConfig');
const { initializeFirebaseAdminApp } = require('./firebaseAdminCredentials');
const { classifyFirestoreError, describeFirestoreErrorCategory } = require('./firestoreErrorCategories');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const COLLECTION_NAME = 'symbolAnalyses';

/**
 * Closed enum for `lastErrorReason`. Every Firestore failure in this service is
 * swallowed into a `null` return so a symbol analysis never fails, which means an
 * operator has no other way to learn that persistence silently stopped working. The
 * reason is constrained to this enum so a Firestore error message — which embeds the
 * fully-qualified project/database path — can never leak into a status response.
 */
const REASONS = Object.freeze({
	NOT_INITIALIZED: 'firestore_not_initialized',
	UNAVAILABLE: 'firestore_unavailable',
});

const KNOWN_REASONS = new Set(Object.values(REASONS));

/**
 * `unverified` is deliberately distinct from `ready` (and from `degraded`): before
 * the first observed write there is no evidence that analyses are actually stored,
 * and reporting that as "ready" is what makes the production enablement
 * unverifiable.
 */
const READINESS = Object.freeze({
	UNVERIFIED: 'unverified',
	VERIFIED: 'verified',
	DEGRADED: 'degraded',
});

// Which counter family a shared Firestore handle was requested for. Only the
// initialization-rejection path needs it; a successful operation is attributed by
// its own recorder.
const READ_INTENT = 'read';

let db = null;

/**
 * Process-local window of observed Firestore outcomes. Readiness is derived from
 * real work rather than credential shape, so a deployment whose credentials look
 * valid but cannot reach Firestore reports `degraded` instead of `ready`. Writes and
 * reads are counted separately: persistence is the feature, so only a successful
 * write proves the enablement took effect — a successful read proves reachability.
 * Counters reset on restart and every recorder is fail-open.
 */
const durability = {
	writesAttempted: 0,
	writesSucceeded: 0,
	writesFailed: 0,
	readsAttempted: 0,
	readsSucceeded: 0,
	readsFailed: 0,
	consecutiveFailures: 0,
	lastWriteAt: null,
	lastFailureAt: null,
	lastErrorReason: null,
};

// Asking for durable storage and not getting it is exactly the event an operator
// needs to see, so an attempt is counted even when initialization is rejected and
// `writesFailed` therefore never exceeds `writesAttempted`.
function _recordWriteAttempt() {
	durability.writesAttempted += 1;
}

function _recordWriteSuccess() {
	durability.writesSucceeded += 1;
	durability.consecutiveFailures = 0;
	durability.lastWriteAt = new Date().toISOString();
	durability.lastErrorReason = null;
}

function _recordWriteFailure(reason) {
	durability.writesFailed += 1;
	durability.consecutiveFailures += 1;
	durability.lastFailureAt = new Date().toISOString();
	durability.lastErrorReason = KNOWN_REASONS.has(reason) ? reason : REASONS.UNAVAILABLE;
}

// A rejected initialization is both the attempt and the failure for whichever
// operation triggered it, because no work ever reached Firestore. `getFirestore()`
// is shared by the write path and both read paths, so the intent is carried in:
// attributing every rejection to a write would report "writes attempted" for an
// operator who only ever browsed the collection, which points triage at
// persistence when the failure was in the read path.
function _recordInitializationFailure(reason, intent) {
	if (intent === READ_INTENT) {
		durability.readsAttempted += 1;
		_recordReadFailure(reason);
		return;
	}
	durability.writesAttempted += 1;
	_recordWriteFailure(reason);
}

function _recordReadAttempt() {
	durability.readsAttempted += 1;
}

// A read failure means Firestore is unreachable, which degrades the whole
// dependency even though the write path is a separate operation, so it shares the
// consecutive-failure counter that clears on the next successful Firestore operation.
function _recordReadSuccess() {
	durability.readsSucceeded += 1;
	durability.consecutiveFailures = 0;
	durability.lastErrorReason = null;
}

function _recordReadFailure(reason) {
	durability.readsFailed += 1;
	durability.consecutiveFailures += 1;
	durability.lastFailureAt = new Date().toISOString();
	durability.lastErrorReason = KNOWN_REASONS.has(reason) ? reason : REASONS.UNAVAILABLE;
}

function _resolveReadiness() {
	if (durability.consecutiveFailures > 0) {
		return READINESS.DEGRADED;
	}
	if (durability.writesSucceeded > 0) {
		return READINESS.VERIFIED;
	}
	return READINESS.UNVERIFIED;
}

// Telemetry must never be able to fail a symbol analysis: every readiness mutation
// runs through this guard so a counter error cannot reject the caller.
function recordDurabilitySafely(record) {
	try {
		record();
	} catch (error) {
		console.warn('[SymbolAnalysisStorageService] readiness recording failed:', error && error.message);
	}
}

const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';

/**
 * Translate a rejected Firestore read into the storage error the HTTP layer maps
 * to 503.
 *
 * A gRPC failure carries a numeric `code` at best, so rethrowing it left the
 * controller with no code to match and it answered 500 INTERNAL_ERROR for an
 * operator-actionable storage fault. The replacement message is built from the
 * closed category enum rather than from `cause.message`, because Firestore embeds
 * the fully-qualified project/database path there and the 503 body returns
 * `error.message` verbatim. A provider error already classified with a string
 * code is passed through so a genuine `INVALID_REQUEST` is not relabelled.
 */
function _createReadUnavailableError(cause) {
	if (typeof cause?.code === 'string' && cause.code) {
		return cause;
	}
	const category = classifyFirestoreError(cause);
	const error = new Error(
		`Symbol analysis storage is enabled but Firestore is unavailable. ${describeFirestoreErrorCategory(category)}`,
	);
	error.code = STORAGE_UNAVAILABLE_CODE;
	error.category = category;
	if (cause) {
		error.cause = cause;
	}
	console.warn(
		`[SymbolAnalysisStorageService] Firestore read failed (${category}):`,
		cause?.message ? cause.message : String(cause),
	);
	return error;
}

// Both settings are deployment-controlled, matching
// `AlertStorageService.canInitializeFirestore()`, which reads the same gate from
// `process.env`. They are deliberately absent from `RemoteConfigService`
// PARAMETER_SCHEMA: a published server template outranks `render.yaml`, so an
// allow-listed gate here would let a stale template silently keep the enablement
// off while `/api/capabilities` reported the blueprint's value (issue #1179).
function isEnabled() {
	return process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE === 'true';
}

function getRetentionDays() {
	const parsed = Number.parseInt(process.env.SYMBOL_ANALYSIS_RETENTION_DAYS, 10);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : DEFAULT_RETENTION_DAYS;
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
	if (!value) {
		return null;
	}
	if (typeof value.toMillis === 'function') {
		return value.toMillis();
	}
	if (typeof value.toDate === 'function') {
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
	if (value._type === 'serverTimestamp' || value.constructor?.name === 'FieldValue') {
		return Date.now();
	}
	return null;
}

function getDocTimestamp(value) {
	const millis = getTimestampMillis(value);
	return millis !== null ? new Date(millis).toISOString() : null;
}

function numberOrNull(value) {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

/**
 * Initialize Firebase Admin (idempotent) and return the Firestore client, or null
 * when the feature is off or the configured credentials are invalid.
 *
 * A rejected initialization is recorded as a failure for the operation that
 * triggered it, so status reports `degraded` rather than an unproven `ready`, and it
 * never falls through to `admin.initializeApp({})`: issue #1128 established that
 * entering the SDK default-auth path here authenticates with a *different* credential
 * than the operator configured and pays for discovery on the first read or write.
 *
 * `intent` is `READ_INTENT` on the read paths so a rejection is charged to the read
 * counters rather than to a write that was never attempted.
 */
function getFirestore(intent) {
	if (!isEnabled()) {
		return null;
	}

	if (db) {
		return db;
	}

	try {
		const initialization = initializeFirebaseAdminApp({ admin });
		if (!initialization.ok) {
			console.warn(
				`[SymbolAnalysisStorageService] Firebase credentials are configured but invalid (${initialization.error.code}); skipping Firestore and dropping the record.`,
			);
			db = null;
			recordDurabilitySafely(() => _recordInitializationFailure(REASONS.NOT_INITIALIZED, intent));
			return null;
		}

		db = admin.firestore();
		console.debug('[SymbolAnalysisStorageService] Firestore client initialized');
	} catch (error) {
		console.warn('[SymbolAnalysisStorageService] Failed to initialize Firestore client:', error.message);
		db = null;
		recordDurabilitySafely(() => _recordInitializationFailure(REASONS.NOT_INITIALIZED, intent));
	}

	return db;
}

function formatSymbolAnalysisDoc(doc) {
	const data = typeof doc.data === 'function' ? doc.data() : (doc || {});
	const id = doc.id || data.id || data.requestId;
	const createdAt = getDocTimestamp(data.createdAt);
	const receivedAt = getDocTimestamp(data.receivedAt) || createdAt;
	const action = data.action || data.decision?.action || 'NO_TRADE';

	return {
		id,
		requestId: data.requestId || id,
		symbol: data.symbol || '',
		asset: data.asset || '',
		exchange: data.exchange || '',
		timeframe: data.timeframe || '',
		action,
		analysisMode: data.analysisMode || 'standard',
		decision: {
			action,
			confidence: numberOrNull(data.decision?.confidence),
			dataSufficient: Boolean(data.decision?.dataSufficient),
		},
		price: numberOrNull(data.price),
		rsi: numberOrNull(data.rsi),
		indicators: data.indicators || {},
		risk: data.risk || {},
		multiTimeframe: Boolean(data.multiTimeframe),
		analysisStatus: data.analysisStatus || 'complete',
		processingTimeMs: numberOrNull(data.processingTimeMs),
		analysis: data.analysis || '',
		alertText: data.alertText || '',
		recordedAt: createdAt,
		receivedAt,
		createdAt,
		expiresAt: getDocTimestamp(data.expiresAt),
	};
}

/**
 * Persist a single symbol analysis record to Firestore.
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
	recordDurabilitySafely(_recordWriteAttempt);

	try {
		const requestId = (record.requestId && String(record.requestId).trim()) || crypto.randomUUID();
		const id = requestId;
		const symbol = String(record.symbol || '').trim().toUpperCase();
		const asset = String(record.asset || symbol.split(':')[1] || symbol).trim().toUpperCase();
		const exchange = String(record.exchange || symbol.split(':')[0] || '').trim().toUpperCase();
		const timeframe = String(record.timeframe || '').trim();
		const analysisMode = String(record.analysisMode || 'standard').trim();

		const rawDecision = record.decision || {};
		const decisionAction = ['BUY', 'SELL', 'NO_TRADE'].includes(String(rawDecision.action).toUpperCase())
			? String(rawDecision.action).toUpperCase()
			: 'NO_TRADE';
		const decisionConfidence = rawDecision.confidence !== undefined ? numberOrNull(rawDecision.confidence) : undefined;
		const dataSufficient = Boolean(rawDecision.dataSufficient);

		const price = record.price !== undefined ? numberOrNull(record.price) : undefined;
		const rsi = record.rsi !== undefined ? numberOrNull(record.rsi) : undefined;

		const rawIndicators = record.indicators || {};
		const indicators = stripUndefinedFieldsDeep({
			bbUpper: rawIndicators.bbUpper !== undefined ? numberOrNull(rawIndicators.bbUpper) : undefined,
			bbLower: rawIndicators.bbLower !== undefined ? numberOrNull(rawIndicators.bbLower) : undefined,
			sma20: rawIndicators.sma20 !== undefined ? numberOrNull(rawIndicators.sma20) : undefined,
			macd: rawIndicators.macd !== undefined ? numberOrNull(rawIndicators.macd) : undefined,
			macdSignal: rawIndicators.macdSignal !== undefined ? numberOrNull(rawIndicators.macdSignal) : undefined,
			atr: rawIndicators.atr !== undefined ? numberOrNull(rawIndicators.atr) : undefined,
			adx: rawIndicators.adx !== undefined ? numberOrNull(rawIndicators.adx) : undefined,
			volumeRatio: rawIndicators.volumeRatio !== undefined ? numberOrNull(rawIndicators.volumeRatio) : undefined,
		});

		const rawRisk = record.risk || {};
		const risk = stripUndefinedFieldsDeep({
			riskRewardRatio: rawRisk.riskRewardRatio !== undefined ? numberOrNull(rawRisk.riskRewardRatio) : undefined,
			invalidationLevel: rawRisk.invalidationLevel !== undefined ? numberOrNull(rawRisk.invalidationLevel) : undefined,
			targetLevel: rawRisk.targetLevel !== undefined ? numberOrNull(rawRisk.targetLevel) : undefined,
			valid: rawRisk.valid !== undefined ? Boolean(rawRisk.valid) : undefined,
		});

		const multiTimeframe = Boolean(record.multiTimeframe);
		const analysisStatus = String(record.analysisStatus || 'complete').trim();
		const processingTimeMs = record.processingTimeMs !== undefined ? numberOrNull(record.processingTimeMs) : undefined;

		const dataToSave = stripUndefinedFieldsDeep({
			id,
			requestId,
			symbol,
			asset,
			exchange,
			timeframe,
			action: decisionAction,
			analysisMode,
			decision: {
				action: decisionAction,
				confidence: decisionConfidence,
				dataSufficient,
			},
			price,
			rsi,
			indicators,
			risk,
			multiTimeframe,
			analysisStatus,
			processingTimeMs,
			analysis: record.analysis || '',
			alertText: record.alertText || '',
			receivedAt: admin.firestore.FieldValue.serverTimestamp(),
			createdAt: admin.firestore.FieldValue.serverTimestamp(),
			expiresAt: buildRetentionExpiryTimestamp(),
		});

		await firestore.collection(COLLECTION_NAME).doc(id).set(dataToSave);
		recordDurabilitySafely(_recordWriteSuccess);
		return id;
	} catch (error) {
		console.warn('[SymbolAnalysisStorageService] Failed to record symbol analysis:', error.message);
		recordDurabilitySafely(() => _recordWriteFailure(REASONS.UNAVAILABLE));
		return null;
	}
}

/**
 * Summarize symbol analyses in a time window.
 */
async function summarizeAnalyses({ from, to, limit = 500, symbol, exchange, timeframe } = {}) {
	if (!isEnabled()) {
		const error = new Error('Symbol analysis storage feature is disabled. Set ENABLE_SYMBOL_ANALYSIS_STORAGE=true to enable.');
		error.code = 'FEATURE_DISABLED';
		throw error;
	}

	const firestore = getFirestore(READ_INTENT);
	if (!firestore) {
		const error = new Error('Symbol analysis storage is enabled but Firestore is unavailable.');
		error.code = 'STORAGE_UNAVAILABLE';
		throw error;
	}

	let query = firestore.collection(COLLECTION_NAME);
	if (symbol) {
		query = query.where('symbol', '==', String(symbol).trim().toUpperCase());
	}
	if (exchange) {
		query = query.where('exchange', '==', String(exchange).trim().toUpperCase());
	}
	if (timeframe) {
		query = query.where('timeframe', '==', String(timeframe).trim());
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

	recordDurabilitySafely(_recordReadAttempt);
	let snapshot;
	try {
		snapshot = await query.get();
	} catch (error) {
		recordDurabilitySafely(() => _recordReadFailure(REASONS.UNAVAILABLE));
		throw _createReadUnavailableError(error);
	}
	recordDurabilitySafely(_recordReadSuccess);
	const rawDocs = snapshot && snapshot.docs ? snapshot.docs : [];
	const items = rawDocs.map(formatSymbolAnalysisDoc);

	const totalAnalyses = items.length;
	const byAction = { BUY: 0, SELL: 0, NO_TRADE: 0 };
	const bySymbol = {};
	const byTimeframe = {};
	const byExchange = {};

	for (const item of items) {
		const action = item.decision?.action || 'NO_TRADE';
		if (byAction[action] !== undefined) {
			byAction[action] += 1;
		} else {
			byAction[action] = 1;
		}

		// By symbol
		const sym = item.symbol || 'UNKNOWN';
		if (!bySymbol[sym]) {
			bySymbol[sym] = {
				count: 0,
				actions: { BUY: 0, SELL: 0, NO_TRADE: 0 },
				confidenceSum: 0,
				confidenceCount: 0,
				priceSum: 0,
				priceCount: 0,
			};
		}
		bySymbol[sym].count += 1;
		if (bySymbol[sym].actions[action] !== undefined) {
			bySymbol[sym].actions[action] += 1;
		}
		if (item.decision?.confidence !== null && item.decision?.confidence !== undefined) {
			bySymbol[sym].confidenceSum += item.decision.confidence;
			bySymbol[sym].confidenceCount += 1;
		}
		if (item.price !== null && item.price !== undefined) {
			bySymbol[sym].priceSum += item.price;
			bySymbol[sym].priceCount += 1;
		}

		// By timeframe
		const tf = item.timeframe || 'unknown';
		if (!byTimeframe[tf]) {
			byTimeframe[tf] = {
				count: 0,
				actions: { BUY: 0, SELL: 0, NO_TRADE: 0 },
			};
		}
		byTimeframe[tf].count += 1;
		if (byTimeframe[tf].actions[action] !== undefined) {
			byTimeframe[tf].actions[action] += 1;
		}

		// By exchange
		const ex = item.exchange || 'unknown';
		if (!byExchange[ex]) {
			byExchange[ex] = {
				count: 0,
				actions: { BUY: 0, SELL: 0, NO_TRADE: 0 },
			};
		}
		byExchange[ex].count += 1;
		if (byExchange[ex].actions[action] !== undefined) {
			byExchange[ex].actions[action] += 1;
		}
	}

	const formattedBySymbol = {};
	for (const [sym, s] of Object.entries(bySymbol)) {
		formattedBySymbol[sym] = {
			count: s.count,
			actions: s.actions,
			avgConfidence: s.confidenceCount > 0 ? Math.round((s.confidenceSum / s.confidenceCount) * 100) / 100 : null,
			avgPrice: s.priceCount > 0 ? Math.round((s.priceSum / s.priceCount) * 100) / 100 : null,
		};
	}

	const formattedByTimeframe = {};
	for (const [tf, t] of Object.entries(byTimeframe)) {
		formattedByTimeframe[tf] = {
			count: t.count,
			actions: t.actions,
		};
	}

	const formattedByExchange = {};
	for (const [ex, e] of Object.entries(byExchange)) {
		formattedByExchange[ex] = {
			count: e.count,
			actions: e.actions,
		};
	}

	return {
		success: true,
		totalAnalyses,
		byAction,
		bySymbol: formattedBySymbol,
		byTimeframe: formattedByTimeframe,
		byExchange: formattedByExchange,
		window: {
			from: fromDate ? fromDate.toISOString() : (items.length > 0 ? items[items.length - 1].createdAt : null),
			to: toDate ? toDate.toISOString() : (items.length > 0 ? items[0].createdAt : null),
			limit: boundedLimit,
			symbol: symbol || null,
			exchange: exchange || null,
			timeframe: timeframe || null,
		},
	};
}

/**
 * List paginated symbol analyses.
 */
async function listAnalyses({ from, to, limit = 50, symbol, exchange, timeframe, action, before, beforeCursor = before } = {}) {
	if (!isEnabled()) {
		const error = new Error('Symbol analysis storage feature is disabled. Set ENABLE_SYMBOL_ANALYSIS_STORAGE=true to enable.');
		error.code = 'FEATURE_DISABLED';
		throw error;
	}

	const firestore = getFirestore(READ_INTENT);
	if (!firestore) {
		const error = new Error('Symbol analysis storage is enabled but Firestore is unavailable.');
		error.code = 'STORAGE_UNAVAILABLE';
		throw error;
	}

	let query = firestore.collection(COLLECTION_NAME);
	if (symbol) {
		query = query.where('symbol', '==', String(symbol).trim().toUpperCase());
	}
	if (exchange) {
		query = query.where('exchange', '==', String(exchange).trim().toUpperCase());
	}
	if (timeframe) {
		query = query.where('timeframe', '==', String(timeframe).trim());
	}
	if (action) {
		query = query.where('decision.action', '==', String(action).trim().toUpperCase());
	}
	if (from) {
		query = query.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(from)));
	}
	if (to) {
		query = query.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(new Date(to)));
	}

	const boundedLimit = Math.min(Math.max(1, limit || 50), 100);
	query = query.orderBy('createdAt', 'desc');

	const effectiveCursor = beforeCursor || before;
	if (effectiveCursor && typeof effectiveCursor === 'string' && !effectiveCursor.includes('/')) {
		try {
			const cursorDoc = await firestore.collection(COLLECTION_NAME).doc(effectiveCursor).get();
			if (cursorDoc && cursorDoc.exists) {
				query = query.startAfter(cursorDoc);
			}
		} catch {
			// fail-open on invalid cursor
		}
	}

	query = query.limit(boundedLimit);
	recordDurabilitySafely(_recordReadAttempt);
	let snapshot;
	try {
		snapshot = await query.get();
	} catch (error) {
		recordDurabilitySafely(() => _recordReadFailure(REASONS.UNAVAILABLE));
		throw _createReadUnavailableError(error);
	}
	recordDurabilitySafely(_recordReadSuccess);
	const docs = snapshot && snapshot.docs ? snapshot.docs : [];

	const analyses = docs.map(formatSymbolAnalysisDoc);
	const nextCursor = docs.length === boundedLimit ? docs[docs.length - 1].id : null;

	return {
		success: true,
		analyses,
		count: analyses.length,
		limit: boundedLimit,
		nextCursor,
	};
}

/**
 * Reported storage state for `/api/status` and `/api/capabilities`.
 *
 * `enabled`/`configured` stay intent- and shape-derived so an operator can still see
 * what the deployment was asked to do. `ready` is the proof question: true only after
 * an observed successful write, and cleared by the first failure until the next
 * success — so it never latches degraded and needs no restart to recover.
 *
 * This must never call `getFirestore()`: a status poll is not evidence of Firestore
 * health, and recording one would let an operator manufacture `ready` by watching
 * `/api/status` instead of sending an analysis.
 *
 * `failOpen` is always `true` and is stated rather than implied: every Firestore
 * error is swallowed, so a `degraded` verdict still answers symbol analysis — it just
 * silently stops building decision history.
 */
function getStatus() {
	const enabled = isEnabled();
	const configured = isFirestoreConfigured();
	const readiness = _resolveReadiness();

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
		readiness,
		failOpen: true,
		collection: COLLECTION_NAME,
		retentionDays: getRetentionDays(),
		writesAttempted: durability.writesAttempted,
		writesSucceeded: durability.writesSucceeded,
		writesFailed: durability.writesFailed,
		readsAttempted: durability.readsAttempted,
		readsSucceeded: durability.readsSucceeded,
		readsFailed: durability.readsFailed,
		consecutiveFailures: durability.consecutiveFailures,
		lastWriteAt: durability.lastWriteAt,
		lastFailureAt: durability.lastFailureAt,
		lastErrorReason: durability.lastErrorReason,
	};
}

function __resetReadinessForTesting() {
	durability.writesAttempted = 0;
	durability.writesSucceeded = 0;
	durability.writesFailed = 0;
	durability.readsAttempted = 0;
	durability.readsSucceeded = 0;
	durability.readsFailed = 0;
	durability.consecutiveFailures = 0;
	durability.lastWriteAt = null;
	durability.lastFailureAt = null;
	durability.lastErrorReason = null;
}

function __resetForTesting() {
	db = null;
	__resetReadinessForTesting();
}

module.exports = {
	isEnabled,
	getRetentionDays,
	buildRetentionExpiryTimestamp,
	stripUndefinedFieldsDeep,
	recordAnalysis,
	summarizeAnalyses,
	listAnalyses,
	formatSymbolAnalysisDoc,
	getFirestore,
	getStatus,
	__resetReadinessForTesting,
	__resetForTesting,
	__resetFirestoreClient: __resetForTesting,
	COLLECTION_NAME,
	REASONS,
	READINESS,
};
