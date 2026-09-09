'use strict';
/**
 * AlertAcknowledgementService — records and reads trader acknowledgements
 * for stored webhook alerts, joining the trader-action signal to outcome
 * attribution that the signal-outcome tracker evaluates at +1h/4h/1D/1W.
 *
 * The collection lives in Cloud Firestore when ENABLE_FIRESTORE_ALERT_STORAGE
 * is enabled, and falls back to a process-local in-memory store when Firestore
 * is unavailable. The in-memory fallback preserves acknowledgement behavior
 * during local development and during transient Firestore outages but is
 * scoped to the current process; horizontal replicas cannot share it.
 *
 * Collection: alertAcknowledgements
 * Document ID: <alertId>__<chatId> so the same (alert, chat) pair maps to
 *   a single, idempotent acknowledgement record. A second call with the
 *   same (alert, chat) updates the action/notes/acknowledgedAt instead of
 *   creating a duplicate document.
 *
 * Document schema:
 *   alertId         - string  - alerts/<id>
 *   chatId          - string  - Telegram chat id; never returned in any response
 *   action          - string  - took_trade | skipped | no_trade_no_signal | snoozed
 *   notes           - string  - optional, capped 280 chars
 *   acknowledgedAt  - server timestamp on first write
 *   updatedAt       - server timestamp on every write
 *   expiresAt       - timestamp - acknowledgedAt + ALERT_STORAGE_RETENTION_DAYS
 */
const admin = require('firebase-admin');
const alertStorageService = require('./AlertStorageService');

const COLLECTION_NAME = 'alertAcknowledgements';
const DEFAULT_NOTES_MAX_LENGTH = 280;
const VALID_ACTIONS = new Set(['took_trade', 'skipped', 'no_trade_no_signal', 'snoozed']);
const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';
const INVALID_REQUEST_CODE = 'INVALID_REQUEST';

let memoryStore = new Map();

function isEnabled() {
	return process.env.ENABLE_FIRESTORE_ALERT_STORAGE === 'true';
}

function getFirestore() {
	return alertStorageService.getFirestore
		? alertStorageService.getFirestore()
		: null;
}

function createInvalidRequestError(message) {
	const error = new Error(message);
	error.code = INVALID_REQUEST_CODE;
	return error;
}

function getAlertStorageRetentionDays() {
	return alertStorageService.getAlertStorageRetentionDays
		? alertStorageService.getAlertStorageRetentionDays()
		: 90;
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
		return value.getTime();
	}
	return null;
}

function buildRetentionExpiryTimestamp(baseMillis) {
	const days = getAlertStorageRetentionDays();
	const start = Number.isFinite(baseMillis) ? baseMillis : Date.now();
	return admin.firestore.Timestamp.fromDate(new Date(start + (days * DAY_MS)));
}

function normalizeNotes(rawNotes) {
	if (rawNotes === undefined || rawNotes === null) {
		return null;
	}
	if (typeof rawNotes !== 'string') {
		return null;
	}
	const trimmed = rawNotes.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.length > DEFAULT_NOTES_MAX_LENGTH ? trimmed.slice(0, DEFAULT_NOTES_MAX_LENGTH) : trimmed;
}

function validateAction(rawAction) {
	if (typeof rawAction !== 'string' || !rawAction.trim()) {
		return null;
	}
	const normalized = rawAction.trim().toLowerCase();
	return VALID_ACTIONS.has(normalized) ? normalized : null;
}

function toAcknowledgementDocumentId(alertId, chatId) {
	if (typeof alertId !== 'string' || !alertId.trim()) {
		throw createInvalidRequestError('alertId is required.');
	}
	if (typeof chatId !== 'string' || !chatId.trim()) {
		throw createInvalidRequestError('chatId is required.');
	}
	const safeChat = chatId.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
	return `${alertId.trim()}__${safeChat}`;
}

function safeIsoTimestamp(value) {
	if (value && typeof value.toDate === 'function') {
		return value.toDate().toISOString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === 'string' && value && !Number.isNaN(Date.parse(value))) {
		return new Date(value).toISOString();
	}
	return null;
}

function buildSafeRecord(stored) {
	if (!stored) {
		return null;
	}
	return {
		ackId: stored.id,
		alertId: typeof stored.alertId === 'string' ? stored.alertId : null,
		action: typeof stored.action === 'string' ? stored.action : null,
		notes: typeof stored.notes === 'string' ? stored.notes : null,
		acknowledgedAt: safeIsoTimestamp(stored.acknowledgedAt) || safeIsoTimestamp(stored.updatedAt),
		updatedAt: safeIsoTimestamp(stored.updatedAt),
	};
}

function readMemoryRecord(documentId) {
	const stored = memoryStore.get(documentId);
	if (!stored) {
		return null;
	}
	const now = Date.now();
	const expiry = getTimestampMillis(stored.expiresAt);
	if (expiry !== null && expiry <= now) {
		memoryStore.delete(documentId);
		return null;
	}
	return stored;
}

function emptyBreakdown() {
	return {
		took_trade: 0,
		skipped: 0,
		no_trade_no_signal: 0,
		snoozed: 0,
	};
}

async function saveAcknowledgement({ alertId, chatId, action, notes }) {
	if (!isEnabled()) {
		throw createInvalidRequestError('Alert storage feature is disabled. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to enable.');
	}
	const normalizedAction = validateAction(action);
	if (!normalizedAction) {
		throw createInvalidRequestError(`Invalid action. Must be one of: ${[...VALID_ACTIONS].join(', ')}.`);
	}
	const documentId = toAcknowledgementDocumentId(alertId, chatId);
	const normalizedNotes = normalizeNotes(notes);
	const firestore = getFirestore();
	if (firestore) {
		try {
			const docRef = firestore.collection(COLLECTION_NAME).doc(documentId);
			const existing = await docRef.get();
			const nowMillis = Date.now();
			const isUpdate = existing && existing.exists;
			const document = {
				alertId: alertId.trim(),
				chatId: chatId.trim(),
				action: normalizedAction,
				notes: normalizedNotes,
				updatedAt: admin.firestore.FieldValue.serverTimestamp(),
				expiresAt: buildRetentionExpiryTimestamp(nowMillis),
			};
			if (!isUpdate) {
				document.acknowledgedAt = admin.firestore.FieldValue.serverTimestamp();
			}
			await docRef.set(document, { merge: true });
			const stored = await docRef.get();
			return {
				...buildSafeRecord({ id: documentId, ...(stored.data() || {}) }),
				storage: 'firestore',
			};
		} catch (error) {
			console.warn('[AlertAcknowledgementService] Failed to persist acknowledgement to Firestore, falling back to memory store:', error.message);
		}
	}
	const now = Date.now();
	const existing = readMemoryRecord(documentId);
	const record = {
		id: documentId,
		alertId: alertId.trim(),
		chatId: chatId.trim(),
		action: normalizedAction,
		notes: normalizedNotes,
		acknowledgedAt: existing && existing.acknowledgedAt ? existing.acknowledgedAt : new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + (getAlertStorageRetentionDays() * DAY_MS)),
	};
	memoryStore.set(documentId, record);
	return {
		...buildSafeRecord(record),
		storage: 'memory',
	};
}

async function getAcknowledgement({ alertId, chatId }) {
	if (!isEnabled()) {
		return null;
	}
	let documentId;
	try {
		documentId = toAcknowledgementDocumentId(alertId, chatId);
	} catch (validationError) {
		return null;
	}
	const firestore = getFirestore();
	if (firestore) {
		try {
			const snapshot = await firestore.collection(COLLECTION_NAME).doc(documentId).get();
			if (!snapshot || !snapshot.exists) {
				return null;
			}
			const data = snapshot.data() || {};
			if (getTimestampMillis(data.expiresAt) !== null && getTimestampMillis(data.expiresAt) <= Date.now()) {
				return null;
			}
			return {
				...buildSafeRecord({ id: documentId, ...data }),
				storage: 'firestore',
			};
		} catch (error) {
			console.warn('[AlertAcknowledgementService] Failed to read acknowledgement from Firestore, falling back to memory store:', error.message);
		}
	}
	const stored = readMemoryRecord(documentId);
	if (!stored) {
		return null;
	}
	return {
		...buildSafeRecord(stored),
		storage: 'memory',
	};
}

async function listAcknowledgements({ alertId, limit } = {}) {
	if (!isEnabled()) {
		return { records: [], storage: 'memory' };
	}
	const maxLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 50, 200));
	const firestore = getFirestore();
	if (firestore) {
		try {
			let query = firestore.collection(COLLECTION_NAME).orderBy('updatedAt', 'desc').limit(maxLimit);
			if (typeof alertId === 'string' && alertId.trim()) {
				query = firestore
					.collection(COLLECTION_NAME)
					.where('alertId', '==', alertId.trim())
					.orderBy('updatedAt', 'desc')
					.limit(maxLimit);
			}
			const snapshot = await query.get();
			const records = [];
			snapshot.forEach((doc) => {
				const data = doc.data() || {};
				if (getTimestampMillis(data.expiresAt) !== null && getTimestampMillis(data.expiresAt) <= Date.now()) {
					return;
				}
				records.push(buildSafeRecord({ id: doc.id, ...data }));
			});
			return { records, storage: 'firestore' };
		} catch (error) {
			console.warn('[AlertAcknowledgementService] Failed to list acknowledgements from Firestore, falling back to memory store:', error.message);
		}
	}
	const records = [];
	for (const stored of memoryStore.values()) {
		if (typeof alertId === 'string' && alertId.trim() && stored.alertId !== alertId.trim()) {
			continue;
		}
		if (getTimestampMillis(stored.expiresAt) !== null && getTimestampMillis(stored.expiresAt) <= Date.now()) {
			continue;
		}
		records.push(buildSafeRecord(stored));
	}
	records.sort((a, b) => {
		const aTime = a && a.updatedAt ? Date.parse(a.updatedAt) : 0;
		const bTime = b && b.updatedAt ? Date.parse(b.updatedAt) : 0;
		return bTime - aTime;
	});
	return { records: records.slice(0, maxLimit), storage: 'memory' };
}

async function getAcknowledgementBreakdown(targetAlertId) {
	if (typeof targetAlertId !== 'string' || !targetAlertId.trim()) {
		return { alertId: null, total: 0, breakdown: emptyBreakdown(), storage: 'memory' };
	}
	const { records, storage } = await listAcknowledgements({ alertId: targetAlertId });
	const breakdown = emptyBreakdown();
	let total = 0;
	for (const record of records) {
		if (!record || !record.action || !VALID_ACTIONS.has(record.action)) {
			continue;
		}
		breakdown[record.action] += 1;
		total += 1;
	}
	return { alertId: targetAlertId.trim(), total, breakdown, storage };
}

function clearMemoryStore() {
	memoryStore = new Map();
}

function _resetForTests() {
	clearMemoryStore();
}

module.exports = {
	isEnabled,
	saveAcknowledgement,
	getAcknowledgement,
	listAcknowledgements,
	getAcknowledgementBreakdown,
	clearMemoryStore,
	_resetForTests,
	VALID_ACTIONS,
	COLLECTION_NAME,
	STORAGE_UNAVAILABLE_CODE,
	INVALID_REQUEST_CODE,
	DEFAULT_NOTES_MAX_LENGTH,
};
