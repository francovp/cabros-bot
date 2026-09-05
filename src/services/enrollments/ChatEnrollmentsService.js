'use strict';

/**
 * ChatEnrollmentsService — stores Telegram chat enrollment records.
 *
 * Opt-in via ENABLE_CHAT_ENROLLMENTS=true. When the flag is unset the service
 * is disabled; enrollment persistence and the admin endpoints stay inert so
 * Telegram operators do not need to manage Firestore to ship the bot.
 *
 * Storage backend:
 *   - In-memory Map (default when ENABLE_CHAT_ENROLLMENTS=false, or when
 *     Firestore is enabled but unavailable).
 *   - Firestore collection `chatEnrollments` when ENABLE_CHAT_ENROLLMENTS=true
 *     and Firestore is initialized through the existing firebase-admin
 *     singleton. Document ID is the chatId.
 *
 * Fail-open semantics: every Firestore interaction is wrapped in try/catch
 * with console.warn. Errors are swallowed; the in-memory cache remains the
 * authoritative read fallback so a flaky Firestore never blocks
 * /start onboarding or causes the admin endpoint to 500.
 */

const admin = require('firebase-admin');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');

const COLLECTION_NAME = 'chatEnrollments';
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_LANGUAGES = new Set(['es', 'en']);
const MAX_WATCHLIST_LENGTH = 20;
const MAX_REF_SOURCE_LENGTH = 64;
const MAX_CHAT_ID = Number.MAX_SAFE_INTEGER;
const MIN_CHAT_ID = -Number.MAX_SAFE_INTEGER;
const SUPPORTED_CHAT_TYPES = new Set(['private', 'group', 'supergroup', 'channel']);

let firestore = null;
let firestoreAttempted = false;
let memoryStore = new Map();

function isEnabled() {
	return process.env.ENABLE_CHAT_ENROLLMENTS === 'true';
}

function getRetentionDays() {
	const raw = process.env.CHAT_ENROLLMENT_RETENTION_DAYS;
	if (raw === undefined || raw === null || raw === '') {
		return DEFAULT_RETENTION_DAYS;
	}
	const parsed = Number(String(raw).trim());
	if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)
		|| parsed < MIN_RETENTION_DAYS || parsed > MAX_RETENTION_DAYS) {
		return DEFAULT_RETENTION_DAYS;
	}
	return parsed;
}

function canInitializeFirestore() {
	return isEnabled()
		|| process.env.ENABLE_FIRESTORE_ALERT_STORAGE === 'true'
		|| process.env.ENABLE_FIRESTORE_SCANNER_PRESETS === 'true'
		|| process.env.ENABLE_FIRESTORE_JOB_STORAGE === 'true'
		|| process.env.ENABLE_SIGNAL_OUTCOME_TRACKING === 'true'
		|| process.env.ENABLE_FIREBASE_REMOTE_CONFIG === 'true'
		|| process.env.ENABLE_NOTIFICATION_REDRIVE === 'true'
		|| process.env.ENABLE_NEWS_MONITOR_SCHEDULER === 'true';
}

function getFirestore() {
	if (firestore) return firestore;
	if (!isEnabled() || !canInitializeFirestore()) return null;
	if (!isFirestoreConfigured()) return null;
	if (firestoreAttempted) return null;

	firestoreAttempted = true;
	try {
		let credential;
		if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
			const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
			credential = admin.credential.cert(serviceAccount);
		}
		const appOptions = {};
		if (credential) appOptions.credential = credential;
		if (process.env.FIREBASE_PROJECT_ID) appOptions.projectId = process.env.FIREBASE_PROJECT_ID;
		if (!admin.apps.length) admin.initializeApp(appOptions);
		firestore = admin.firestore();
		console.debug('[ChatEnrollmentsService] Firestore client initialized');
	} catch (error) {
		console.warn('[ChatEnrollmentsService] Failed to initialize Firestore client:', error.message);
		firestore = null;
	}
	return firestore;
}

function normalizeChatId(chatId) {
	if (chatId === undefined || chatId === null || chatId === '') return null;
	const value = typeof chatId === 'number' ? chatId : Number(String(chatId).trim());
	if (!Number.isFinite(value) || !Number.isSafeInteger(value)
		|| value < MIN_CHAT_ID || value > MAX_CHAT_ID) {
		return null;
	}
	return String(value);
}

function normalizeChatType(chatType) {
	if (typeof chatType !== 'string') return null;
	const value = chatType.trim().toLowerCase();
	return SUPPORTED_CHAT_TYPES.has(value) ? value : null;
}

function normalizeLanguage(language) {
	if (typeof language !== 'string') return null;
	const value = language.trim().toLowerCase();
	return SUPPORTED_LANGUAGES.has(value) ? value : null;
}

function normalizeWatchlist(watchlist) {
	if (!Array.isArray(watchlist)) return null;
	const cleaned = [];
	const seen = new Set();
	for (const raw of watchlist) {
		if (typeof raw !== 'string') continue;
		const symbol = raw.trim().toUpperCase();
		if (!symbol) continue;
		if (symbol.length > 30) continue;
		if (!/^[A-Z0-9._-]+$/.test(symbol)) continue;
		if (seen.has(symbol)) continue;
		seen.add(symbol);
		cleaned.push(symbol);
		if (cleaned.length >= MAX_WATCHLIST_LENGTH) break;
	}
	return cleaned;
}

function normalizeRefSource(refSource) {
	if (typeof refSource !== 'string') return null;
	const value = refSource.trim();
	if (!value || value.length > MAX_REF_SOURCE_LENGTH) return null;
	return value;
}

function sanitizeRecord(record, { includeChatId = false } = {}) {
	if (!record || typeof record !== 'object') return null;
	const out = {};
	if (includeChatId && record.chatId !== undefined) out.chatId = record.chatId;
	if (record.chatType !== undefined) out.chatType = record.chatType;
	if (record.language !== undefined) out.language = record.language;
	if (Array.isArray(record.watchlist)) out.watchlist = record.watchlist;
	if (record.refSource !== undefined) out.refSource = record.refSource;
	if (record.enrolledAt !== undefined) out.enrolledAt = record.enrolledAt;
	return out;
}

function buildSummary(records) {
	const list = Array.isArray(records) ? records : [];
	const languages = {};
	const watchlist = {};
	let count = 0;
	for (const record of list) {
		if (!record || typeof record !== 'object') continue;
		count += 1;
		const lang = typeof record.language === 'string' && record.language ? record.language : 'unknown';
		languages[lang] = (languages[lang] || 0) + 1;
		if (Array.isArray(record.watchlist)) {
			for (const symbol of record.watchlist) {
				watchlist[symbol] = (watchlist[symbol] || 0) + 1;
			}
		}
	}
	const languageDistribution = Object.entries(languages)
		.map(([value, total]) => ({ value, total }))
		.sort((a, b) => (b.total - a.total) || a.value.localeCompare(b.value));
	const watchlistDistribution = Object.entries(watchlist)
		.map(([value, total]) => ({ value, total }))
		.sort((a, b) => (b.total - a.total) || a.value.localeCompare(b.value));
	return {
		count,
		languages: languageDistribution,
		watchlist: watchlistDistribution,
	};
}

function computeExpiresAtMillis() {
	const retentionDays = getRetentionDays();
	return Date.now() + retentionDays * DAY_MS;
}

function readMemory(chatId) {
	return memoryStore.get(chatId) || null;
}

function writeMemory(chatId, record) {
	memoryStore.set(chatId, { ...record });
}

function deleteMemory(chatId) {
	memoryStore.delete(chatId);
}

async function readFirestore(chatId) {
	const db = getFirestore();
	if (!db) return null;
	try {
		const docRef = db.collection(COLLECTION_NAME).doc(chatId);
		const snapshot = await docRef.get();
		if (!snapshot.exists) return null;
		const data = snapshot.data();
		if (!data || !data.enrolledAt) return null;
		const expiresAtMs = data.expiresAt && typeof data.expiresAt.toMillis === 'function'
			? data.expiresAt.toMillis()
			: null;
		if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
			trackBackgroundTask(docRef.delete().catch(() => {}));
			return null;
		}
		return {
			chatId,
			chatType: data.chatType || null,
			language: data.language || null,
			watchlist: Array.isArray(data.watchlist) ? data.watchlist : [],
			refSource: data.refSource || null,
			enrolledAt: data.enrolledAt && typeof data.enrolledAt.toMillis === 'function'
				? data.enrolledAt.toMillis()
				: null,
		};
	} catch (error) {
		console.warn('[ChatEnrollmentsService] readFirestore error (fail-open):', error.message);
		return null;
	}
}

async function writeFirestore(chatId, record) {
	const db = getFirestore();
	if (!db) return false;
	try {
		const expiresAtMillis = computeExpiresAtMillis();
		const expiresAt = admin.firestore.Timestamp.fromMillis(expiresAtMillis);
		const docRef = db.collection(COLLECTION_NAME).doc(chatId);
		await docRef.set({
			chatId,
			chatType: record.chatType || null,
			language: record.language || null,
			watchlist: Array.isArray(record.watchlist) ? record.watchlist : [],
			refSource: record.refSource || null,
			enrolledAt: admin.firestore.Timestamp.fromMillis(record.enrolledAt || Date.now()),
			expiresAt,
		});
		return true;
	} catch (error) {
		console.warn('[ChatEnrollmentsService] writeFirestore error (fail-open):', error.message);
		return false;
	}
}

async function listFirestore(limit) {
	const db = getFirestore();
	if (!db) return null;
	try {
		const snapshot = await db.collection(COLLECTION_NAME).limit(limit).get();
		const records = [];
		snapshot.forEach((doc) => {
			const data = doc.data();
			records.push({
				chatId: doc.id,
				chatType: data.chatType || null,
				language: data.language || null,
				watchlist: Array.isArray(data.watchlist) ? data.watchlist : [],
				refSource: data.refSource || null,
				enrolledAt: data.enrolledAt && typeof data.enrolledAt.toMillis === 'function'
					? data.enrolledAt.toMillis()
					: null,
			});
		});
		return records;
	} catch (error) {
		console.warn('[ChatEnrollmentsService] listFirestore error (fail-open):', error.message);
		return null;
	}
}

/**
 * Upsert enrollment for a chat. Returns the sanitized representation.
 *
 * @param {object} input
 * @param {string|number} input.chatId
 * @param {string} [input.chatType]
 * @param {string} [input.language]
 * @param {string[]} [input.watchlist]
 * @param {string} [input.refSource]
 * @returns {Promise<object|null>}
 */
async function enroll(input) {
	if (!isEnabled()) return null;
	const chatId = normalizeChatId(input && input.chatId);
	if (!chatId) return null;
	const record = {
		chatId,
		chatType: normalizeChatType(input && input.chatType) || 'private',
		language: normalizeLanguage(input && input.language),
		watchlist: normalizeWatchlist(input && input.watchlist) || [],
		refSource: normalizeRefSource(input && input.refSource),
		enrolledAt: Date.now(),
	};

	writeMemory(chatId, record);
	const written = await writeFirestore(chatId, record);
	if (!written && getFirestore()) {
		// Firestore write failed but the in-memory cache remains authoritative.
	}
	return sanitizeRecord(record, { includeChatId: true });
}

/**
 * Retrieve an enrollment. Returns sanitized record (chatId included only when
 * `includeChatId: true`). Returns null when no record exists.
 *
 * @param {string|number} chatId
 * @param {object} [options]
 * @param {boolean} [options.includeChatId]
 * @returns {Promise<object|null>}
 */
async function getByChatId(chatId, options = {}) {
	if (!isEnabled()) return null;
	const normalized = normalizeChatId(chatId);
	if (!normalized) return null;

	const memoryRecord = readMemory(normalized);
	if (memoryRecord) {
		return sanitizeRecord(memoryRecord, options);
	}

	const persisted = await readFirestore(normalized);
	if (persisted) {
		writeMemory(normalized, persisted);
		return sanitizeRecord(persisted, options);
	}
	return null;
}

/**
 * Aggregate enrollment statistics. Returns sanitized summary suitable for
 * the admin endpoint.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeChatIds=false]
 * @param {number} [options.limit=1000]
 * @returns {Promise<object>}
 */
async function getSummary({ includeChatIds = false, limit = 1000 } = {}) {
	const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 1000, 1000));

	if (!isEnabled()) {
		return {
			mode: 'ephemeral',
			backend: 'memory',
			count: 0,
			languages: [],
			watchlist: [],
			...(includeChatIds ? { records: [] } : {}),
		};
	}

	let records = Array.from(memoryStore.values());
	let backend = 'memory';
	let mode = 'ephemeral';

	const persisted = await listFirestore(boundedLimit);
	if (persisted) {
		backend = 'firestore';
		mode = 'durable';
		const memoryIds = new Set(memoryStore.keys());
		for (const persistedRecord of persisted) {
			if (!memoryIds.has(persistedRecord.chatId)) {
				writeMemory(persistedRecord.chatId, persistedRecord);
			}
		}
		records = Array.from(memoryStore.values());
	}

	const summary = buildSummary(records);
	const out = {
		mode,
		backend,
		count: summary.count,
		languages: summary.languages,
		watchlist: summary.watchlist,
	};
	if (includeChatIds) {
		out.records = records
			.map((record) => sanitizeRecord(record, { includeChatId: true }))
			.filter(Boolean);
	}
	return out;
}

function _resetForTesting() {
	memoryStore = new Map();
	firestore = null;
	firestoreAttempted = false;
}

/**
 * Storage status snapshot for /api/status.
 *
 * @returns {{enabled: boolean, configured: boolean, ready: boolean, status: string, mode: string, backend: string, count: number}}
 */
function getStorageStatus() {
	const enabled = isEnabled();
	const db = getFirestore();
	const configured = enabled && Boolean(db);
	return {
		enabled,
		configured,
		ready: configured,
		status: enabled ? (configured ? 'ready' : 'misconfigured') : 'disabled',
		mode: configured ? 'durable' : 'ephemeral',
		backend: configured ? 'firestore' : 'memory',
		count: memoryStore.size,
	};
}

module.exports = {
	COLLECTION_NAME,
	DEFAULT_RETENTION_DAYS,
	MAX_RETENTION_DAYS,
	MAX_WATCHLIST_LENGTH,
	SUPPORTED_LANGUAGES,
	SUPPORTED_CHAT_TYPES,
	isEnabled,
	getRetentionDays,
	normalizeChatId,
	normalizeChatType,
	normalizeLanguage,
	normalizeWatchlist,
	normalizeRefSource,
	sanitizeRecord,
	buildSummary,
	enroll,
	getByChatId,
	getSummary,
	getStorageStatus,
	_resetForTesting,
};
