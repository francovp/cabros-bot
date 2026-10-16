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
const ORIGINS = new Set(['manual', 'admin_alert', 'auto_trade']);
const ENVIRONMENTS = new Set(['testnet', 'demo', 'live']);
const MARK_PRICE_BASE_URLS = {
	testnet: 'https://testnet.binance.vision',
	demo: 'https://demo-api.binance.com',
	live: 'https://api.binance.com',
};
const SCALE = 10n ** 18n;
const ALREADY_EXISTS = 6;

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
	const filledAt = toIso(order.transactTime ?? order.updateTime ?? order.time ?? Date.now());

	let rawFills = Array.isArray(order.fills) ? order.fills : [];
	if (rawFills.length === 0) {
		const executedUnits = toUnits(order.executedQty ?? order.executed_qty);
		const quoteUnits = toUnits(order.cummulativeQuoteQty ?? order.cummulative_quote_qty ?? order.cumulativeQuoteQty);
		if (executedUnits !== null && executedUnits > 0n) {
			const price = (quoteUnits !== null && quoteUnits > 0n)
				? fromUnits((quoteUnits * SCALE) / executedUnits)
				: (order.price ? String(order.price) : null);
			if (price) {
				rawFills = [{
					tradeId: order.orderId !== undefined && order.orderId !== null ? String(order.orderId) : (order.clientOrderId || 'reconciled'),
					price,
					qty: fromUnits(executedUnits),
					commission: '0',
					commissionAsset: null,
				}];
			}
		}
	}
	if (rawFills.length === 0) return [];

	return rawFills
		.filter((f) => f && f.tradeId !== undefined && f.tradeId !== null && toUnits(f.qty) !== null && toUnits(f.price) !== null)
		.map((f) => {
			const commission = toUnits(f.commission) !== null ? String(f.commission) : '0';
			const commissionAsset = f.commissionAsset ? String(f.commissionAsset).toUpperCase() : null;
			let commissionQuote = null;
			if (commissionAsset && commissionAsset === quoteAsset) commissionQuote = fromUnits(toUnits(commission));
			else if (commissionAsset && commissionAsset === baseAsset) commissionQuote = multiply(commission, f.price);
			return {
				id: `${environment}:${symbol}:${f.tradeId}`,
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
					alertId: typeof alertId === 'string' && alertId ? alertId : null,
					origin: ORIGINS.has(origin) ? origin : 'manual',
					setupType: typeof setupType === 'string' && setupType ? setupType : null,
					tradeId: f.tradeId,
					filledAt,
				},
			};
		});
}

class TradeLedgerService {
	constructor(options = {}) {
		this.firestore = options.firestore || null;
		this.metrics = options.metrics || firestoreWriteMetricsService;
		this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
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

	getStatus() {
		const enabled = this.isEnabled();
		const configured = this.isConfigured();
		return {
			enabled,
			configured,
			ready: enabled && configured,
			status: !enabled ? 'disabled' : configured ? 'ready' : 'misconfigured',
			collection: COLLECTION_NAME,
			maxScan: this.getMaxScan(),
		};
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
			if (!firestore) return result;
			const collection = firestore.collection(COLLECTION_NAME);
			const recordedAt = new Date().toISOString();
			await Promise.all(records.map(async ({ id, data }) => {
				try {
					await collection.doc(id).create({ ...data, recordedAt });
					result.written += 1;
					this.metrics.recordWriteSuccess(METRICS_DOMAIN);
				} catch (error) {
					if (error?.code === ALREADY_EXISTS || error?.code === 'already-exists') {
						result.duplicates += 1;
						this.metrics.recordWriteSuccess(METRICS_DOMAIN);
						return;
					}
					result.failed += 1;
					this.metrics.recordWriteFailure(METRICS_DOMAIN);
					console.warn('[TradeLedgerService] fill write failed', { symbol: data.symbol, code: error?.code ?? null });
				}
			}));
		} catch (error) {
			console.warn('[TradeLedgerService] recordOrderFills failed:', error?.message || error);
		}
		return result;
	}

	async listFills({ environment } = {}) {
		const firestore = this._getFirestore();
		if (!firestore) {
			const error = new Error('Trade ledger storage is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			throw error;
		}
		const maxScan = this.getMaxScan();
		const snapshot = await firestore.collection(COLLECTION_NAME)
			.where('environment', '==', environment)
			.orderBy('filledAt', 'asc')
			.limit(maxScan)
			.get();
		const fills = (snapshot.docs || []).map((doc) => doc.data()).filter((f) => f && f.environment === environment);
		return { fills, scanTruncated: fills.length >= maxScan, maxScan };
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
