'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const AlertStorageService = require('../storage/AlertStorageService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { getIdempotencyKey } = require('../../lib/idempotency');
const { parseAlertPaginationCursor, encodeAlertPaginationCursor } = require('../storage/alertPaginationCursor');

const COLLECTION_NAME = 'binanceOrderAudit';
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

function isEnabled() {
	const runtime = getRuntimeConfig?.();
	if (runtime && typeof runtime.ENABLE_BINANCE_ORDER_AUDIT === 'boolean') {
		return runtime.ENABLE_BINANCE_ORDER_AUDIT;
	}
	return process.env.ENABLE_BINANCE_ORDER_AUDIT === 'true';
}

function getRetentionDays() {
	const runtime = getRuntimeConfig?.();
	const runtimeDays = runtime?.BINANCE_ORDER_AUDIT_RETENTION_DAYS;
	if (typeof runtimeDays === 'number' && Number.isSafeInteger(runtimeDays) && runtimeDays >= MIN_RETENTION_DAYS && runtimeDays <= MAX_RETENTION_DAYS) {
		return runtimeDays;
	}

	const rawValue = process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS;
	if (rawValue !== undefined) {
		const parsed = Number(rawValue);
		if (Number.isSafeInteger(parsed) && parsed >= MIN_RETENTION_DAYS && parsed <= MAX_RETENTION_DAYS) {
			return parsed;
		}
	}

	return DEFAULT_RETENTION_DAYS;
}

const AUDIT_SALT = 'cabros-bot:binance-order-audit';
const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie|dsn|webhookUrl|private[-_]?key)/i;

function hashOperator(operator) {
	if (!operator || typeof operator !== 'string') {
		return 'unknown';
	}
	const trimmed = operator.trim();
	if (!trimmed || trimmed === 'unknown' || trimmed === 'anonymous') {
		return trimmed || 'unknown';
	}
	return crypto.pbkdf2Sync(trimmed, AUDIT_SALT, 10000, 32, 'sha256').toString('hex');
}

function extractOperatorHash(req) {
	if (!req) return 'unknown';
	const rawKey = req.headers?.['x-api-key']
		|| req.headers?.['X-API-Key']
		|| req.query?.['api-key'];
	const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
	if (typeof key === 'string' && key.trim()) {
		return hashOperator(key.trim());
	}
	const auth = req.headers?.authorization;
	if (typeof auth === 'string' && auth.trim()) {
		return hashOperator(auth.trim());
	}
	return 'anonymous';
}

function sanitizeFirestoreValue(value) {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => sanitizeFirestoreValue(v));
	}
	if (typeof value === 'object') {
		if (value.constructor && (
			value.constructor.name === 'FieldValue'
			|| value.constructor.name === 'Timestamp'
			|| value._type === 'serverTimestamp'
			|| value._type === 'timestamp'
		)) {
			return value;
		}
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (SENSITIVE_KEY_PATTERN.test(k)) {
				continue;
			}
			out[k] = sanitizeFirestoreValue(v);
		}
		return out;
	}
	return value;
}

function toIsoString(value) {
	if (!value) return null;
	if (typeof value.toDate === 'function') {
		return value.toDate().toISOString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === 'string') {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
	}
	if (typeof value === 'number') {
		return new Date(value).toISOString();
	}
	if (typeof value.seconds === 'number') {
		return new Date(value.seconds * 1000 + (value.nanoseconds || 0) / 1000000).toISOString();
	}
	return null;
}

function matchesStatus(recordStatus, filterStatus) {
	if (!filterStatus) return true;
	const r = String(recordStatus || '').toLowerCase();
	const f = String(filterStatus || '').toLowerCase();
	if (r === f) return true;
	if (f === 'confirmed' && (r === 'filled' || r === 'confirmed')) return true;
	if (f === 'submitted' && (r === 'new' || r === 'submitted')) return true;
	if (f === 'rejected' && (r === 'rejected' || r === 'failed')) return true;
	return false;
}

function buildParsedCursorTimestamp(parsedCursor) {
	if (!parsedCursor) return null;
	if (parsedCursor.timestamp && Number.isInteger(parsedCursor.timestamp.seconds)) {
		if (admin?.firestore?.Timestamp) {
			return new admin.firestore.Timestamp(
				parsedCursor.timestamp.seconds,
				parsedCursor.timestamp.nanoseconds || 0,
			);
		}
	}
	const date = new Date(parsedCursor.receivedAt);
	if (admin?.firestore?.Timestamp?.fromDate) {
		return admin.firestore.Timestamp.fromDate(date);
	}
	return date.toISOString();
}

function formatAuditRecord(doc) {
	const data = typeof doc.data === 'function' ? doc.data() : (doc || {});
	const id = doc.id || data.orderId;
	return {
		id,
		orderId: data.orderId || id,
		idempotencyKeyHash: data.idempotencyKeyHash ?? null,
		symbol: data.symbol || 'UNKNOWN',
		side: data.side ?? null,
		type: data.type ?? null,
		environment: data.environment || 'testnet',
		status: data.status || 'SUBMITTED',
		errorCode: data.errorCode ?? null,
		dryRun: Boolean(data.dryRun),
		requestFingerprint: data.requestFingerprint ?? null,
		timestamp: toIsoString(data.timestamp),
		operator: data.operator || 'unknown',
		action: data.action || 'PLACE',
		quantity: data.quantity !== undefined && paramsValue(data.quantity),
		price: data.price !== undefined && paramsValue(data.price),
		binanceOrderId: data.binanceOrderId !== undefined && data.binanceOrderId !== null
			? String(data.binanceOrderId)
			: null,
		clientOrderId: data.clientOrderId !== undefined && data.clientOrderId !== null
			? String(data.clientOrderId)
			: null,
		response: data.response ?? null,
		processingMs: data.processingMs ?? 0,
		expiresAt: toIsoString(data.expiresAt),
	};
}

function paramsValue(val) {
	return val !== undefined && val !== null ? val : null;
}

class BinanceOrderAuditService {
	constructor(options = {}) {
		this.firestore = options.firestore || null;
	}

	isEnabled() {
		return isEnabled();
	}

	isConfigured() {
		return Boolean(this.firestore) || isFirestoreConfigured();
	}

	isReady() {
		return this.isEnabled() && this.isConfigured();
	}

	getRetentionDays() {
		return getRetentionDays();
	}

	extractOperatorHash(req) {
		return extractOperatorHash(req);
	}

	_getFirestore() {
		if (this.firestore) {
			return this.firestore;
		}
		return AlertStorageService.getFirestore();
	}

	getStatus() {
		const enabled = this.isEnabled();
		const configured = this.isConfigured();
		const ready = enabled && configured;
		return {
			enabled,
			configured,
			ready,
			status: ready ? 'ready' : enabled ? 'misconfigured' : 'disabled',
			collection: COLLECTION_NAME,
			retentionDays: this.getRetentionDays(),
		};
	}

	async recordMutation(params = {}) {
		if (!this.isEnabled()) {
			return null;
		}
		if (!this.isConfigured()) {
			return null;
		}

		try {
			const firestore = this._getFirestore();
			if (!firestore) {
				return null;
			}

			const now = new Date();
			const retentionDays = this.getRetentionDays();
			const expiresDate = new Date(now.getTime() + retentionDays * DAY_MS);

			const timestamp = admin?.firestore?.Timestamp?.fromDate
				? admin.firestore.Timestamp.fromDate(now)
				: now.toISOString();

			const expiresAt = admin?.firestore?.Timestamp?.fromDate
				? admin.firestore.Timestamp.fromDate(expiresDate)
				: expiresDate.toISOString();

			const operator = params.req
				? extractOperatorHash(params.req)
				: hashOperator(params.operator);

			let idempotencyKeyHash = params.idempotencyKeyHash || null;
			if (!idempotencyKeyHash) {
				const rawKey = params.idempotencyKey || (params.req ? getIdempotencyKey(params.req) : null);
				if (rawKey && typeof rawKey === 'string') {
					idempotencyKeyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
				}
			}

			const symbol = typeof params.symbol === 'string' ? params.symbol.toUpperCase() : 'UNKNOWN';
			const side = typeof params.side === 'string' ? params.side.toUpperCase() : null;
			const type = typeof params.type === 'string' ? params.type.toUpperCase() : null;

			let requestFingerprint = params.requestFingerprint || null;
			if (!requestFingerprint && (symbol !== 'UNKNOWN' || side || type)) {
				const fpPayload = [
					symbol,
					side || '',
					type || '',
					params.quantity ?? '',
					params.price ?? '',
				].join(':');
				requestFingerprint = crypto.createHash('sha256').update(fpPayload).digest('hex');
			}

			const dryRun = typeof params.dryRun === 'boolean'
				? params.dryRun
				: Boolean(params.req?.body?.dryRun);

			const environment = params.environment
				|| params.response?.environment
				|| process.env.BINANCE_TRADING_ENV
				|| 'testnet';

			let status = params.status;
			if (!status) {
				status = dryRun ? 'dry_run' : 'SUBMITTED';
			}

			const errorCode = params.errorCode !== undefined && params.errorCode !== null
				? String(params.errorCode)
				: null;

			const orderId = params.orderId
				|| params.clientOrderId
				|| (params.binanceOrderId ? String(params.binanceOrderId) : crypto.randomUUID());

			const record = {
				orderId,
				idempotencyKeyHash,
				symbol,
				side,
				type,
				environment,
				status,
				errorCode,
				dryRun,
				requestFingerprint,
				timestamp,
				operator,
				action: typeof params.action === 'string' ? params.action.toUpperCase() : 'PLACE',
				quantity: params.quantity !== undefined && params.quantity !== null ? params.quantity : null,
				price: params.price !== undefined && params.price !== null ? params.price : null,
				binanceOrderId: params.binanceOrderId !== undefined && params.binanceOrderId !== null
					? String(params.binanceOrderId)
					: null,
				clientOrderId: params.clientOrderId !== undefined && params.clientOrderId !== null
					? String(params.clientOrderId)
					: null,
				response: sanitizeFirestoreValue(params.response ?? null),
				processingMs: typeof params.processingMs === 'number' && Number.isFinite(params.processingMs)
					? Math.max(0, Math.round(params.processingMs))
					: 0,
				expiresAt,
			};

			const docId = params.id || (params.orderId ? String(params.orderId) : crypto.randomUUID());
			const docRef = firestore.collection(COLLECTION_NAME).doc(docId);
			await docRef.set(record);
			return record;
		} catch (error) {
			console.warn('[BinanceOrderAuditService] Failed to record mutation audit log:', error?.message || error);
			return null;
		}
	}

	async getAuditRecord(orderId) {
		if (!this.isEnabled() || !this.isConfigured() || !orderId) {
			return null;
		}
		try {
			const firestore = this._getFirestore();
			if (!firestore) {
				return null;
			}
			const doc = await firestore.collection(COLLECTION_NAME).doc(orderId).get();
			if (!doc || !doc.exists) {
				return null;
			}
			return { id: doc.id, ...doc.data() };
		} catch (error) {
			console.warn('[BinanceOrderAuditService] Failed to get audit record:', error?.message || error);
			return null;
		}
	}

	async listAuditRecords({
		limit = 50,
		before,
		symbol,
		status,
		from,
		to,
		environment,
		orderId,
		signal,
	} = {}) {
		if (!this.isEnabled()) {
			return null;
		}
		if (!this.isConfigured()) {
			const error = new Error('Binance order audit trail is enabled but Firestore is not configured.');
			error.code = 'STORAGE_UNAVAILABLE';
			throw error;
		}
		const firestore = this._getFirestore();
		if (!firestore) {
			const error = new Error('Binance order audit trail is enabled but Firestore is not configured.');
			error.code = 'STORAGE_UNAVAILABLE';
			throw error;
		}

		const parsedLimit = Number.parseInt(limit, 10);
		const pageSize = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 100
			? parsedLimit
			: 50;
		const targetCount = pageSize + 1;
		const scanLimit = Math.max(targetCount, 100);
		const matches = [];

		const parsedBeforeCursor = before ? parseAlertPaginationCursor(before) : null;
		if (before && !parsedBeforeCursor) {
			const error = new Error('Invalid pagination cursor.');
			error.code = 'INVALID_REQUEST';
			throw error;
		}

		let pageCursor = parsedBeforeCursor
			? {
				receivedAt: parsedBeforeCursor.receivedAt,
				documentId: parsedBeforeCursor.documentId,
				timestamp: parsedBeforeCursor.timestamp,
			}
			: null;

		const normalizedSymbol = typeof symbol === 'string' && symbol.trim() ? symbol.trim().toUpperCase() : null;
		const normalizedStatus = typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : null;
		const fromDate = from ? new Date(from) : null;
		const toDate = to ? new Date(to) : null;
		const normalizedOrderId = typeof orderId === 'string' && orderId.trim() ? orderId.trim() : null;
		const normalizedEnvironment = typeof environment === 'string' && environment.trim() ? environment.trim().toLowerCase() : null;

		while (matches.length < targetCount) {
			if (signal && signal.aborted) {
				const abortErr = new Error('Query was aborted');
				abortErr.name = 'AbortError';
				abortErr.code = 'ABORTED';
				throw abortErr;
			}

			let query = firestore.collection(COLLECTION_NAME);
			if (typeof query.orderBy === 'function') {
				query = query.orderBy('timestamp', 'desc');
				if (admin?.firestore?.FieldPath?.documentId) {
					query = query.orderBy(admin.firestore.FieldPath.documentId(), 'desc');
				}
			}

			if (typeof query.limit === 'function') {
				query = query.limit(scanLimit);
			}

			if (pageCursor) {
				const cursorTimestamp = buildParsedCursorTimestamp(pageCursor);
				if (pageCursor.documentId && typeof query.startAfter === 'function') {
					query = query.startAfter(cursorTimestamp, pageCursor.documentId);
				} else if (typeof query.where === 'function') {
					query = query.where('timestamp', '<', cursorTimestamp);
				}
			}

			let snapshot;
			try {
				snapshot = await query.get();
			} catch (err) {
				console.warn('[BinanceOrderAuditService] Failed to read audit records from Firestore:', err?.message || err);
				const error = new Error('Failed to query Binance order audit records');
				error.code = 'STORAGE_UNAVAILABLE';
				error.cause = err;
				throw error;
			}

			if (!snapshot || snapshot.empty || !Array.isArray(snapshot.docs) || snapshot.docs.length === 0) {
				break;
			}

			for (const doc of snapshot.docs) {
				const formatted = formatAuditRecord(doc);
				const recordDate = formatted.timestamp ? new Date(formatted.timestamp) : null;

				if (normalizedSymbol && formatted.symbol !== normalizedSymbol) continue;
				if (normalizedStatus && !matchesStatus(formatted.status, normalizedStatus)) continue;
				if (normalizedEnvironment && String(formatted.environment).toLowerCase() !== normalizedEnvironment) continue;
				if (normalizedOrderId && formatted.orderId !== normalizedOrderId && formatted.binanceOrderId !== normalizedOrderId && formatted.clientOrderId !== normalizedOrderId) continue;
				if (fromDate && recordDate && recordDate < fromDate) continue;
				if (toDate && recordDate && recordDate > toDate) continue;

				matches.push(formatted);
				if (matches.length >= targetCount) break;
			}

			const lastDoc = snapshot.docs[snapshot.docs.length - 1];
			const lastData = typeof lastDoc.data === 'function' ? lastDoc.data() : (lastDoc || {});
			const lastIso = toIsoString(lastData.timestamp);
			if (!lastIso) break;

			pageCursor = {
				receivedAt: lastIso,
				documentId: lastDoc.id,
				timestamp: lastData.timestamp && lastData.timestamp.seconds ? lastData.timestamp : null,
			};

			if (snapshot.docs.length < scanLimit) break;
		}

		const records = matches.slice(0, pageSize);
		const lastRecord = records.length > 0 ? records[records.length - 1] : null;
		const nextBefore = lastRecord
			? encodeAlertPaginationCursor({
				receivedAt: lastRecord.timestamp,
				id: lastRecord.id,
			})
			: null;

		return {
			records,
			hasMore: matches.length > pageSize,
			nextBefore,
		};
	}

	_resetForTesting() {
		this.firestore = null;
	}
}

const binanceOrderAuditService = new BinanceOrderAuditService();

module.exports = {
	BinanceOrderAuditService,
	binanceOrderAuditService,
	isEnabled,
	getRetentionDays,
	hashOperator,
	extractOperatorHash,
	sanitizeFirestoreValue,
	COLLECTION_NAME,
	DEFAULT_RETENTION_DAYS,
};
