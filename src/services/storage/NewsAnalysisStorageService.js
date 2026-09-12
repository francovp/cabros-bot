'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const COLLECTION_NAME = 'news_analysis';

let db = null;

function isEnabled() {
	try {
		return getRuntimeConfig().ENABLE_FIRESTORE_NEWS_ANALYSIS === true;
	} catch {
		return process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS === 'true';
	}
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
		console.debug('[NewsAnalysisStorageService] Firestore client initialized');
	} catch (error) {
		console.warn('[NewsAnalysisStorageService] Failed to initialize Firestore client:', error.message);
		db = null;
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
		return id;
	} catch (error) {
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

	const snapshot = await query.get();
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
	// Alerts with confidence >= threshold that had NO subsequent alert for the same symbol within 24h
	const numericThreshold = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.7;
	const highConfidenceAlerts = items
		.filter(item => (item.alertSent || item.confidence >= numericThreshold) && item.confidence >= numericThreshold && item.eventCategory !== 'none')
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
	const snapshot = await query.get();
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
	__resetFirestoreClient,
};
