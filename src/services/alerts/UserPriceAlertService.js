'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const alertStorageService = require('../storage/AlertStorageService');
const sentryService = require('../monitoring/SentryService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { smartEscapeMarkdownV2 } = require('../notification/formatters/markdownV2Formatter');

function getFetchPriceModule() {
	return require('../../controllers/commands/handlers/core/fetchPriceCryptoSymbol');
}

const COLLECTION_NAME = 'userPriceAlerts';
const LOCK_COLLECTION_NAME = 'userPriceAlertLocks';
const LOCK_DOCUMENT_ID = 'singleton';
const DEFAULT_EVALUATION_INTERVAL_MS = 60000;
const MIN_EVALUATION_INTERVAL_MS = 1000;
const MAX_EVALUATION_INTERVAL_MS = 3600000;

const DEFAULT_BATCH_LIMIT = 50;
const MIN_BATCH_LIMIT = 1;
const MAX_BATCH_LIMIT = 500;

const DEFAULT_MAX_PER_CHAT = 20;
const MIN_MAX_PER_CHAT = 1;
const MAX_MAX_PER_CHAT = 100;

const DEFAULT_LEASE_MS = 120000;
const MIN_LEASE_MS = 10000;
const MAX_LEASE_MS = 600000;

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;

// Bounds the fan-out of provider price lookups per sweep. Without this an armed
// batch of `batchLimit` distinct symbols would issue that many concurrent
// Binance/Twelve Data calls and exhaust provider quota (see NEWS_GEMINI_CONCURRENCY).
const DEFAULT_PRICE_FETCH_CONCURRENCY = 3;
const MAX_PRICE_FETCH_CONCURRENCY = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

class UserPriceAlertError extends Error {
	constructor(message, code = 'INVALID_USER_PRICE_ALERT') {
		super(message);
		this.name = 'UserPriceAlertError';
		this.code = code;
		this.isUserFriendly = true;
	}
}

/**
 * Strip `undefined` without destroying Firestore sentinel values.
 *
 * `FieldValue.serverTimestamp()` has zero own keys, so a plain-object rebuild
 * turns it into `{}` and a `Timestamp` into `{_seconds,_nanoseconds}`, both of
 * which the Admin SDK then rejects (or silently misreads). Sentinel instances
 * must survive by identity, so every non-plain object is copied through
 * untouched and only plain objects and arrays are recursed into.
 *
 * This also covers the ordinary `undefined`-stripping case, so it is the single
 * sanitizer used for both the durable write and the value returned to callers.
 */
function sanitizeFirestorePayload(value) {
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => sanitizeFirestorePayload(item))
			.filter((item) => item !== undefined);
	}
	// Non-plain objects (Timestamp, FieldValue, GeoPoint, Buffer, DocumentReference…)
	// are pass-through sentinels and must keep their prototype.
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		return value;
	}
	const result = {};
	for (const [key, val] of Object.entries(value)) {
		if (val !== undefined) {
			result[key] = sanitizeFirestorePayload(val);
		}
	}
	return result;
}

function parseEnvInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		return fallback;
	}
	return Math.max(min, Math.min(parsed, max));
}

function normalizeOperator(op) {
	if (!op || typeof op !== 'string') return null;
	const trimmed = op.trim().toLowerCase();
	if (trimmed === '<' || trimmed === '<=' || trimmed === '>' || trimmed === '>=') {
		return trimmed;
	}
	if (trimmed === 'menor' || trimmed === 'debajo') {
		return '<';
	}
	if (trimmed === 'mayor' || trimmed === 'encima') {
		return '>';
	}
	return null;
}

function parsePriceNumber(rawPrice) {
	if (!rawPrice || typeof rawPrice !== 'string') {
		if (typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0) {
			return rawPrice;
		}
		return null;
	}
	let cleaned = rawPrice.trim();
	// Handle European number formats: 1.234,56 -> 1234.56
	if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
		cleaned = cleaned.replace(/\./g, '').replace(',', '.');
	} else {
		// Handle standard comma separators: 1,234.56 -> 1234.56
		cleaned = cleaned.replace(/,/g, '');
	}

	const parsed = Number(cleaned);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return null;
	}
	return parsed;
}

function parseUserPriceAlertInput(tokens, options = {}) {
	if (!Array.isArray(tokens) || tokens.length === 0) {
		return { valid: false, error: 'missing_args' };
	}

	const filteredTokens = tokens.map((t) => String(t).trim()).filter(Boolean);
	if (filteredTokens.length === 0) {
		return { valid: false, error: 'missing_args' };
	}

	const rawSymbol = filteredTokens[0];
	const rest = filteredTokens.slice(1);

	if (rest.length === 0) {
		return { valid: false, error: 'missing_price_or_condition' };
	}

	let operator = null;
	let targetPrice = null;

	if (rest.length === 1) {
		const token = rest[0];
		// Case: "<60000", ">=3500", etc.
		const opMatch = token.match(/^([<>]=?)(.+)$/);
		if (opMatch) {
			operator = normalizeOperator(opMatch[1]);
			targetPrice = parsePriceNumber(opMatch[2]);
		} else {
			// Case: "60000" without explicit operator
			targetPrice = parsePriceNumber(token);
			if (targetPrice !== null && options && typeof options.currentPrice === 'number') {
				operator = targetPrice < options.currentPrice ? '<' : '>';
			}
		}
	} else if (rest.length >= 2) {
		const firstOp = normalizeOperator(rest[0]);
		if (firstOp) {
			operator = firstOp;
			targetPrice = parsePriceNumber(rest[1]);
		} else {
			// Check if second token is an operator and third is price, or vice-versa
			const secondOp = normalizeOperator(rest[1]);
			if (secondOp && rest.length >= 3) {
				operator = secondOp;
				targetPrice = parsePriceNumber(rest[2]);
			}
		}
	}

	if (!operator || targetPrice === null) {
		return {
			valid: false,
			rawSymbol,
			error: 'invalid_price_or_operator',
		};
	}

	return {
		valid: true,
		rawSymbol,
		operator,
		targetPrice,
	};
}

// Accept a Firestore `Timestamp`, a `Date`, or an ISO string and return an ISO
// string, so every read path exposes one consistent shape.
function normalizeFirestoreTimestamp(value) {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string') return value;
	if (value instanceof Date) return value.toISOString();
	if (typeof value.toDate === 'function') {
		const date = value.toDate();
		return date instanceof Date ? date.toISOString() : null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

class UserPriceAlertService {
	constructor(options = {}) {
		this.botGetter = options.botGetter || null;
		this.workerId = options.workerId || `${process.pid}-${crypto.randomUUID()}`;
		this.running = false;
		this.timer = null;
		this.activeSweepPromise = null;
		this.shutdownRequested = false;

		// In-memory fallback (only authoritative when Firestore is unavailable)
		this._memoryAlerts = new Map();

		// Rotating scan cursor so alerts past the batch limit are never starved.
		this._lastScannedDocId = null;

		// Metrics
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunTriggeredCount = 0;
		this.lastRunErrorCount = 0;
		this.lastError = null;
	}

	_resetForTesting() {
		this._memoryAlerts.clear();
		this._lastScannedDocId = null;
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunTriggeredCount = 0;
		this.lastRunErrorCount = 0;
		this.lastError = null;
	}

	// Durable mode is decided ONCE per operation from a single accessor. Deciding
	// it independently per call site lets a partial Firestore double (or a
	// mid-sweep initialization change) split reads and writes across backends and
	// silently lose state.
	_getFirestore() {
		return alertStorageService.getFirestore();
	}

	setBotGetter(getter) {
		this.botGetter = getter;
	}

	isEnabled() {
		const runtimeConfig = getRuntimeConfig();
		if (runtimeConfig.ENABLE_USER_PRICE_ALERTS !== undefined) {
			return Boolean(runtimeConfig.ENABLE_USER_PRICE_ALERTS);
		}
		return process.env.ENABLE_USER_PRICE_ALERTS === 'true';
	}

	getWorkerRole() {
		const rawRole = (process.env.USER_PRICE_ALERT_WORKER_ROLE || 'web').toLowerCase().trim();
		if (rawRole === 'worker' || rawRole === 'disabled') {
			return rawRole;
		}
		return 'web';
	}

	getIntervalMs() {
		const runtimeConfig = getRuntimeConfig();
		const raw = runtimeConfig.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS !== undefined
			? runtimeConfig.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS
			: process.env.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS;
		return parseEnvInt(raw, DEFAULT_EVALUATION_INTERVAL_MS, MIN_EVALUATION_INTERVAL_MS, MAX_EVALUATION_INTERVAL_MS);
	}

	getBatchLimit() {
		const runtimeConfig = getRuntimeConfig();
		const raw = runtimeConfig.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT !== undefined
			? runtimeConfig.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT
			: process.env.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT;
		return parseEnvInt(raw, DEFAULT_BATCH_LIMIT, MIN_BATCH_LIMIT, MAX_BATCH_LIMIT);
	}

	getMaxPerChat() {
		const runtimeConfig = getRuntimeConfig();
		const raw = runtimeConfig.USER_PRICE_ALERT_MAX_PER_CHAT !== undefined
			? runtimeConfig.USER_PRICE_ALERT_MAX_PER_CHAT
			: process.env.USER_PRICE_ALERT_MAX_PER_CHAT;
		return parseEnvInt(raw, DEFAULT_MAX_PER_CHAT, MIN_MAX_PER_CHAT, MAX_MAX_PER_CHAT);
	}

	getRetentionDays() {
		return parseEnvInt(
			process.env.USER_PRICE_ALERT_RETENTION_DAYS,
			DEFAULT_RETENTION_DAYS,
			MIN_RETENTION_DAYS,
			MAX_RETENTION_DAYS,
		);
	}

	getLeaseMs() {
		return parseEnvInt(
			process.env.USER_PRICE_ALERT_LEASE_MS,
			DEFAULT_LEASE_MS,
			MIN_LEASE_MS,
			MAX_LEASE_MS,
		);
	}

	getPriceFetchConcurrency() {
		return parseEnvInt(
			process.env.USER_PRICE_ALERT_PRICE_FETCH_CONCURRENCY,
			DEFAULT_PRICE_FETCH_CONCURRENCY,
			1,
			MAX_PRICE_FETCH_CONCURRENCY,
		);
	}

	getStatus() {
		const enabled = this.isEnabled();
		const role = this.getWorkerRole();
		// Without Firestore the alerts are process-local and are lost on every
		// deploy, so an operator must not read `ready: true` as "durable".
		const durable = Boolean(this._getFirestore());
		const ready = enabled && durable && role !== 'disabled';

		return {
			enabled,
			configured: durable,
			ready,
			status: !enabled
				? 'disabled'
				: (role === 'disabled' || !durable ? 'degraded' : 'ready'),
			role,
			running: this.running,
			intervalMs: this.getIntervalMs(),
			batchLimit: this.getBatchLimit(),
			maxPerChat: this.getMaxPerChat(),
			retentionDays: this.getRetentionDays(),
			priceFetchConcurrency: this.getPriceFetchConcurrency(),
			storageMode: durable ? 'durable' : 'ephemeral',
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunScannedCount: this.lastRunScannedCount,
			lastRunTriggeredCount: this.lastRunTriggeredCount,
			lastRunErrorCount: this.lastRunErrorCount,
			lastError: this.lastError,
		};
	}

	async createAlert(params) {
		const {
			chatId,
			telegramThreadId,
			symbol,
			exchange,
			assetClass = 'crypto',
			operator,
			targetPrice,
			initialPrice,
		} = params;

		// Without this guard an alert could be created while the feature is off and
		// then never evaluated, leaving the user with a permanently silent alert.
		if (!this.isEnabled()) {
			throw new UserPriceAlertError(
				'Las alertas de precio no están habilitadas en este momento.',
				'USER_PRICE_ALERTS_DISABLED',
			);
		}

		if (!chatId) {
			throw new UserPriceAlertError('chatId es requerido para crear una alerta.');
		}
		if (!symbol) {
			throw new UserPriceAlertError('Símbolo es requerido.');
		}
		const normalizedOp = normalizeOperator(operator);
		if (!normalizedOp) {
			throw new UserPriceAlertError(`Operador no válido: "${operator}". Usa <, <=, >, o >=.`);
		}
		const priceNum = parsePriceNumber(targetPrice);
		if (priceNum === null) {
			throw new UserPriceAlertError(`Precio objetivo no válido: "${targetPrice}".`);
		}

		const maxPerChat = this.getMaxPerChat();
		const currentAlerts = await this.listAlerts({ chatId: String(chatId), status: 'armed' });
		if (currentAlerts.length >= maxPerChat) {
			throw new UserPriceAlertError(
				`Límite de alertas activas alcanzado (máximo ${maxPerChat}). Cancela alguna alerta existente con /alerta cancel <id>.`,
			);
		}

		const alertId = `alert_${crypto.randomUUID().slice(0, 8)}`;
		const now = new Date();
		const expiresAtDate = new Date(now.getTime() + this.getRetentionDays() * DAY_MS);

		const alertData = {
			id: alertId,
			chatId: String(chatId),
			telegramThreadId: telegramThreadId !== undefined && telegramThreadId !== null ? Number(telegramThreadId) : undefined,
			symbol: symbol.toUpperCase(),
			exchange: exchange || undefined,
			assetClass,
			operator: normalizedOp,
			targetPrice: priceNum,
			initialPrice: initialPrice !== undefined && initialPrice !== null ? Number(initialPrice) : undefined,
			status: 'armed',
			createdAt: now.toISOString(),
			expiresAt: expiresAtDate.toISOString(),
		};

		const cleanedData = sanitizeFirestorePayload(alertData);

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				// Sentinels are injected after `undefined` sanitization; the
				// sentinel-aware sanitizer keeps their prototype intact so the
				// Admin SDK accepts them.
				const docRef = firestore.collection(COLLECTION_NAME).doc(alertId);
				const docPayload = {
					...cleanedData,
					createdAt: admin.firestore.FieldValue.serverTimestamp(),
					expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate),
				};
				await docRef.set(sanitizeFirestorePayload(docPayload));
			} catch (err) {
				// The alert would live only in this process's memory and the sweep
				// would read the durable collection, so the user would never be
				// notified. Fail loudly instead of acknowledging a lost alert.
				console.error('[UserPriceAlertService] Firestore write failed:', err.message);
				sentryService.captureRuntimeError({
					channel: 'user-price-alerts',
					error: err,
					extra: { service: 'UserPriceAlertService', operation: 'createAlert', alertId },
				});
				throw new UserPriceAlertError(
					'No se pudo guardar la alerta de precio. Intenta nuevamente en unos segundos.',
					'USER_PRICE_ALERT_PERSIST_UNAVAILABLE',
				);
			}
		} else {
			this._memoryAlerts.set(alertId, cleanedData);
		}

		return cleanedData;
	}

	async listAlerts({ chatId, status = 'armed', limit = 50 } = {}) {
		const firestore = this._getFirestore();
		if (firestore) {
			try {
				// Requires the userPriceAlerts{chatId,status} composite index declared in
				// firestore.indexes.json. Without it Firestore rejects the query outright.
				let query = firestore.collection(COLLECTION_NAME);
				if (chatId) {
					query = query.where('chatId', '==', String(chatId));
				}
				if (status) {
					query = query.where('status', '==', status);
				}
				query = query.limit(limit);
				const snapshot = await query.get();
				const docs = [];
				for (const doc of (snapshot.docs || [])) {
					const data = doc.data() || {};
					docs.push({
						...data,
						id: doc.id,
						createdAt: data.createdAt && typeof data.createdAt.toDate === 'function'
							? data.createdAt.toDate().toISOString()
							: (data.createdAt || new Date().toISOString()),
						expiresAt: data.expiresAt && typeof data.expiresAt.toDate === 'function'
							? data.expiresAt.toDate().toISOString()
							: (data.expiresAt || null),
					});
				}
				return docs;
			} catch (err) {
				// In durable mode the in-process map is NOT authoritative, so falling
				// back to it here would report "no alerts" while the durable rows are
				// still armed and will fire — and would make them impossible to cancel.
				// Surface the storage failure instead of silently under-reporting.
				console.error('[UserPriceAlertService] Firestore listAlerts query failed:', err.message);
				sentryService.captureRuntimeError({
					channel: 'user-price-alerts',
					error: err,
					extra: { service: 'UserPriceAlertService', operation: 'listAlerts' },
				});
				throw new UserPriceAlertError(
					'No se pudieron consultar tus alertas de precio. Intenta nuevamente en unos segundos.',
					'USER_PRICE_ALERT_PERSIST_UNAVAILABLE',
				);
			}
		}

		// Fallback memory query
		const results = [];
		for (const alert of this._memoryAlerts.values()) {
			if (chatId && alert.chatId !== String(chatId)) continue;
			if (status && alert.status !== status) continue;
			results.push(alert);
			if (results.length >= limit) break;
		}
		return results;
	}

	async getAlert(alertId) {
		if (!alertId) return null;
		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const doc = await firestore.collection(COLLECTION_NAME).doc(alertId).get();
				if (doc.exists) {
					const data = doc.data() || {};
					// Project timestamps to ISO strings, matching `listAlerts`, so
					// callers never have to handle two different shapes.
					return {
						...data,
						id: doc.id,
						createdAt: normalizeFirestoreTimestamp(data.createdAt) || new Date().toISOString(),
						expiresAt: normalizeFirestoreTimestamp(data.expiresAt),
					};
				}
				return null;
			} catch (err) {
				// Never answer from the process-local mirror here: a read that failed
				// must not be reported as a durable read, or `cancelAlert` would
				// accept a cancel whose authoritative status is unknown.
				console.error('[UserPriceAlertService] Firestore get failed:', err.message);
				sentryService.captureRuntimeError({
					channel: 'user-price-alerts',
					error: err,
					extra: { service: 'UserPriceAlertService', operation: 'getAlert', alertId },
				});
				throw new UserPriceAlertError(
					'No se pudo consultar la alerta de precio. Intenta nuevamente en unos segundos.',
					'USER_PRICE_ALERT_PERSIST_UNAVAILABLE',
				);
			}
		}
		// Ephemeral mode: the in-process map is the only source of truth.
		return this._memoryAlerts.get(alertId) || null;
	}

	/**
	 * Return a claimed `triggered` alert to `armed` when the notification could
	 * not be delivered at all (no Telegram bot available).
	 *
	 * The rollback is conditional on the document still being `triggered` and
	 * never having recorded a `deliveredAt`, so it can never resurrect an alert a
	 * replica really delivered. It is best-effort and fail-open: if the write
	 * fails the alert simply stays `triggered`.
	 */
	async _rearmUndelivered(alertId) {
		const firestore = this._getFirestore();
		if (firestore && typeof firestore.runTransaction === 'function') {
			try {
				await firestore.runTransaction(async (tx) => {
					const ref = firestore.collection(COLLECTION_NAME).doc(alertId);
					const doc = await tx.get(ref);
					if (!doc.exists) return;
					const data = doc.data() || {};
					if (data.status !== 'triggered' || data.deliveredAt) return;
					tx.update(ref, { status: 'armed', triggeredPrice: null, triggeredAt: null });
				});
			} catch (err) {
				console.warn('[UserPriceAlertService] Failed to re-arm undelivered alert:', err.message);
			}
		}
		const local = this._memoryAlerts.get(alertId);
		if (local && local.status === 'triggered' && !local.deliveredAt) {
			this._memoryAlerts.set(alertId, { ...local, status: 'armed', triggeredPrice: undefined, triggeredAt: undefined });
		}
	}

	/**
	 * Record that a claimed trigger was actually delivered, so a later
	 * undelivered re-arm can never roll it back.
	 */
	async _markDelivered(alertId) {
		const firestore = this._getFirestore();
		if (firestore && typeof firestore.runTransaction === 'function') {
			try {
				await firestore.runTransaction(async (tx) => {
					const ref = firestore.collection(COLLECTION_NAME).doc(alertId);
					const doc = await tx.get(ref);
					if (!doc.exists) return;
					if ((doc.data() || {}).status !== 'triggered') return;
					tx.update(ref, { deliveredAt: admin.firestore.FieldValue.serverTimestamp() });
				});
			} catch (err) {
				console.warn('[UserPriceAlertService] Failed to record delivery:', err.message);
			}
		}
		const local = this._memoryAlerts.get(alertId);
		if (local) {
			this._memoryAlerts.set(alertId, { ...local, deliveredAt: new Date().toISOString() });
		}
	}

	async cancelAlert({ chatId, alertId }) {
		if (!chatId || !alertId) {
			throw new UserPriceAlertError('chatId y alertId son requeridos para cancelar una alerta.');
		}

		const alert = await this.getAlert(alertId);
		if (!alert || alert.chatId !== String(chatId) || alert.status !== 'armed') {
			throw new UserPriceAlertError(`No se encontró una alerta activa con ese ID: ${alertId}`);
		}

		const now = new Date();
		const updatedData = {
			...alert,
			status: 'cancelled',
			cancelledAt: now.toISOString(),
		};

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				// Claim the transition so a concurrent sweep cannot fire an alert the
				// user just cancelled.
				const claimed = await firestore.runTransaction(async (tx) => {
					const ref = firestore.collection(COLLECTION_NAME).doc(alertId);
					const doc = await tx.get(ref);
					if (!doc.exists) return false;
					const status = (doc.data() || {}).status;
					if (status !== 'armed') return false;
					tx.update(ref, {
						status: 'cancelled',
						cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
					});
					return true;
				});
				if (!claimed) {
					throw new UserPriceAlertError(`No se encontró una alerta activa con ese ID: ${alertId}`);
				}
			} catch (err) {
				// Never acknowledge a cancel that did not durably land: the alert would
				// still be `armed` and would fire later.
				if (err instanceof UserPriceAlertError) throw err;
				console.error('[UserPriceAlertService] Firestore cancel update failed:', err.message);
				sentryService.captureRuntimeError({
					channel: 'user-price-alerts',
					error: err,
					extra: { service: 'UserPriceAlertService', operation: 'cancelAlert', alertId },
				});
				throw new UserPriceAlertError(
					'No se pudo cancelar la alerta de precio. Intenta nuevamente en unos segundos.',
					'USER_PRICE_ALERT_PERSIST_UNAVAILABLE',
				);
			}
		}

		// Mirror the transition locally on both paths: `getAlert` is memory-first,
		// so skipping this would leave a stale `armed` record for this replica.
		this._memoryAlerts.set(alertId, updatedData);

		return updatedData;
	}

	async _fetchCurrentPrice(item) {
		const fetchPriceModule = getFetchPriceModule();
		const { symbol, exchange, assetClass } = item;
		if (assetClass === 'equity') {
			const quote = await fetchPriceModule.fetchEquityPrice(symbol, exchange);
			return { symbol: quote.symbol, price: quote.price, assetClass: 'equity' };
		}
		const quote = await fetchPriceModule.fetchCryptoPrice(symbol);
		return { symbol: quote.symbol, price: quote.price, assetClass: 'crypto' };
	}

	async evaluateAlerts() {
		const startTime = Date.now();
		let scannedCount = 0;
		let triggeredCount = 0;
		let errorsCount = 0;
		let lastErrorMessage = null;

		const batchLimit = this.getBatchLimit();
		const leaseMs = this.getLeaseMs();
		const firestore = this._getFirestore();

		// Distributed lease: without it, two web replicas (or the dedicated worker
		// alongside a web replica) both read the same armed documents and both
		// deliver the same notification.
		if (firestore && typeof firestore.runTransaction === 'function') {
			const acquired = await this._acquireLease(Date.now(), leaseMs);
			if (!acquired) {
				this.lastRunAt = new Date(startTime);
				this.lastRunDurationMs = Date.now() - startTime;
				this.lastRunScannedCount = 0;
				this.lastRunTriggeredCount = 0;
				this.lastRunErrorCount = 0;
				return {
					evaluatedCount: 0,
					triggeredCount: 0,
					errorsCount: 0,
					durationMs: this.lastRunDurationMs,
					skipped: 'lease-held',
				};
			}
		}

		const renewHandle = setInterval(() => {
			void this._renewLease(Date.now() + leaseMs);
		}, Math.max(1000, Math.floor(leaseMs / 2)));
		if (typeof renewHandle.unref === 'function') renewHandle.unref();

		try {
			let armedAlerts = [];

			if (firestore) {
				try {
					// Order by document id and resume after the last scanned id so a
					// fixed batch limit can never starve the alerts past it.
					let query = firestore
						.collection(COLLECTION_NAME)
						.where('status', '==', 'armed')
						.orderBy(admin.firestore.FieldPath.documentId())
						.limit(batchLimit);
					if (this._lastScannedDocId) {
						query = query.startAfter(this._lastScannedDocId);
					}
					const snapshot = await query.get();
					const docs = snapshot.docs || [];
					for (const doc of docs) {
						const data = doc.data() || {};
						armedAlerts.push({
							...data,
							id: doc.id,
							expiresAt: data.expiresAt && typeof data.expiresAt.toDate === 'function'
								? data.expiresAt.toDate()
								: (data.expiresAt ? new Date(data.expiresAt) : null),
						});
					}
					this._lastScannedDocId = docs.length > 0
						? docs[docs.length - 1].id
						: null;
				} catch (err) {
					// Without the cursor the next sweep would repeat the same window.
					this._lastScannedDocId = null;
					errorsCount += 1;
					lastErrorMessage = err.message;
					// Durable mode: the process-local map is not authoritative, so
					// evaluating it here would silently skip the real armed alerts
					// (and, worse, re-evaluate ones another replica already handled).
					// Skip this tick and keep the durable source of truth intact.
					console.warn('[UserPriceAlertService] Firestore sweep fetch failed:', err.message);
					sentryService.captureRuntimeError({
						channel: 'user-price-alerts',
						error: err,
						extra: { service: 'UserPriceAlertService', operation: 'evaluateAlerts', phase: 'fetch' },
					});
					armedAlerts = [];
				}
			} else {
				armedAlerts = Array.from(this._memoryAlerts.values()).filter((a) => a.status === 'armed');
			}

			scannedCount = armedAlerts.length;
			const nowTime = Date.now();

			// Step 1: expire
			const validAlerts = [];
			for (const alert of armedAlerts) {
				const expiryMillis = alert.expiresAt ? new Date(alert.expiresAt).getTime() : null;
				if (expiryMillis && expiryMillis <= nowTime) {
					alert.status = 'expired';
					if (firestore) {
						try {
							await firestore.collection(COLLECTION_NAME).doc(alert.id).update({
								status: 'expired',
							});
						} catch (expErr) {
							errorsCount += 1;
							lastErrorMessage = expErr.message;
							console.warn(`[UserPriceAlertService] Failed to expire alert ${alert.id}:`, expErr.message);
						}
					}
					this._memoryAlerts.set(alert.id, { ...alert, status: 'expired' });
				} else {
					validAlerts.push(alert);
				}
			}

			// Step 2: dedupe and fetch prices for distinct symbols, with bounded
			// concurrency so a large armed batch cannot exhaust provider quota.
			const symbolMap = new Map();
			for (const alert of validAlerts) {
				const key = `${alert.assetClass || 'crypto'}:${alert.symbol}:${alert.exchange || ''}`;
				if (!symbolMap.has(key)) {
					symbolMap.set(key, {
						symbol: alert.symbol,
						exchange: alert.exchange,
						assetClass: alert.assetClass || 'crypto',
					});
				}
			}

			const priceCache = new Map();
			const priceEntries = Array.from(symbolMap.entries());
			let cursorIndex = 0;
			const priceWorkers = Array.from(
				{ length: Math.max(1, Math.min(this.getPriceFetchConcurrency(), priceEntries.length)) },
				async () => {
					while (cursorIndex < priceEntries.length) {
						const entry = priceEntries[cursorIndex];
						cursorIndex += 1;
						const [key, query] = entry;
						try {
							const priceInfo = await this._fetchCurrentPrice(query);
							if (priceInfo && Number.isFinite(priceInfo.price)) {
								priceCache.set(key, priceInfo.price);
							}
						} catch (priceErr) {
							console.warn(`[UserPriceAlertService] Price lookup failed for ${query.symbol}:`, priceErr.message);
							errorsCount += 1;
							lastErrorMessage = priceErr.message;
						}
					}
				},
			);
			await Promise.all(priceWorkers);

			// Step 3: evaluate conditions and claim each trigger atomically
			const bot = typeof this.botGetter === 'function' ? this.botGetter() : this.botGetter;

			for (const alert of validAlerts) {
				if (this.shutdownRequested) break;

				const key = `${alert.assetClass || 'crypto'}:${alert.symbol}:${alert.exchange || ''}`;
				const currentPrice = priceCache.get(key);
				if (currentPrice === undefined || !Number.isFinite(currentPrice)) {
					continue;
				}

				const target = Number(alert.targetPrice);
				if (!Number.isFinite(target)) {
					continue;
				}

				const triggered = (alert.operator === '<' && currentPrice < target)
					|| (alert.operator === '<=' && currentPrice <= target)
					|| (alert.operator === '>' && currentPrice > target)
					|| (alert.operator === '>=' && currentPrice >= target);

				if (!triggered) continue;

				// Claim the armed → triggered transition before notifying, so a
				// concurrent replica or overlapping sweep cannot double-notify.
				let claimed;
				if (firestore && typeof firestore.runTransaction === 'function') {
					try {
						claimed = await firestore.runTransaction(async (tx) => {
							const ref = firestore.collection(COLLECTION_NAME).doc(alert.id);
							const doc = await tx.get(ref);
							if (!doc.exists || (doc.data() || {}).status !== 'armed') return false;
							tx.update(ref, {
								status: 'triggered',
								triggeredPrice: currentPrice,
								triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
							});
							return true;
						});
					} catch (txErr) {
						errorsCount += 1;
						lastErrorMessage = txErr.message;
						console.warn(`[UserPriceAlertService] Failed to claim triggered alert ${alert.id}:`, txErr.message);
						continue;
					}
				} else {
					const local = this._memoryAlerts.get(alert.id);
					claimed = !(local && local.status !== 'armed');
					if (claimed) {
						this._memoryAlerts.set(alert.id, {
							...alert,
							status: 'triggered',
							triggeredPrice: currentPrice,
							triggeredAt: new Date().toISOString(),
						});
					}
				}

				if (!claimed) continue;
				triggeredCount += 1;

				// Mirror the durable transition locally so a subsequent read in this
				// process reports `triggered` immediately.
				this._memoryAlerts.set(alert.id, {
					...alert,
					status: 'triggered',
					triggeredPrice: currentPrice,
					triggeredAt: new Date().toISOString(),
				});

				// A missing bot means nothing was delivered. The claim is rolled back so
				// the alert stays `armed` and a later sweep (on a replica that has a
				// bot) can notify instead of silently consuming the user's trigger.
				if (!bot || !bot.telegram) {
					errorsCount += 1;
					lastErrorMessage = 'telegram_bot_unavailable';
					console.error(
						`[UserPriceAlertService] Alert ${alert.id} reached its threshold but the Telegram bot is unavailable; re-arming instead of dropping the trigger.`,
					);
					sentryService.captureRuntimeError({
						channel: 'telegram',
						error: new Error('Telegram bot unavailable for user price alert delivery'),
						extra: { service: 'UserPriceAlertService', alertId: alert.id },
					});
					await this._rearmUndelivered(alert.id);
					continue;
				}

				const conditionText = `${alert.operator} ${target.toLocaleString('en-US')}`;
				const priceText = currentPrice.toLocaleString('en-US');
				const initialPriceText = alert.initialPrice !== undefined && alert.initialPrice !== null
					? Number(alert.initialPrice).toLocaleString('en-US')
					: null;

				const lines = [
					'🔔 *Alerta de Precio Activada*',
					'',
					`• Símbolo: ${smartEscapeMarkdownV2(alert.symbol)}`,
					`• Condición: ${smartEscapeMarkdownV2(conditionText)}`,
					`• Precio actual: *${smartEscapeMarkdownV2(priceText)}*`,
				];
				if (initialPriceText) {
					lines.push(`• Precio inicial: ${smartEscapeMarkdownV2(initialPriceText)}`);
				}
				lines.push(`• ID: ${smartEscapeMarkdownV2(alert.id)}`);

				const sendOptions = { parse_mode: 'MarkdownV2' };
				if (alert.telegramThreadId !== undefined && alert.telegramThreadId !== null) {
					sendOptions.message_thread_id = alert.telegramThreadId;
				}

				try {
					await bot.telegram.sendMessage(alert.chatId, lines.join('\n'), sendOptions);
					// Only a real send makes the trigger final. Anything that leaves the
					// alert undelivered keeps it re-armable so a later sweep retries.
					await this._markDelivered(alert.id);
				} catch (sendErr) {
					errorsCount += 1;
					lastErrorMessage = sendErr.message;
					console.error(`[UserPriceAlertService] Failed to deliver alert ${alert.id}:`, sendErr.message);
					sentryService.captureRuntimeError({
						channel: 'telegram',
						error: sendErr,
						extra: {
							service: 'UserPriceAlertService',
							alertId: alert.id,
							chatId: alert.chatId,
						},
					});
				}
			}
		} catch (error) {
			errorsCount += 1;
			lastErrorMessage = error.message;
			console.error('[UserPriceAlertService] Sweep error:', error.message);
			sentryService.captureRuntimeError({
				channel: 'user-price-alerts',
				error,
			});
		} finally {
			clearInterval(renewHandle);
			if (firestore && typeof firestore.runTransaction === 'function') {
				await this._releaseLease(Date.now());
			}
			this.lastRunAt = new Date(startTime);
			this.lastRunDurationMs = Date.now() - startTime;
			this.lastRunScannedCount = scannedCount;
			this.lastRunTriggeredCount = triggeredCount;
			this.lastRunErrorCount = errorsCount;
			this.lastError = lastErrorMessage;
		}

		return {
			evaluatedCount: scannedCount,
			triggeredCount,
			errorsCount,
			durationMs: this.lastRunDurationMs,
		};
	}

	async _acquireLease(nowMs, leaseMs) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			return true;
		}

		try {
			const docRef = firestore.collection(LOCK_COLLECTION_NAME).doc(LOCK_DOCUMENT_ID);
			const acquired = await firestore.runTransaction(async (tx) => {
				const doc = await tx.get(docRef);
				const data = doc.exists ? (doc.data() || {}) : {};
				const lockedUntilMs = data.lockedUntil ? new Date(data.lockedUntil).getTime() : 0;
				const lockedBy = data.lockedBy || null;

				if (lockedUntilMs > nowMs && lockedBy && lockedBy !== this.workerId) {
					return false;
				}

				tx.set(docRef, {
					lockedUntil: new Date(nowMs + leaseMs).toISOString(),
					lockedBy: this.workerId,
					updatedAt: new Date(nowMs).toISOString(),
				}, { merge: true });
				return true;
			});
			return Boolean(acquired);
		} catch (err) {
			// Fail-open: keep the sweep running rather than silently disabling it.
			console.warn('[UserPriceAlertService] Lease acquire failed:', err.message);
			return true;
		}
	}

	async _renewLease(lockedUntilMs) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			return false;
		}

		try {
			const docRef = firestore.collection(LOCK_COLLECTION_NAME).doc(LOCK_DOCUMENT_ID);
			return Boolean(await firestore.runTransaction(async (tx) => {
				const doc = await tx.get(docRef);
				if (!doc.exists) return false;
				const data = doc.data() || {};
				if (data.lockedBy && data.lockedBy !== this.workerId) {
					return false;
				}
				tx.set(docRef, {
					lockedUntil: new Date(lockedUntilMs).toISOString(),
					updatedAt: new Date().toISOString(),
				}, { merge: true });
				return true;
			}));
		} catch (err) {
			console.warn('[UserPriceAlertService] Lease renew failed:', err.message);
			return false;
		}
	}

	async _releaseLease() {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			return;
		}

		try {
			const docRef = firestore.collection(LOCK_COLLECTION_NAME).doc(LOCK_DOCUMENT_ID);
			await firestore.runTransaction(async (tx) => {
				const doc = await tx.get(docRef);
				if (!doc.exists) return;
				const data = doc.data() || {};
				if (data.lockedBy && data.lockedBy !== this.workerId) {
					return;
				}
				tx.set(docRef, {
					lockedUntil: new Date(0).toISOString(),
					lockedBy: null,
					updatedAt: new Date().toISOString(),
				}, { merge: true });
			});
		} catch (err) {
			console.warn('[UserPriceAlertService] Lease release failed:', err.message);
		}
	}

	startWorker(options = {}) {
		if (!this.isEnabled()) {
			return false;
		}

		// Role must match the process source, otherwise `USER_PRICE_ALERT_WORKER_ROLE=worker`
		// only disables the web timer and silently starts nothing anywhere.
		const source = options.source === 'worker' ? 'worker' : 'web';
		if (this.getWorkerRole() !== source) {
			return false;
		}

		if (this.running) {
			return true;
		}

		this.running = true;
		this.shutdownRequested = false;
		this._scheduleNextSweep(options.intervalMs || this.getIntervalMs());
		console.log('[UserPriceAlertService] Worker started');
		return true;
	}

	_scheduleNextSweep(delayMs) {
		if (!this.running || this.shutdownRequested) {
			return;
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.timer = setTimeout(async () => {
			if (!this.running || this.shutdownRequested) return;
			try {
				this.activeSweepPromise = this.evaluateAlerts();
				await this.activeSweepPromise;
			} catch (sweepErr) {
				console.error('[UserPriceAlertService] Sweep evaluation error:', sweepErr.message);
			} finally {
				this.activeSweepPromise = null;
				this._scheduleNextSweep(this.getIntervalMs());
			}
		}, delayMs);
		if (this.timer && typeof this.timer.unref === 'function') {
			this.timer.unref();
		}
	}

	async stopWorker(options = {}) {
		this.running = false;
		this.shutdownRequested = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (options.drain && this.activeSweepPromise) {
			const sweep = this.activeSweepPromise;
			const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
			// Bound the drain so shutdown cannot hang on a stalled provider call.
			let drainTimeout;
			try {
				await Promise.race([
					sweep.catch(() => undefined),
					new Promise((resolve) => {
						drainTimeout = setTimeout(resolve, timeoutMs);
						if (typeof drainTimeout.unref === 'function') drainTimeout.unref();
					}),
				]);
			} finally {
				// Clear the timer when the sweep wins the race, otherwise every
				// shutdown leaves a dangling handle armed for the full budget.
				clearTimeout(drainTimeout);
			}
		}
	}
}

const userPriceAlertService = new UserPriceAlertService();

module.exports = {
	UserPriceAlertService,
	userPriceAlertService,
	UserPriceAlertError,
	parseUserPriceAlertInput,
};
