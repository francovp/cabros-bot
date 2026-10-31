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
const { initializeFirebaseAdminApp } = require('../storage/firebaseAdminCredentials');

const COLLECTION_NAME = 'chatEnrollments';
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_LANGUAGES = new Set(['es', 'en']);
const MAX_WATCHLIST_LENGTH = 50;
const MAX_MEMORY_ENROLLMENTS = 1000;
const MAX_REF_SOURCE_LENGTH = 64;
const MAX_CHAT_ID = Number.MAX_SAFE_INTEGER;
const MIN_CHAT_ID = -Number.MAX_SAFE_INTEGER;
const SUPPORTED_CHAT_TYPES = new Set(['private', 'group', 'supergroup', 'channel']);

let firestore = null;
let firestoreAttempted = false;
let memoryStore = new Map();
let unpersistedChatIds = new Set();
let firestoreHealth = 'unverified';
const READ_TIMEOUT_MS = 500;
const WRITE_TIMEOUT_MS = 1000;

function withTimeout(work, timeoutMs) {
	let timer;
	return Promise.race([work, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error('Firestore deadline exceeded')), timeoutMs);
		timer.unref?.();
	})]).finally(() => clearTimeout(timer));
}

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

function getFirestore() {
	if (firestore) return firestore;
	if (!isEnabled()) return null;
	if (!isFirestoreConfigured()) return null;
	if (firestoreAttempted) return null;

	firestoreAttempted = true;
	try {
		const initialization = initializeFirebaseAdminApp({ admin });
		if (!initialization.ok) return null;
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
	const record = memoryStore.get(chatId) || null;
	if (record && Number.isFinite(record.expiresAt) && record.expiresAt <= Date.now()) {
		memoryStore.delete(chatId);
		unpersistedChatIds.delete(chatId);
		return null;
	}
	return record;
}

function writeMemory(chatId, record) {
	const cached = { ...record };
	memoryStore.delete(chatId);
	memoryStore.set(chatId, cached);
	while (memoryStore.size > MAX_MEMORY_ENROLLMENTS) {
		const oldestChatId = memoryStore.keys().next().value;
		memoryStore.delete(oldestChatId);
		unpersistedChatIds.delete(oldestChatId);
	}
	return cached;
}

async function readFirestore(chatId) {
	const db = getFirestore();
	if (!db) return null;
	try {
		const docRef = db.collection(COLLECTION_NAME).doc(chatId);
		const snapshot = await withTimeout(docRef.get(), READ_TIMEOUT_MS);
		firestoreHealth = 'ready';
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
			expiresAt: expiresAtMs,
			enrolledAt: data.enrolledAt && typeof data.enrolledAt.toMillis === 'function'
				? data.enrolledAt.toMillis()
				: null,
		};
	} catch (error) {
		firestoreHealth = 'degraded';
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
		const payload = {
			chatId,
			chatType: record.chatType || null,
			language: record.language || null,
			watchlist: Array.isArray(record.watchlist) ? record.watchlist : [],
			refSource: record.refSource || null,
			enrolledAt: admin.firestore.Timestamp.fromMillis(record.enrolledAt || Date.now()),
			expiresAt,
		};
		await withTimeout(db.runTransaction(async (transaction) => {
			const snapshot = await transaction.get(docRef);
			const prior = snapshot.exists && snapshot.data();
			const priorTime = prior?.enrolledAt?.toMillis?.();
			if (Number.isFinite(priorTime) && priorTime > record.enrolledAt) return;
			transaction.set(docRef, payload);
		}), WRITE_TIMEOUT_MS);
		firestoreHealth = 'ready';
		return true;
	} catch (error) {
		firestoreHealth = 'degraded';
		console.warn('[ChatEnrollmentsService] writeFirestore error (fail-open):', error.message);
		return false;
	}
}

async function listFirestore(limit) {
	const db = getFirestore();
	if (!db) return null;
	try {
		const snapshot = await withTimeout(db.collection(COLLECTION_NAME).limit(limit).get(), READ_TIMEOUT_MS);
		const records = [];
		snapshot.forEach((doc) => {
			const data = doc.data();
			const expiresAt = data.expiresAt && typeof data.expiresAt.toMillis === 'function'
				? data.expiresAt.toMillis() : null;
			if (expiresAt !== null && expiresAt <= Date.now()) return;
			records.push({
				chatId: doc.id,
				chatType: data.chatType || null,
				language: data.language || null,
				watchlist: Array.isArray(data.watchlist) ? data.watchlist : [],
				refSource: data.refSource || null,
				enrolledAt: data.enrolledAt && typeof data.enrolledAt.toMillis === 'function'
					? data.enrolledAt.toMillis()
					: null,
				expiresAt,
			});
		});
		firestoreHealth = 'ready';
		return { records, partial: snapshot.size >= limit };
	} catch (error) {
		firestoreHealth = 'degraded';
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
	const prior = readMemory(chatId);
	const record = {
		chatId,
		chatType: normalizeChatType(input && input.chatType) || 'private',
		language: normalizeLanguage(input && input.language),
		watchlist: normalizeWatchlist(input && input.watchlist) || [],
		refSource: normalizeRefSource(input && input.refSource),
		enrolledAt: Math.max(Date.now(), (prior?.enrolledAt || 0) + 1),
		expiresAt: computeExpiresAtMillis(),
	};

	const cached = writeMemory(chatId, record);
	const written = await writeFirestore(chatId, record);
	if (memoryStore.get(chatId) === cached) {
		if (written) unpersistedChatIds.delete(chatId);
		else unpersistedChatIds.add(chatId);
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
			partial: false,
			languages: [],
			watchlist: [],
			...(includeChatIds ? { records: [] } : {}),
		};
	}

	const cached = Array.from(memoryStore.keys()).map(readMemory).filter(Boolean);
	let records = cached.slice(0, boundedLimit);
	let partial = cached.length > boundedLimit;
	let backend = 'memory';
	let mode = 'ephemeral';

	const persisted = await listFirestore(boundedLimit);
	if (persisted) {
		backend = 'firestore';
		mode = 'durable';
		const byChatId = new Map();
		for (const chatId of unpersistedChatIds) {
			const pending = readMemory(chatId);
			if (pending) byChatId.set(chatId, pending);
		}
		for (const record of persisted.records) {
			if (!byChatId.has(record.chatId)) byChatId.set(record.chatId, record);
		}
		if (unpersistedChatIds.size > 0) {
			backend = 'memory';
			mode = 'ephemeral';
		}
		records = Array.from(byChatId.values()).slice(0, boundedLimit);
		partial = persisted.partial || byChatId.size > boundedLimit;
	}

	const summary = buildSummary(records);
	const out = {
		mode,
		backend,
		count: summary.count,
		partial,
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
	unpersistedChatIds = new Set();
	firestoreHealth = 'unverified';
	firestore = null;
	firestoreAttempted = false;
}

function _setFirestoreForTesting(db) {
	firestore = db;
	firestoreAttempted = true;
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
		ready: configured && firestoreHealth === 'ready' && unpersistedChatIds.size === 0,
		status: enabled ? (configured ? (unpersistedChatIds.size > 0 ? 'degraded' : firestoreHealth) : 'misconfigured') : 'disabled',
		mode: configured && firestoreHealth === 'ready' && unpersistedChatIds.size === 0 ? 'durable' : 'ephemeral',
		backend: configured && firestoreHealth === 'ready' && unpersistedChatIds.size === 0 ? 'firestore' : 'memory',
		count: Array.from(memoryStore.keys()).map(readMemory).filter(Boolean).length,
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
	_setFirestoreForTesting,
};
