'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { isFirestoreConfigured } = require('./firestoreConfig');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const COLLECTION_NAME = 'symbolAnalyses';

let db = null;

function isEnabled() {
	try {
		const runtime = getRuntimeConfig();
		if (runtime && runtime.ENABLE_SYMBOL_ANALYSIS_STORAGE !== undefined) {
			return runtime.ENABLE_SYMBOL_ANALYSIS_STORAGE === true;
		}
	} catch {}
	return process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE === 'true';
}

function getRetentionDays() {
	try {
		const runtime = getRuntimeConfig();
		const days = runtime?.SYMBOL_ANALYSIS_RETENTION_DAYS;
		if (Number.isInteger(days) && days >= 1 && days <= 365) {
			return days;
		}
	} catch {}
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
		console.debug('[SymbolAnalysisStorageService] Firestore client initialized');
	} catch (error) {
		console.warn('[SymbolAnalysisStorageService] Failed to initialize Firestore client:', error.message);
		db = null;
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
		return id;
	} catch (error) {
		console.warn('[SymbolAnalysisStorageService] Failed to record symbol analysis:', error.message);
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

	const firestore = getFirestore();
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

	const snapshot = await query.get();
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

	const firestore = getFirestore();
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
	const snapshot = await query.get();
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

function getStatus() {
	const enabled = isEnabled();
	const configured = isFirestoreConfigured();
	const ready = enabled && configured;
	return {
		enabled,
		configured,
		ready,
		status: ready ? 'ready' : (enabled ? 'misconfigured' : 'disabled'),
		collection: COLLECTION_NAME,
		retentionDays: getRetentionDays(),
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
	summarizeAnalyses,
	listAnalyses,
	formatSymbolAnalysisDoc,
	getFirestore,
	getStatus,
	__resetFirestoreClient,
	COLLECTION_NAME,
};
