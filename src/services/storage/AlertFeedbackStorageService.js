'use strict';

/**
 * AlertFeedbackStorageService — persists trader alert feedback (👍 / 👎
 * verdicts) in Cloud Firestore.
 *
 * Mirrors the lazy singleton + fail-open pattern from AlertStorageService
 * so that a Firestore outage never blocks keyboard callbacks or summary
 * aggregation. Each (alertId, chatId) tuple maps to a single document that
 * is overwritten on every verdict (re-click updates, never appends), which
 * gives the storage layer bounded write amplification under Telegram's
 * 30 req/sec/chat rate-limit ceiling.
 *
 * Collection: alertFeedback
 * Document ID: `${alertId}__${hash(chatId).slice(0,16)}`
 *
 * Document schema:
 *   alertId    - string — the originating alert document id
 *   chatId     - string — raw chat id (kept server-side only; never returned)
 *   chatIdHash - string — SHA-256 hex of chatId for safe aggregation
 *   verdict    - "up" | "down"
 *   verdictAt  - Timestamp — serverTimestamp() at write time
 *   source     - string — "webhook-alert" | "expanded-analysis" | "scanner" | "news"
 *   symbol     - string | null — extracted symbol (uppercase, no exchange)
 *   exchange   - string | null — extracted exchange (uppercase) when known
 *   expiresAt  - Timestamp — verdictAt + ALERT_FEEDBACK_RETENTION_DAYS
 *
 * Privacy: `chatIdHash` is the only chat identifier surfaced through summary
 * endpoints. Raw chat ids stay on the document and are never returned via
 * /api/alerts/feedback/summary.
 *
 * Configuration:
 *   ENABLE_FIRESTORE_ALERT_FEEDBACK=true (defaults to false → in-memory fallback)
 *   ALERT_FEEDBACK_RETENTION_DAYS — bounded 1..3650, default 90 (matches alerts)
 */

const crypto = require('crypto');
const admin = require('firebase-admin');

const COLLECTION_NAME = 'alertFeedback';
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;
const MIN_RETENTION_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';
const VALID_VERDICTS = new Set(['up', 'down']);
const VALID_SOURCES = new Set([
	'webhook-alert',
	'expanded-analysis',
	'scanner',
	'news',
	'unknown',
]);

let db = null;
let lastRetentionWarning = null;

// In-memory fallback so disabled-Firestore callers still get a working
// summary surface (test mode + dev environments). Cleared on every
// successful persistence when Firestore is enabled.
const inMemoryEntries = new Map();

function isEnabled() {
	return process.env.ENABLE_FIRESTORE_ALERT_FEEDBACK === 'true';
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
	} catch (error) {
		console.warn('[AlertFeedbackStorageService] Failed to initialize Firestore client:', error.message);
		db = null;
	}

	return db;
}

function getRetentionDays() {
	const rawValue = process.env.ALERT_FEEDBACK_RETENTION_DAYS;
	if (rawValue === undefined) {
		return DEFAULT_RETENTION_DAYS;
	}
	const normalized = rawValue.trim();
	const parsed = Number(normalized);
	if (!/^\d+$/.test(normalized)
		|| !Number.isSafeInteger(parsed)
		|| parsed < MIN_RETENTION_DAYS
		|| parsed > MAX_RETENTION_DAYS) {
		if (lastRetentionWarning !== rawValue) {
			console.warn('[AlertFeedbackStorageService] Invalid ALERT_FEEDBACK_RETENTION_DAYS, using default');
			lastRetentionWarning = rawValue;
		}
		return DEFAULT_RETENTION_DAYS;
	}
	lastRetentionWarning = null;
	return parsed;
}

function buildRetentionExpiry() {
	return admin.firestore.Timestamp.fromDate(
		new Date(Date.now() + (getRetentionDays() * DAY_MS)),
	);
}

function hashChatId(chatId) {
	if (!chatId) {
		return null;
	}
	return crypto
		.createHash('sha256')
		.update(String(chatId).trim())
		.digest('hex');
}

function sanitizeDocIdSegment(value) {
	if (!value || typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed || /[/\\\s]/.test(trimmed)) {
		return null;
	}
	return trimmed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function buildDocumentId(alertId, chatId) {
	const safeAlertId = sanitizeDocIdSegment(alertId);
	const safeChatHash = hashChatId(chatId);
	if (!safeAlertId || !safeChatHash) {
		return null;
	}
	// 16-char prefix is more than enough to disambiguate chatIds within the
	// (alertId) keyspace while keeping the document id itself short.
	return `${safeAlertId}__${safeChatHash.slice(0, 16)}`;
}

function createStorageUnavailableError(cause) {
	const error = new Error('Alert feedback storage is unavailable');
	error.code = STORAGE_UNAVAILABLE_CODE;
	if (cause) {
		error.cause = cause;
	}
	return error;
}

function normalizeVerdict(verdict) {
	if (typeof verdict !== 'string') {
		return null;
	}
	const normalized = verdict.trim().toLowerCase();
	return VALID_VERDICTS.has(normalized) ? normalized : null;
}

function normalizeSource(source) {
	if (typeof source !== 'string') {
		return 'unknown';
	}
	const normalized = source.trim().toLowerCase();
	return VALID_SOURCES.has(normalized) ? normalized : 'unknown';
}

function buildFeedbackDocument(input) {
	return {
		alertId: input.alertId,
		chatId: input.chatId,
		chatIdHash: input.chatIdHash,
		verdict: input.verdict,
		verdictAt: input.verdictAt,
		source: input.source,
		symbol: input.symbol || null,
		exchange: input.exchange || null,
		expiresAt: input.expiresAt,
	};
}

function buildSummaryBucket() {
	return {
		total: 0,
		up: 0,
		down: 0,
		ratio: 0,
		bySource: {},
		bySymbol: {},
		byExchange: {},
	};
}

function incrementCount(bucket, key) {
	if (!key) {
		return;
	}
	bucket[key] = (bucket[key] || 0) + 1;
}

function ratioOf(up, down) {
	const total = up + down;
	if (total === 0) {
		return 0;
	}
	return Number((up / total).toFixed(4));
}

async function saveFeedback(params) {
	const alertId = params && typeof params.alertId === 'string' ? params.alertId.trim() : '';
	const chatId = params && typeof params.chatId === 'string' ? params.chatId.trim() : '';
	const verdict = normalizeVerdict(params && params.verdict);
	const source = normalizeSource(params && params.source);

	if (!alertId || !chatId || !verdict) {
		return { persisted: false, source: 'memory', reason: 'invalid_input' };
	}

	const chatIdHash = hashChatId(chatId);
	const documentId = buildDocumentId(alertId, chatId);
	if (!documentId) {
		return { persisted: false, source: 'memory', reason: 'invalid_input' };
	}

	const entry = {
		alertId,
		chatId,
		chatIdHash,
		verdict,
		verdictAt: new Date().toISOString(),
		source,
		symbol: typeof params.symbol === 'string' && params.symbol.trim()
			? params.symbol.trim().toUpperCase()
			: null,
		exchange: typeof params.exchange === 'string' && params.exchange.trim()
			? params.exchange.trim().toUpperCase()
			: null,
	};

	const firestore = getFirestore();
	if (firestore) {
		try {
			const document = buildFeedbackDocument({
				...entry,
				verdictAt: admin.firestore.FieldValue.serverTimestamp(),
				expiresAt: buildRetentionExpiry(),
			});
			await firestore.collection(COLLECTION_NAME).doc(documentId).set(document);
			return { persisted: true, source: 'firestore' };
		} catch (error) {
			console.warn('[AlertFeedbackStorageService] Failed to save feedback, falling back to memory:', error.message);
		}
	}

	// Fallback path — also used when Firestore is disabled. The TTL here is
	// bounded by process lifetime; callers treat this as a development signal.
	inMemoryEntries.set(documentId, {
		...entry,
		expiresAtMs: Date.now() + (getRetentionDays() * DAY_MS),
	});
	return { persisted: true, source: 'memory' };
}

async function listFeedbackEntries({ from, to, limit = 1000 } = {}) {
	const fromIso = from ? new Date(from).toISOString() : new Date(Date.now() - (7 * DAY_MS)).toISOString();
	const toIso = to ? new Date(to).toISOString() : new Date().toISOString();
	const window = {
		from: fromIso,
		to: toIso,
		limit: Math.max(1, Math.min(limit, 1000)),
	};
	const fromMs = Date.parse(fromIso);
	const toMs = Date.parse(toIso);
	const nowMs = Date.now();

	const aggregate = buildSummaryBucket();

	const firestore = getFirestore();
	if (firestore) {
		try {
			const snapshot = await firestore
				.collection(COLLECTION_NAME)
				.where('verdictAt', '>=', admin.firestore.Timestamp.fromDate(new Date(fromMs)))
				.where('verdictAt', '<=', admin.firestore.Timestamp.fromDate(new Date(toMs)))
				.limit(window.limit)
				.get();
			for (const doc of snapshot.docs) {
				const data = doc.data() || {};
				if (data.expiresAt && typeof data.expiresAt.toMillis === 'function' && data.expiresAt.toMillis() <= nowMs) {
					continue;
				}
				accumulate(aggregate, data);
			}
			finalize(aggregate);
			return { aggregate, window, source: 'firestore' };
		} catch (error) {
			console.warn('[AlertFeedbackStorageService] Failed to read feedback, falling back to memory:', error.message);
		}
	}

	for (const entry of inMemoryEntries.values()) {
		const ts = Date.parse(entry.verdictAt);
		if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) {
			continue;
		}
		if (entry.expiresAtMs && entry.expiresAtMs <= nowMs) {
			continue;
		}
		accumulate(aggregate, entry);
	}
	finalize(aggregate);
	return { aggregate, window, source: 'memory' };
}

function accumulate(bucket, data) {
	const verdict = normalizeVerdict(data.verdict);
	if (!verdict) {
		return;
	}
	bucket.total += 1;
	if (verdict === 'up') {
		bucket.up += 1;
	} else {
		bucket.down += 1;
	}
	bucket.ratio = ratioOf(bucket.up, bucket.down);
	incrementCount(bucket.bySource, data.source || 'unknown');
	incrementCount(bucket.bySymbol, typeof data.symbol === 'string' && data.symbol.trim()
		? data.symbol.trim().toUpperCase()
		: null);
	incrementCount(bucket.byExchange, typeof data.exchange === 'string' && data.exchange.trim()
		? data.exchange.trim().toUpperCase()
		: null);
}

function finalize(bucket) {
	bucket.ratio = ratioOf(bucket.up, bucket.down);
}

async function getSummaryBlock({ from, to } = {}) {
	const result = await listFeedbackEntries({ from, to, limit: 1000 });
	return {
		total: result.aggregate.total,
		up: result.aggregate.up,
		down: result.aggregate.down,
		ratio: result.aggregate.ratio,
		bySource: result.aggregate.bySource,
		bySymbol: result.aggregate.bySymbol,
		byExchange: result.aggregate.byExchange,
		source: result.source,
		window: result.window,
	};
}

function getStatus() {
	const firestoreEnabled = isEnabled();
	return {
		enabled: firestoreEnabled,
		configured: Boolean(getFirestore()),
		source: firestoreEnabled ? (db ? 'firestore' : 'memory') : 'memory',
		inMemoryEntryCount: inMemoryEntries.size,
	};
}

function _resetForTests() {
	inMemoryEntries.clear();
	db = null;
	lastRetentionWarning = null;
}

module.exports = {
	isEnabled,
	getStatus,
	saveFeedback,
	listFeedbackEntries,
	getSummaryBlock,
	hashChatId,
	buildDocumentId,
	STORAGE_UNAVAILABLE_CODE,
	VALID_VERDICTS,
	VALID_SOURCES,
	_resetForTests,
};
