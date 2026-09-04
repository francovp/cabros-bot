'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const AlertStorageService = require('../storage/AlertStorageService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

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

function hashOperator(operator) {
	if (!operator || typeof operator !== 'string') return 'unknown';
	const trimmed = operator.trim();
	if (!trimmed) return 'unknown';
	if (/^[a-f0-9]{64}$/i.test(trimmed)) {
		return trimmed.toLowerCase();
	}
	return crypto.createHash('sha256').update(trimmed).digest('hex');
}

function extractOperatorHash(req) {
	if (!req) return 'unknown';
	const rawKey = req.headers?.['x-api-key']
		|| req.headers?.['X-API-Key']
		|| req.query?.['api-key'];
	const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
	if (typeof key === 'string' && key.trim()) {
		return crypto.createHash('sha256').update(key.trim()).digest('hex');
	}
	const auth = req.headers?.authorization;
	if (typeof auth === 'string' && auth.trim()) {
		return crypto.createHash('sha256').update(auth.trim()).digest('hex');
	}
	return 'unknown';
}

function sanitizeFirestoreValue(value) {
	if (value === undefined || value === null) return null;
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
			if (/^(secret|apiKey|apiSecret|password|token|key)$/i.test(k)) {
				continue;
			}
			out[k] = sanitizeFirestoreValue(v);
		}
		return out;
	}
	return value;
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

			const orderId = params.orderId || crypto.randomUUID();
			const now = new Date();
			const retentionDays = this.getRetentionDays();
			const expiresDate = new Date(now.getTime() + retentionDays * DAY_MS);

			const timestamp = admin?.firestore?.Timestamp?.fromDate
				? admin.firestore.Timestamp.fromDate(now)
				: now.toISOString();

			const expiresAt = admin?.firestore?.Timestamp?.fromDate
				? admin.firestore.Timestamp.fromDate(expiresDate)
				: expiresDate.toISOString();

			const operator = hashOperator(params.operator);

			const record = {
				orderId,
				timestamp,
				operator,
				action: typeof params.action === 'string' ? params.action.toUpperCase() : 'PLACE',
				symbol: typeof params.symbol === 'string' ? params.symbol.toUpperCase() : 'UNKNOWN',
				side: typeof params.side === 'string' ? params.side.toUpperCase() : null,
				type: typeof params.type === 'string' ? params.type.toUpperCase() : null,
				quantity: params.quantity !== undefined && params.quantity !== null ? params.quantity : null,
				price: params.price !== undefined && params.price !== null ? params.price : null,
				status: typeof params.status === 'string' ? params.status : 'SUBMITTED',
				binanceOrderId: params.binanceOrderId !== undefined && params.binanceOrderId !== null
					? String(params.binanceOrderId)
					: null,
				response: sanitizeFirestoreValue(params.response ?? null),
				processingMs: typeof params.processingMs === 'number' && Number.isFinite(params.processingMs)
					? Math.max(0, Math.round(params.processingMs))
					: 0,
				expiresAt,
			};

			const docRef = firestore.collection(COLLECTION_NAME).doc(orderId);
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
