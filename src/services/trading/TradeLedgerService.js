'use strict';

/**
 * Durable trade ledger (#1275).
 *
 * Persists normalized Binance fills to the `tradeFills` collection (no TTL) so
 * realized/unrealized P&L survives the 30-day order-audit retention window.
 * Doc IDs are `${environment}:${symbol}:${tradeId}` and written with
 * `create()`, so retries, replays and reconciles never duplicate a fill.
 *
 * Every write path is fail-open: a ledger or Firestore failure is logged and
 * counted under the `trades` write-metrics domain but never changes the order
 * endpoint's status code or body.
 */

const {
	classifyFirestoreError,
	FIRESTORE_ERROR_CATEGORIES,
} = require('../storage/firestoreErrorCategories');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const AlertStorageService = require('../storage/AlertStorageService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { firestoreWriteMetricsService } = require('../storage/FirestoreWriteMetricsService');
const { deriveSymbolAssets } = require('./BinanceOrderService');
const { toUnits, fromUnits } = require('./tradePnl');

const COLLECTION_NAME = 'tradeFills';
const METRICS_DOMAIN = 'trades';
const DEFAULT_MAX_SCAN = 5000;
const MIN_MAX_SCAN = 1;
const MAX_MAX_SCAN = 20000;
const MARK_PRICE_TIMEOUT_MS = 3000;
const ORIGINS = new Set(['manual', 'admin_alert', 'auto_trade', 'alert']);
const ENVIRONMENTS = new Set(['testnet', 'demo', 'live']);
const MARK_PRICE_BASE_URLS = {
	testnet: 'https://testnet.binance.vision',
	demo: 'https://demo-api.binance.com',
	live: 'https://api.binance.com',
};
const SCALE = 10n ** 18n;
const ALREADY_EXISTS = 6;

const READINESS = Object.freeze({
	UNVERIFIED: 'unverified',
	VERIFIED: 'verified',
	DEGRADED: 'degraded',
});

const REASONS = Object.freeze({
	UNINITIALIZED: 'firestore_not_initialized',
	UNAVAILABLE: 'firestore_unavailable',
});

function isEnabled() {
	return process.env.ENABLE_TRADE_LEDGER === 'true';
}

function isValidMaxScan(value) {
	return Number.isSafeInteger(value) && value >= MIN_MAX_SCAN && value <= MAX_MAX_SCAN;
}

function getMaxScan() {
	const runtimeValue = getRuntimeConfig?.()?.TRADE_LEDGER_MAX_SCAN;
	if (isValidMaxScan(runtimeValue)) return runtimeValue;
	const raw = process.env.TRADE_LEDGER_MAX_SCAN;
	if (raw !== undefined && /^\d+$/.test(String(raw).trim())) {
		const parsed = Number(raw);
		if (isValidMaxScan(parsed)) return parsed;
	}
	return DEFAULT_MAX_SCAN;
}

function multiply(a, b) {
	const left = toUnits(a);
	const right = toUnits(b);
	if (left === null || right === null) return null;
	return fromUnits((left * right) / SCALE);
}

function toIso(value) {
	const ms = typeof value === 'number' ? value : Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

/**
 * Normalize the fills of a FULL Binance order response into ledger records.
 * Pure: returns `[{ id, data }]`, with no `undefined` values in `data`.
 */
function buildFillRecords({ environment, order, origin = 'manual', alertId = null, setupType = null } = {}) {
	if (!order) return [];
	const symbol = String(order.symbol || '').toUpperCase();
	const side = String(order.side || '').toUpperCase();
	if (!symbol || (side !== 'BUY' && side !== 'SELL')) return [];
	const { baseAsset, quoteAsset } = deriveSymbolAssets(symbol);

	const rawFills = Array.isArray(order.fills) ? order.fills : [];
	if (rawFills.length === 0) return [];

	const normalizedOrigin = typeof origin === 'string' ? origin.trim().toLowerCase() : 'manual';
	const safeOrigin = ORIGINS.has(normalizedOrigin) ? normalizedOrigin : 'manual';
	const safeAlertId = typeof alertId === 'string' && alertId.trim() ? alertId.trim() : null;
	const safeSetupType = typeof setupType === 'string' && setupType.trim() ? setupType.trim().toLowerCase() : null;

	return rawFills
		.filter((f) => f && (f.tradeId !== undefined && f.tradeId !== null || f.id !== undefined && f.id !== null) && toUnits(f.qty) !== null && toUnits(f.price) !== null)
		.map((f) => {
			const tradeId = f.tradeId !== undefined && f.tradeId !== null ? f.tradeId : f.id;
			const commission = toUnits(f.commission) !== null ? String(f.commission) : '0';
			const commissionAsset = f.commissionAsset ? String(f.commissionAsset).toUpperCase() : null;
			let commissionQuote = null;
			if (commissionAsset && commissionAsset === quoteAsset) commissionQuote = fromUnits(toUnits(commission));
			else if (commissionAsset && commissionAsset === baseAsset) commissionQuote = multiply(commission, f.price);
			const fillTime = f.time ?? f.transactTime ?? order.transactTime ?? order.updateTime ?? order.time ?? Date.now();
			const fillFilledAt = toIso(fillTime);
			return {
				id: `${environment}:${symbol}:${tradeId}`,
				data: {
					environment,
					symbol,
					baseAsset: baseAsset || null,
					quoteAsset: quoteAsset || null,
					side,
					price: String(f.price),
					qty: String(f.qty),
					quoteQty: multiply(f.qty, f.price),
					commission,
					commissionAsset,
					commissionQuote,
					binanceOrderId: order.orderId !== undefined && order.orderId !== null ? String(order.orderId) : null,
					clientOrderId: order.clientOrderId ? String(order.clientOrderId) : null,
					alertId: safeAlertId,
					origin: safeOrigin,
					setupType: safeSetupType,
					tradeId,
					filledAt: fillFilledAt,
				},
			};
		});
}

class TradeLedgerService {
	constructor(options = {}) {
		this.firestore = options.firestore || null;
		this.metrics = options.metrics || firestoreWriteMetricsService;
		this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
		this.durability = {
			writesAttempted: 0,
			writesSucceeded: 0,
			writesFailed: 0,
			readsAttempted: 0,
			readsSucceeded: 0,
			readsFailed: 0,
			consecutiveFailures: 0,
			lastWriteAt: null,
			lastReadAt: null,
			lastFailureAt: null,
			lastErrorReason: null,
		};
	}

	isEnabled() {
		return isEnabled();
	}

	isConfigured() {
		return Boolean(this.firestore) || isFirestoreConfigured();
	}

	getMaxScan() {
		return getMaxScan();
	}

	_resolveReadiness() {
		if (this.durability.consecutiveFailures > 0) {
			return READINESS.DEGRADED;
		}
		if (this.durability.writesSucceeded > 0) {
			return READINESS.VERIFIED;
		}
		return READINESS.UNVERIFIED;
	}

	getStatus() {
		const enabled = this.isEnabled();
		const configured = this.isConfigured();
		const readiness = this._resolveReadiness();

		let status;
		if (!enabled) {
			status = 'disabled';
		} else if (!configured) {
			status = 'misconfigured';
		} else if (readiness === READINESS.DEGRADED) {
			status = 'degraded';
		} else if (readiness === READINESS.VERIFIED) {
			status = 'ready';
		} else {
			status = READINESS.UNVERIFIED;
		}

		return {
			enabled,
			configured,
			ready: status === 'ready',
			status,
			readiness,
			failOpen: true,
			collection: COLLECTION_NAME,
			maxScan: this.getMaxScan(),
			writesAttempted: this.durability.writesAttempted,
			writesSucceeded: this.durability.writesSucceeded,
			writesFailed: this.durability.writesFailed,
			readsAttempted: this.durability.readsAttempted,
			readsSucceeded: this.durability.readsSucceeded,
			readsFailed: this.durability.readsFailed,
			consecutiveFailures: this.durability.consecutiveFailures,
			lastWriteAt: this.durability.lastWriteAt,
			lastReadAt: this.durability.lastReadAt,
			lastFailureAt: this.durability.lastFailureAt,
			lastErrorReason: this.durability.lastErrorReason,
		};
	}

	__resetReadinessForTesting() {
		this.durability.writesAttempted = 0;
		this.durability.writesSucceeded = 0;
		this.durability.writesFailed = 0;
		this.durability.readsAttempted = 0;
		this.durability.readsSucceeded = 0;
		this.durability.readsFailed = 0;
		this.durability.consecutiveFailures = 0;
		this.durability.lastWriteAt = null;
		this.durability.lastReadAt = null;
		this.durability.lastFailureAt = null;
		this.durability.lastErrorReason = null;
	}

	_getFirestore() {
		return this.firestore || AlertStorageService.getFirestore();
	}

	/** Fail-open: never throws. */
	async recordOrderFills(params = {}) {
		const result = { written: 0, duplicates: 0, failed: 0 };
		try {
			if (!this.isEnabled() || !this.isConfigured() || !ENVIRONMENTS.has(params.environment)) return result;
			const records = buildFillRecords(params);
			if (records.length === 0) return result;
			const firestore = this._getFirestore();
			if (!firestore) {
				this.durability.writesAttempted += records.length;
				this.durability.writesFailed += records.length;
				this.durability.consecutiveFailures += 1;
				this.durability.lastFailureAt = new Date().toISOString();
				this.durability.lastErrorReason = REASONS.UNINITIALIZED;
				result.failed += records.length;
				this.metrics.recordWriteFailure(METRICS_DOMAIN);
				return result;
			}
			const collection = firestore.collection(COLLECTION_NAME);
			const recordedAt = new Date().toISOString();
			let batchWritten = 0;
			let batchDuplicates = 0;
			let batchFailed = 0;
			let lastFailureAt = null;

			await Promise.all(records.map(async ({ id, data }) => {
				try {
					await collection.doc(id).create({ ...data, recordedAt });
					batchWritten += 1;
					this.metrics.recordWriteSuccess(METRICS_DOMAIN);
				} catch (error) {
					if (error?.code === ALREADY_EXISTS || error?.code === 'already-exists') {
						batchDuplicates += 1;
						this.metrics.recordWriteSuccess(METRICS_DOMAIN);
						return;
					}
					batchFailed += 1;
					lastFailureAt = new Date().toISOString();
					this.metrics.recordWriteFailure(METRICS_DOMAIN);
					console.warn('[TradeLedgerService] fill write failed', { symbol: data.symbol, code: error?.code ?? null });
				}
			}));

			result.written = batchWritten;
			result.duplicates = batchDuplicates;
			result.failed = batchFailed;

			this.durability.writesAttempted += records.length;
			this.durability.writesSucceeded += batchWritten + batchDuplicates;
			this.durability.writesFailed += batchFailed;

			if (batchWritten > 0) {
				this.durability.lastWriteAt = recordedAt;
			}

			if (batchFailed > 0) {
				this.durability.consecutiveFailures += 1;
				this.durability.lastFailureAt = lastFailureAt || recordedAt;
				this.durability.lastErrorReason = REASONS.UNAVAILABLE;
			} else if (batchWritten > 0 || batchDuplicates > 0) {
				this.durability.consecutiveFailures = 0;
				this.durability.lastErrorReason = null;
			}
		} catch (error) {
			console.warn('[TradeLedgerService] recordOrderFills failed:', error?.message || error);
		}
		return result;
	}

	async listFills({ environment, limit, startAfter } = {}) {
		this.durability.readsAttempted += 1;
		const firestore = this._getFirestore();
		if (!firestore) {
			this.durability.readsFailed += 1;
			this.durability.consecutiveFailures += 1;
			this.durability.lastFailureAt = new Date().toISOString();
			this.durability.lastErrorReason = REASONS.UNINITIALIZED;
			this.metrics.recordReadFailure(METRICS_DOMAIN, FIRESTORE_ERROR_CATEGORIES.UNINITIALIZED);
			const error = new Error('Trade ledger storage is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			throw error;
		}
		const maxScan = limit !== undefined ? limit : this.getMaxScan();
		const fills = [];
		const BATCH_SIZE = Math.min(1000, maxScan);
		let lastDoc = startAfter || null;

		try {
			while (fills.length < maxScan) {
				const fetchLimit = Math.min(BATCH_SIZE, maxScan - fills.length);
				let query = firestore.collection(COLLECTION_NAME)
					.where('environment', '==', environment)
					.orderBy('filledAt', 'asc')
					.limit(fetchLimit);

				if (lastDoc && typeof query.startAfter === 'function') {
					query = query.startAfter(lastDoc);
				}

				const snapshot = await query.get();
				const docs = snapshot.docs || [];
				if (docs.length === 0) break;

				for (const doc of docs) {
					const data = doc.data();
					if (data && data.environment === environment) {
						fills.push(data);
					}
				}
				lastDoc = docs[docs.length - 1];
				if (docs.length < fetchLimit) break;
			}
			this.durability.readsSucceeded += 1;
			this.durability.consecutiveFailures = 0;
			this.durability.lastReadAt = new Date().toISOString();
			this.metrics.recordReadSuccess(METRICS_DOMAIN);
		} catch (error) {
			this.durability.readsFailed += 1;
			this.durability.consecutiveFailures += 1;
			this.durability.lastFailureAt = new Date().toISOString();
			this.durability.lastErrorReason = REASONS.UNAVAILABLE;
			const category = classifyFirestoreError(error);
			this.metrics.recordReadFailure(METRICS_DOMAIN, category);
			if (error?.code === 'STORAGE_UNAVAILABLE') {
				throw error;
			}
			const storageError = new Error('Trade ledger storage is unavailable');
			storageError.code = 'STORAGE_UNAVAILABLE';
			storageError.category = category;
			storageError.cause = error;
			throw storageError;
		}

		return {
			fills,
			scanTruncated: fills.length >= maxScan,
			maxScan,
			lastDoc,
		};
	}

	/** Fail-open mark prices: symbols whose ticker cannot be fetched are omitted. */
	async fetchMarkPrices(symbols = [], environment = 'testnet') {
		const baseUrl = MARK_PRICE_BASE_URLS[environment];
		const prices = {};
		if (!baseUrl) return prices;
		await Promise.all([...new Set(symbols)].map(async (symbol) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), MARK_PRICE_TIMEOUT_MS);
			try {
				const response = await this.fetchImpl(
					`${baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
					{ signal: controller.signal },
				);
				if (!response.ok) return;
				const body = await response.json();
				if (body && toUnits(body.price) !== null) prices[symbol] = String(body.price);
			} catch {
				// Fail-open: an unavailable ticker yields markPrice: null.
			} finally {
				clearTimeout(timer);
			}
		}));
		return prices;
	}
}

const tradeLedgerService = new TradeLedgerService();

module.exports = {
	COLLECTION_NAME,
	DEFAULT_MAX_SCAN,
	ENVIRONMENTS,
	TradeLedgerService,
	buildFillRecords,
	tradeLedgerService,
};
