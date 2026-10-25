'use strict';

const crypto = require('crypto');

const RESERVATION_COLLECTION = 'binanceBracketReservations';
const ORDER_COLLECTION = 'binanceBracketOrders';
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const TERMINAL_ORDER_STATUSES = new Set([
	'FILLED',
	'CANCELED',
	'REJECTED',
	'EXPIRED',
	'EXPIRED_IN_MATCH',
]);
const SENSITIVE_FIELD_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie|dsn|webhookUrl|private[-_]?key|idempotencyKey)/i;

class BinanceBracketStorageError extends Error {
	constructor(message, code = 'STORAGE_UNAVAILABLE', statusCode = 503) {
		super(message);
		this.name = 'BinanceBracketStorageError';
		this.code = code;
		this.statusCode = statusCode;
	}
}

function hashValue(value) {
	return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sanitizeFirestoreValue(value) {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Date) return value;
	if (value.constructor && (
		value.constructor.name === 'Timestamp'
		|| value.constructor.name === 'FieldValue'
		|| value._type === 'timestamp'
		|| value._type === 'serverTimestamp'
	)) return value;
	if (Array.isArray(value)) {
		return value.map(sanitizeFirestoreValue).filter((item) => item !== undefined);
	}
	const sanitized = {};
	for (const [key, child] of Object.entries(value)) {
		if (SENSITIVE_FIELD_PATTERN.test(key)) continue;
		const safeChild = sanitizeFirestoreValue(child);
		if (safeChild !== undefined) sanitized[key] = safeChild;
	}
	return sanitized;
}

function isTerminalOrderList(orderList = {}) {
	const listStatus = String(orderList.listOrderStatus || orderList.listStatusType || '').toUpperCase();
	if (listStatus === 'ALL_DONE') return true;
	const reports = Array.isArray(orderList.orderReports) ? orderList.orderReports : [];
	return reports.length >= 3
		&& reports.every((report) => TERMINAL_ORDER_STATUSES.has(String(report?.status || '').toUpperCase()));
}

function makeDocumentId(environment, orderList) {
	const environmentPart = String(environment || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
	const identity = hashValue(orderList?.listClientOrderId || 'unknown').slice(0, 32);
	return `${environmentPart}_${identity}`;
}

function createBinanceBracketOrderStorageService({
	getFirestore,
	now = Date.now,
} = {}) {
	function requireFirestore() {
		let firestore;
		try {
			firestore = typeof getFirestore === 'function' ? getFirestore() : null;
		} catch {
			firestore = null;
		}
		if (!firestore || typeof firestore.collection !== 'function' || typeof firestore.runTransaction !== 'function') {
			throw new BinanceBracketStorageError('Bracket order storage is unavailable');
		}
		return firestore;
	}

	function normalizeReservationInput(input = {}) {
		const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
		const requestFingerprint = typeof input.requestFingerprint === 'string' ? input.requestFingerprint.trim() : '';
		if (!idempotencyKey || idempotencyKey.length > 256 || !/^[a-f0-9]{64}$/i.test(requestFingerprint)) {
			throw new BinanceBracketStorageError('Bracket idempotency identity is invalid', 'INVALID_ORDER_REQUEST', 400);
		}
		if (typeof input.listClientOrderId !== 'string' || !/^[A-Za-z0-9._:-]{1,36}$/.test(input.listClientOrderId)) {
			throw new BinanceBracketStorageError('Bracket list client order ID is invalid', 'INVALID_ORDER_REQUEST', 400);
		}
		if (typeof input.symbol !== 'string' || !/^[A-Z0-9]{5,20}$/.test(input.symbol)) {
			throw new BinanceBracketStorageError('Bracket symbol is invalid', 'INVALID_ORDER_REQUEST', 400);
		}
		return {
			keyHash: hashValue(idempotencyKey),
			requestFingerprint,
			listClientOrderId: input.listClientOrderId,
			symbol: input.symbol,
			environment: String(input.environment || 'unknown'),
		};
	}

	async function reserve(input) {
		const normalized = normalizeReservationInput(input);
		const firestore = requireFirestore();
		const ref = firestore.collection(RESERVATION_COLLECTION).doc(normalized.keyHash);
		const timestamp = new Date(now());

		try {
			return await firestore.runTransaction(async (transaction) => {
				const snapshot = await transaction.get(ref);
				if (snapshot.exists) {
					const existing = snapshot.data() || {};
					if (existing.requestFingerprint !== normalized.requestFingerprint) {
						throw new BinanceBracketStorageError(
							'Bracket idempotency key was reused with a different request',
							'BINANCE_ORDER_CONFLICT',
							409,
						);
					}
					return { outcome: 'existing', existingState: existing.state, ...existing, keyHash: normalized.keyHash };
				}

				const reservation = {
					keyHash: normalized.keyHash,
					requestFingerprint: normalized.requestFingerprint,
					listClientOrderId: normalized.listClientOrderId,
					symbol: normalized.symbol,
					environment: normalized.environment,
					state: 'RESERVED',
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				transaction.create(ref, reservation);
				return { outcome: 'reserved', ...reservation };
			});
		} catch (error) {
			if (error instanceof BinanceBracketStorageError) throw error;
			throw new BinanceBracketStorageError('Bracket order reservation could not be written');
		}
	}

	async function getReservation(idempotencyKey) {
		if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
			throw new BinanceBracketStorageError('Bracket idempotency key is required', 'INVALID_ORDER_REQUEST', 400);
		}
		const firestore = requireFirestore();
		try {
			const keyHash = hashValue(idempotencyKey.trim());
			const snapshot = await firestore.collection(RESERVATION_COLLECTION).doc(keyHash).get();
			return snapshot.exists ? { keyHash, ...(snapshot.data() || {}) } : null;
		} catch (error) {
			if (error instanceof BinanceBracketStorageError) throw error;
			throw new BinanceBracketStorageError('Bracket order reservation could not be read');
		}
	}

	async function updateReservation({ keyHash, state, orderListId, errorCode } = {}) {
		if (!/^[a-f0-9]{64}$/i.test(String(keyHash || '')) || !['SUBMITTED', 'COMPLETED', 'AMBIGUOUS', 'REJECTED'].includes(state)) {
			throw new BinanceBracketStorageError('Bracket reservation update is invalid', 'INVALID_ORDER_REQUEST', 400);
		}
		const firestore = requireFirestore();
		const ref = firestore.collection(RESERVATION_COLLECTION).doc(keyHash);
		const update = { state, updatedAt: new Date(now()) };
		if (Number.isSafeInteger(Number(orderListId)) && Number(orderListId) >= 0) update.orderListId = Number(orderListId);
		if (typeof errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(errorCode)) update.errorCode = errorCode;
		try {
			await ref.set(update, { merge: true });
			return update;
		} catch {
			throw new BinanceBracketStorageError('Bracket order reservation could not be updated');
		}
	}

	async function recordOrderList({
		keyHash,
		requestFingerprint,
		symbol,
		environment,
		request,
		orderList,
	} = {}) {
		if ((keyHash !== undefined && !/^[a-f0-9]{64}$/i.test(String(keyHash || ''))) || !orderList || typeof orderList !== 'object') {
			throw new BinanceBracketStorageError('Bracket order-list record is invalid', 'INVALID_ORDER_REQUEST', 400);
		}
		const firestore = requireFirestore();
		const timestamp = new Date(now());
		const terminal = isTerminalOrderList(orderList);
		const detailRef = firestore.collection(ORDER_COLLECTION).doc(makeDocumentId(environment, orderList));

		try {
			await firestore.runTransaction(async (transaction) => {
				const existingSnapshot = await transaction.get(detailRef);
				const existing = existingSnapshot.exists ? existingSnapshot.data() || {} : {};
				const resolvedKeyHash = keyHash || existing.keyHash;
				const reservationRef = resolvedKeyHash
					? firestore.collection(RESERVATION_COLLECTION).doc(resolvedKeyHash)
					: null;
				const reservationSnapshot = reservationRef ? await transaction.get(reservationRef) : null;
				const reservation = reservationSnapshot?.exists ? reservationSnapshot.data() || {} : {};
				if (terminal && !resolvedKeyHash && !existingSnapshot.exists) {
					// A status lookup after TTL cleanup must not recreate and extend terminal detail.
					return;
				}
				const terminalAt = existing.terminalAt || reservation.terminalAt || (terminal ? timestamp : undefined);
				const terminalAtMs = typeof terminalAt?.toMillis === 'function'
					? terminalAt.toMillis()
					: terminalAt instanceof Date ? terminalAt.getTime() : Date.parse(terminalAt);
				const expiresAt = existing.expiresAt || reservation.expiresAt || (Number.isFinite(terminalAtMs)
					? new Date(terminalAtMs + TERMINAL_RETENTION_MS)
					: undefined);
				const detail = sanitizeFirestoreValue({
					keyHash: resolvedKeyHash,
					requestFingerprint: requestFingerprint || existing.requestFingerprint,
					environment: environment || existing.environment,
					symbol: symbol || existing.symbol,
					type: 'BRACKET_LIMIT',
					request: request || existing.request,
					orderList,
					status: orderList.listOrderStatus || orderList.listStatusType || 'UNKNOWN',
					createdAt: existing.createdAt || timestamp,
					updatedAt: timestamp,
					terminalAt,
					expiresAt,
				});
				transaction.set(detailRef, detail, { merge: true });
				if (reservationRef) {
					const reservationUpdate = {
						state: terminalAt ? 'COMPLETED' : 'SUBMITTED',
						orderListId: orderList.orderListId ?? null,
						listClientOrderId: orderList.listClientOrderId ?? null,
						updatedAt: timestamp,
					};
					if (terminalAt !== undefined) reservationUpdate.terminalAt = terminalAt;
					if (expiresAt !== undefined) reservationUpdate.expiresAt = expiresAt;
					transaction.set(reservationRef, reservationUpdate, { merge: true });
				}
			});
			return { orderListId: orderList.orderListId ?? null, terminal };
		} catch {
			throw new BinanceBracketStorageError('Bracket order-list result could not be persisted');
		}
	}

	return {
		reserve,
		getReservation,
		updateReservation,
		recordOrderList,
	};
}

module.exports = {
	BinanceBracketStorageError,
	RESERVATION_COLLECTION,
	ORDER_COLLECTION,
	TERMINAL_RETENTION_MS,
	createBinanceBracketOrderStorageService,
	isTerminalOrderList,
	sanitizeFirestoreValue,
};
