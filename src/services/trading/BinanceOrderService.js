'use strict';

const crypto = require('crypto');
const { MainClient } = require('binance');
const { tradingControlService } = require('./TradingControlService');

const TESTNET_BASE_URL = 'https://testnet.binance.vision';
const LIVE_BASE_URL = 'https://api.binance.com';
const DEFAULT_BINANCE_DATA_BASE_URL = 'https://api.binance.com';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const ALLOWED_ORDER_TYPES = new Set(['MARKET', 'LIMIT']);
const ALLOWED_SIDES = new Set(['BUY', 'SELL']);
const ALLOWED_TIME_IN_FORCE = new Set(['GTC', 'IOC', 'FOK']);
const DEFINITIVE_BINANCE_ERROR_CODES = new Set([-1003, -1015, -1021, -1034]);
const RETRYABLE_BINANCE_ERROR_CODES = new Set([-1001, -1006, -1007]);
const ACCOUNT_DEPENDENT_FILTERS = new Set([
	'MAX_POSITION',
	'MAX_NUM_ORDERS',
	'MAX_NUM_ALGO_ORDERS',
	'MAX_NUM_ICEBERG_ORDERS',
	'EXCHANGE_MAX_NUM_ORDERS',
	'EXCHANGE_MAX_ALGO_ORDERS',
	'EXCHANGE_MAX_NUM_ICEBERG_ORDERS',
]);

class BinanceOrderRequestError extends Error {
	constructor(message, code = 'INVALID_ORDER_REQUEST', statusCode = 400) {
		super(message);
		this.name = 'BinanceOrderRequestError';
		this.code = code;
		this.statusCode = statusCode;
	}
}

class BinanceOrderServiceError extends Error {
	constructor(message, code = 'BINANCE_ORDER_FAILED', statusCode = 502) {
		super(message);
		this.name = 'BinanceOrderServiceError';
		this.code = code;
		this.statusCode = statusCode;
	}
}

function hasValue(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function deriveClientOrderId(idempotencyKey, order) {
	if (!hasValue(idempotencyKey)) return undefined;
	const fingerprint = order ? [
		order.symbol,
		order.side,
		order.type,
		order.quantity ?? '',
		order.quoteOrderQty ?? '',
		order.price ?? '',
		order.timeInForce ?? '',
	].join(':') : '';
	const digest = crypto.createHash('sha256')
		.update(`cabros-binance-order:${idempotencyKey}:${fingerprint}`)
		.digest('hex')
		.slice(0, 32);
	return `cb_${digest}`;
}

function isOrderNotFoundError(error) {
	const code = error && (error.code ?? error.body?.code);
	return Number(code) === -2013 || /unknown order/i.test(error?.message || '');
}

function getBinanceErrorCode(error) {
	const value = error?.code ?? error?.body?.code;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
	return null;
}

function isDefinitiveBinanceRejection(error) {
	const code = getBinanceErrorCode(error);
	if (DEFINITIVE_BINANCE_ERROR_CODES.has(code)) return true;
	if (code === null || RETRYABLE_BINANCE_ERROR_CODES.has(code)) return false;

	const statusCode = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
	return statusCode !== 408 && statusCode !== 429 && (statusCode < 500 || !Number.isFinite(statusCode));
}

async function reconcileOrder(client, symbol, clientOrderId) {
	if (!clientOrderId || typeof client.getOrder !== 'function') return null;

	try {
		return await client.getOrder({ symbol, origClientOrderId: clientOrderId });
	} catch (error) {
		if (isOrderNotFoundError(error)) return null;
		throw new BinanceOrderServiceError(
			'Binance order status could not be reconciled; do not resubmit with a new idempotency key',
			'BINANCE_ORDER_STATUS_UNKNOWN',
			503,
		);
	}
}

function parsePositiveNumber(value, field) {
	if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
		throw new BinanceOrderRequestError(`${field} must be a positive number`);
	}

	const source = String(value).trim();
	const parsed = Number(source);
	if (!Number.isFinite(parsed) || parsed <= 0 || !decimalParts(source)) {
		throw new BinanceOrderRequestError(`${field} must be a positive number`);
	}

	return typeof value === 'string' ? source : parsed;
}

function decimalParts(value) {
	const source = String(value).trim().toLowerCase();
	if (!/^\+?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/.test(source)) return null;

	const normalizedSource = source.startsWith('+') ? source.slice(1) : source;
	const [mantissa, exponentText] = normalizedSource.split('e');
	const [whole, fraction = ''] = mantissa.split('.');
	const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
	const exponent = exponentText ? Number(exponentText) : 0;
	const scale = fraction.length - exponent;
	const integer = BigInt(digits || '0');

	if (scale <= 0) {
		return { integer: integer * (10n ** BigInt(-scale)), scale: 0 };
	}

	return { integer, scale };
}

function compareDecimals(left, right) {
	const leftParts = decimalParts(left);
	const rightParts = decimalParts(right);
	if (!leftParts || !rightParts) return null;

	const scale = Math.max(leftParts.scale, rightParts.scale);
	const leftInteger = leftParts.integer * (10n ** BigInt(scale - leftParts.scale));
	const rightInteger = rightParts.integer * (10n ** BigInt(scale - rightParts.scale));
	return leftInteger === rightInteger ? 0 : (leftInteger < rightInteger ? -1 : 1);
}

function isDecimalMultiple(value, step) {
	const valueParts = decimalParts(value);
	const stepParts = decimalParts(step);
	if (!valueParts || !stepParts || stepParts.integer === 0n) return true;

	const scale = Math.max(valueParts.scale, stepParts.scale);
	const valueInteger = valueParts.integer * (10n ** BigInt(scale - valueParts.scale));
	const stepInteger = stepParts.integer * (10n ** BigInt(scale - stepParts.scale));
	return valueInteger % stepInteger === 0n;
}

function multiplyDecimals(left, right) {
	const leftParts = decimalParts(left);
	const rightParts = decimalParts(right);
	if (!leftParts || !rightParts) return null;
	return { integer: leftParts.integer * rightParts.integer, scale: leftParts.scale + rightParts.scale };
}

function compareDecimalParts(left, right) {
	if (!left || !right) return null;
	const scale = Math.max(left.scale, right.scale);
	const leftInteger = left.integer * (10n ** BigInt(scale - left.scale));
	const rightInteger = right.integer * (10n ** BigInt(scale - right.scale));
	return leftInteger === rightInteger ? 0 : (leftInteger < rightInteger ? -1 : 1);
}

function parseAllowedSymbols(value) {
	return String(value || '')
		.split(',')
		.map((symbol) => symbol.trim().toUpperCase())
		.filter(Boolean);
}

function parseTimeout(value) {
	const parsed = Number.parseInt(value || `${DEFAULT_TIMEOUT_MS}`, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(parsed, MAX_TIMEOUT_MS);
}

function resolveLiveBaseUrl() {
	const configured = process.env.BINANCE_DATA_BASE_URL;
	if (typeof configured === 'string' && configured.trim() !== '') {
		const trimmed = configured.trim();
		if (/^https:\/\//i.test(trimmed)) {
			return trimmed;
		}
		console.warn(
			`[BinanceOrderService] Ignoring BINANCE_DATA_BASE_URL="${configured}" — live orders require an https:// URL. Falling back to ${DEFAULT_BINANCE_DATA_BASE_URL}.`,
		);
	}
	return DEFAULT_BINANCE_DATA_BASE_URL;
}

function getConfig() {
	const environment = (process.env.BINANCE_TRADING_ENV || 'testnet').trim().toLowerCase();
	const allowedSymbols = parseAllowedSymbols(process.env.BINANCE_TRADING_ALLOWED_SYMBOLS);
	const maxNotional = hasValue(process.env.BINANCE_TRADING_MAX_NOTIONAL)
		? Number(process.env.BINANCE_TRADING_MAX_NOTIONAL)
		: null;
	const enabled = process.env.ENABLE_BINANCE_TRADING === 'true';
	const configured = hasValue(process.env.BINANCE_API_KEY)
		&& hasValue(process.env.BINANCE_API_SECRET)
		&& (environment === 'testnet' || environment === 'live')
		&& allowedSymbols.length > 0
		&& Number.isFinite(maxNotional)
		&& maxNotional > 0;

	return {
		enabled,
		configured,
		environment,
		baseUrl: environment === 'live' ? resolveLiveBaseUrl() : TESTNET_BASE_URL,
		allowedSymbols,
		maxNotional,
		timeoutMs: parseTimeout(process.env.BINANCE_TRADING_TIMEOUT_MS),
	};
}

function createBinanceClient(config) {
	return new MainClient({
		api_key: process.env.BINANCE_API_KEY,
		api_secret: process.env.BINANCE_API_SECRET,
		baseUrl: config.baseUrl,
		beautifyResponses: false,
		disableTimeSync: true,
	}, {
		timeout: config.timeoutMs,
	});
}

function normalizeRequest(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new BinanceOrderRequestError('Request body must be an object');
	}

	const allowedKeys = new Set([
		'symbol', 'side', 'type', 'quantity', 'quoteOrderQty', 'price',
		'timeInForce', 'clientOrderId', 'dryRun', 'idempotencyKey', 'idempotency_key',
	]);
	const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key));
	if (unknownKey) throw new BinanceOrderRequestError(`Unsupported order field: ${unknownKey}`);

	const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
	if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
		throw new BinanceOrderRequestError('symbol must be a Binance Spot symbol such as BTCUSDT');
	}

	const side = typeof body.side === 'string' ? body.side.trim().toUpperCase() : '';
	const type = typeof body.type === 'string' ? body.type.trim().toUpperCase() : '';
	if (!ALLOWED_SIDES.has(side)) throw new BinanceOrderRequestError('side must be BUY or SELL');
	if (!ALLOWED_ORDER_TYPES.has(type)) throw new BinanceOrderRequestError('type must be MARKET or LIMIT');

	const hasQuantity = body.quantity !== undefined;
	const hasQuoteOrderQty = body.quoteOrderQty !== undefined;
	if (type === 'MARKET' && hasQuantity === hasQuoteOrderQty) {
		throw new BinanceOrderRequestError('MARKET orders require exactly one of quantity or quoteOrderQty');
	}
	if (type === 'LIMIT' && (!hasQuantity || hasQuoteOrderQty)) {
		throw new BinanceOrderRequestError('LIMIT orders require quantity and do not accept quoteOrderQty');
	}

	const quantity = hasQuantity ? parsePositiveNumber(body.quantity, 'quantity') : undefined;
	const quoteOrderQty = hasQuoteOrderQty ? parsePositiveNumber(body.quoteOrderQty, 'quoteOrderQty') : undefined;
	const price = body.price === undefined ? undefined : parsePositiveNumber(body.price, 'price');
	if (type === 'MARKET' && price !== undefined) throw new BinanceOrderRequestError('MARKET orders do not accept price');
	if (type === 'LIMIT' && price === undefined) throw new BinanceOrderRequestError('LIMIT orders require price');

	const timeInForce = body.timeInForce === undefined
		? (type === 'LIMIT' ? 'GTC' : undefined)
		: typeof body.timeInForce === 'string' ? body.timeInForce.trim().toUpperCase() : '';
	if (timeInForce !== undefined && !ALLOWED_TIME_IN_FORCE.has(timeInForce)) {
		throw new BinanceOrderRequestError('timeInForce must be GTC, IOC, or FOK');
	}
	if (type === 'MARKET' && timeInForce !== undefined) {
		throw new BinanceOrderRequestError('MARKET orders do not accept timeInForce');
	}

	const clientOrderId = body.clientOrderId === undefined ? undefined : String(body.clientOrderId).trim();
	if (clientOrderId !== undefined && !/^[A-Za-z0-9._:-]{1,36}$/.test(clientOrderId)) {
		throw new BinanceOrderRequestError('clientOrderId must contain 1-36 safe characters');
	}

	let dryRun = true;
	if (body.dryRun !== undefined) {
		if (body.dryRun === true || body.dryRun === 'true') dryRun = true;
		else if (body.dryRun === false || body.dryRun === 'false') dryRun = false;
		else throw new BinanceOrderRequestError('dryRun must be boolean');
	}

	return {
		symbol,
		side,
		type,
		quantity,
		quoteOrderQty,
		price,
		timeInForce,
		clientOrderId,
		dryRun,
	};
}

function getSymbolInfo(exchangeInfo, symbol) {
	const symbols = exchangeInfo && Array.isArray(exchangeInfo.symbols) ? exchangeInfo.symbols : [];
	return symbols.find((entry) => entry && entry.symbol === symbol) || null;
}

function getFilters(symbolInfo, exchangeInfo) {
	const symbolFilters = symbolInfo && Array.isArray(symbolInfo.filters) ? symbolInfo.filters : [];
	const exchangeFilters = exchangeInfo && Array.isArray(exchangeInfo.exchangeFilters) ? exchangeInfo.exchangeFilters : [];
	return new Map([...exchangeFilters, ...symbolFilters].map((filter) => [filter.filterType, filter]));
}

function validateFilterRange(value, filter, field, stepName) {
	if (!filter) return;
	if (filter.minQty && compareDecimals(value, filter.minQty) < 0) {
		throw new BinanceOrderRequestError(`${field} is below Binance minimum`);
	}
	if (filter.maxQty && Number(filter.maxQty) > 0 && compareDecimals(value, filter.maxQty) > 0) {
		throw new BinanceOrderRequestError(`${field} exceeds Binance maximum`);
	}
	if (filter.stepSize && Number(filter.stepSize) > 0 && !isDecimalMultiple(value, filter.stepSize)) {
		throw new BinanceOrderRequestError(`${field} does not match Binance ${stepName} step`);
	}
}

function validatePriceRange(value, filter) {
	if (!filter) return;
	if (filter.minPrice && Number(filter.minPrice) > 0 && compareDecimals(value, filter.minPrice) < 0) {
		throw new BinanceOrderRequestError('price is below Binance minimum');
	}
	if (filter.maxPrice && Number(filter.maxPrice) > 0 && compareDecimals(value, filter.maxPrice) > 0) {
		throw new BinanceOrderRequestError('price exceeds Binance maximum');
	}
	if (filter.tickSize && Number(filter.tickSize) > 0 && !isDecimalMultiple(value, filter.tickSize)) {
		throw new BinanceOrderRequestError('price does not match Binance tick size');
	}
}

function validateNotional(notional, filters, maxNotional, isMarketOrder = false) {
	const notionalFilter = filters.get('NOTIONAL');
	const minFilter = notionalFilter || filters.get('MIN_NOTIONAL');
	const minNotional = minFilter?.minNotional;
	const minAppliesToMarket = !isMarketOrder || (
		notionalFilter ? notionalFilter.applyMinToMarket !== false : minFilter?.applyToMarket !== false
	);
	if (minNotional && minAppliesToMarket && compareDecimalParts(notional, decimalParts(minNotional)) < 0) {
		throw new BinanceOrderRequestError('order notional is below Binance minimum');
	}
	if (
		notionalFilter?.maxNotional
		&& Number(notionalFilter.maxNotional) > 0
		&& (!isMarketOrder || notionalFilter.applyMaxToMarket !== false)
		&& compareDecimalParts(notional, decimalParts(notionalFilter.maxNotional)) > 0
	) {
		throw new BinanceOrderRequestError('order notional exceeds Binance maximum');
	}
	if (compareDecimalParts(notional, decimalParts(maxNotional)) > 0) {
		throw new BinanceOrderRequestError('order notional exceeds configured maximum');
	}
}

function buildOrderParams(order) {
	return Object.fromEntries(Object.entries({
		symbol: order.symbol,
		side: order.side,
		type: order.type,
		quantity: order.quantity,
		quoteOrderQty: order.quoteOrderQty,
		price: order.price,
		timeInForce: order.timeInForce,
		newClientOrderId: order.clientOrderId,
		newOrderRespType: 'FULL',
	}).filter(([, value]) => value !== undefined));
}

function reconciledOrderMatchesRequest(order, existingOrder, clientOrderId, requestIdempotencyKey) {
	if (existingOrder.symbol !== order.symbol || existingOrder.clientOrderId !== clientOrderId) return false;
	if (String(existingOrder.side).toUpperCase() !== order.side) return false;
	if (String(existingOrder.type).toUpperCase() !== order.type) return false;
	if (order.type === 'LIMIT' && String(existingOrder.timeInForce || '').toUpperCase() !== order.timeInForce) return false;

	const existingQuantity = existingOrder.origQty ?? existingOrder.quantity;
	const existingQuoteOrderQty = existingOrder.origQuoteOrderQty ?? existingOrder.quoteOrderQty;

	if (order.quantity !== undefined) {
		const isZeroOrigQty = existingQuantity === undefined || compareDecimals(existingQuantity, '0') === 0;
		const hasQuoteQty = existingQuoteOrderQty !== undefined && compareDecimals(existingQuoteOrderQty, '0') > 0;
		// A quantity-based MARKET BUY may have been submitted as quoteOrderQty to bound notional.
		const isConvertedMarketBuy = order.side === 'BUY' && order.type === 'MARKET' && isZeroOrigQty && hasQuoteQty;
		const matchesDerivedFingerprint = isConvertedMarketBuy
			&& Boolean(requestIdempotencyKey)
			&& existingOrder.clientOrderId === deriveClientOrderId(requestIdempotencyKey, order);

		if (!matchesDerivedFingerprint && compareDecimals(existingQuantity, order.quantity) !== 0) {
			return false;
		}
	}

	if (order.quoteOrderQty !== undefined && compareDecimals(existingQuoteOrderQty, order.quoteOrderQty) !== 0) return false;
	if (order.price !== undefined && compareDecimals(existingOrder.price, order.price) !== 0) return false;
	return true;
}

// Exact decimal multiplication serialized without float rounding; returns
// null when either operand is not a valid decimal literal.
function multiplyDecimalsToString(left, right) {
	const parts = multiplyDecimals(left, right);
	if (!parts) return null;
	const digits = String(parts.integer);
	const scale = parts.scale;
	if (scale <= 0) return digits + '0'.repeat(-scale);
	const padded = digits.padStart(scale + 1, '0');
	const whole = padded.slice(0, padded.length - scale);
	const fraction = padded.slice(padded.length - scale).replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole;
}

function truncateDecimalsToPrecision(decimalString, precision) {
	if (typeof precision !== 'number' || precision < 0) return decimalString;
	const [whole, fraction = ''] = String(decimalString).split('.');
	if (fraction.length <= precision) return decimalString;
	const truncatedFraction = fraction.slice(0, precision).replace(/0+$/, '');
	return truncatedFraction.length > 0 ? `${whole}.${truncatedFraction}` : whole;
}

// Quantity-based MARKET BUYs within budget are submitted as an
// exchange-enforced quoteOrderQty so Binance caps realized quote spend at
// BINANCE_TRADING_MAX_NOTIONAL even if execution price rises. MARKET SELLs
// keep base quantity so position sizing stays exact.
function deriveBoundedMarketBuy(order, maxNotional, averagePrice, symbolInfo, filters) {
	if (order.side !== 'BUY' || order.type !== 'MARKET' || order.quantity === undefined || order.quoteOrderQty !== undefined) {
		return order;
	}
	if (!averagePrice || !Number.isFinite(maxNotional) || maxNotional <= 0) return order;

	const rawQuoteOrderQty = multiplyDecimalsToString(order.quantity, averagePrice);
	if (!rawQuoteOrderQty) return order;

	const quotePrecision = symbolInfo?.quotePrecision ?? symbolInfo?.quoteAssetPrecision;
	const quoteOrderQty = typeof quotePrecision === 'number' && quotePrecision >= 0
		? truncateDecimalsToPrecision(rawQuoteOrderQty, quotePrecision)
		: rawQuoteOrderQty;

	if (!quoteOrderQty || compareDecimals(quoteOrderQty, '0') <= 0) return order;

	const notional = decimalParts(quoteOrderQty);
	if (!notional || compareDecimalParts(notional, decimalParts(maxNotional)) > 0) return order;

	const notionalFilter = filters?.get('NOTIONAL') || filters?.get('MIN_NOTIONAL');
	const minNotional = notionalFilter?.minNotional;
	const minAppliesToMarket = notionalFilter ? notionalFilter.applyMinToMarket !== false : notionalFilter?.applyToMarket !== false;
	if (minNotional && minAppliesToMarket && compareDecimalParts(notional, decimalParts(minNotional)) < 0) {
		return order;
	}

	return { ...order, quantity: undefined, quoteOrderQty };
}

async function validateOrderTestFilters(client, order, orderParams, filters) {
	const hasDynamicPriceFilters = order.type === 'LIMIT'
		&& (filters.has('PERCENT_PRICE') || filters.has('PERCENT_PRICE_BY_SIDE'));
	const hasAccountDependentFilters = [...ACCOUNT_DEPENDENT_FILTERS].some((filterType) => filters.has(filterType));
	if (!hasDynamicPriceFilters && !hasAccountDependentFilters) return;
	if (typeof client.testNewOrder !== 'function') {
		throw new BinanceOrderServiceError(
			'Binance order-test filters could not be validated',
			'BINANCE_VALIDATION_FAILED',
		);
	}

	try {
		await client.testNewOrder(orderParams);
	} catch (error) {
		if (isDefinitiveBinanceRejection(error)) {
			throw new BinanceOrderRequestError('order fails Binance order-test filters');
		}
		throw new BinanceOrderServiceError(
			'Binance order-test validation failed; retry without changing the order identity',
			'BINANCE_VALIDATION_FAILED',
		);
	}
}

function sanitizeFill(fill) {
	return Object.fromEntries(Object.entries({
		price: fill.price,
		qty: fill.qty,
		commission: fill.commission,
		commissionAsset: fill.commissionAsset,
		tradeId: fill.tradeId,
	}).filter(([, value]) => value !== undefined));
}

function sanitizeOrderResponse(response) {
	const order = Object.fromEntries(Object.entries({
		symbol: response.symbol,
		orderId: response.orderId,
		orderListId: response.orderListId,
		clientOrderId: response.clientOrderId,
		transactTime: response.transactTime,
		price: response.price,
		origQty: response.origQty,
		executedQty: response.executedQty,
		origQuoteOrderQty: response.origQuoteOrderQty,
		cummulativeQuoteQty: response.cummulativeQuoteQty,
		status: response.status,
		timeInForce: response.timeInForce,
		type: response.type,
		side: response.side,
		stopPrice: response.stopPrice,
		icebergQty: response.icebergQty,
		time: response.time,
		updateTime: response.updateTime,
		isWorking: response.isWorking,
		workingTime: response.workingTime,
		selfTradePreventionMode: response.selfTradePreventionMode,
		fills: Array.isArray(response.fills) ? response.fills.map(sanitizeFill) : undefined,
	}).filter(([, value]) => value !== undefined));
	return order;
}

function hasQueryParam(value) {
	if (value === undefined || value === null) return false;
	if (typeof value === 'string') return value.trim().length > 0;
	if (typeof value === 'number') return Number.isFinite(value);
	return false;
}

function normalizeOrderQuery(query = {}) {
	const rawSymbol = query.symbol;
	if (!hasQueryParam(rawSymbol)) {
		throw new BinanceOrderRequestError('symbol is required');
	}
	const symbol = String(rawSymbol).trim().toUpperCase();
	if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
		throw new BinanceOrderRequestError('symbol must be a Binance Spot symbol such as BTCUSDT');
	}

	let orderId;
	if (hasQueryParam(query.orderId)) {
		const orderIdStr = String(query.orderId).trim();
		if (!/^\d+$/.test(orderIdStr) || Number(orderIdStr) <= 0) {
			throw new BinanceOrderRequestError('orderId must be a positive integer');
		}
		orderId = Number.parseInt(orderIdStr, 10);
	}

	let origClientOrderId;
	const rawClientOrderId = [query.origClientOrderId, query.clientOrderId].find(hasQueryParam);
	if (rawClientOrderId !== undefined) {
		const clientOrderIdStr = String(rawClientOrderId).trim();
		if (!/^[A-Za-z0-9._:-]{1,36}$/.test(clientOrderIdStr)) {
			throw new BinanceOrderRequestError('origClientOrderId must contain 1-36 safe characters');
		}
		origClientOrderId = clientOrderIdStr;
	}

	let limit = 50;
	if (hasQueryParam(query.limit)) {
		const limitStr = String(query.limit).trim();
		if (!/^-?\d+$/.test(limitStr)) {
			throw new BinanceOrderRequestError('limit must be an integer between 1 and 100');
		}
		const parsedLimit = Number.parseInt(limitStr, 10);
		limit = Math.max(1, Math.min(100, parsedLimit));
	}

	return {
		symbol,
		orderId,
		origClientOrderId,
		limit,
	};
}

function createBinanceOrderService({
	createClient = createBinanceClient,
	controlService = tradingControlService,
} = {}) {
	return {
		getStatus() {
			const config = getConfig();
			const controlStatus = typeof controlService.getStatus === 'function'
				? controlService.getStatus()
				: { paused: false, storage: 'memory' };
			return {
				enabled: config.enabled,
				configured: config.configured,
				ready: config.enabled && config.configured,
				status: !config.enabled ? 'disabled' : config.configured ? 'ready' : 'misconfigured',
				environment: config.environment,
				allowedSymbols: config.allowedSymbols,
				maxNotionalConfigured: Number.isFinite(config.maxNotional) && config.maxNotional > 0,
				paused: Boolean(controlStatus.paused),
				pausedBy: controlStatus.pausedBy || null,
				pausedAt: controlStatus.pausedAt || null,
				pausedReason: controlStatus.pausedReason || null,
				lastChangedAt: controlStatus.lastChangedAt || null,
				lastChangedBy: controlStatus.lastChangedBy || null,
				lastAction: controlStatus.lastAction || null,
				controlStorage: controlStatus.storage || 'memory',
			};
		},

		async getPauseState() {
			if (typeof controlService.getPauseState !== 'function') {
				return { paused: false, inactive: true, storage: 'memory' };
			}
			return controlService.getPauseState();
		},

		async getOrders(query = {}) {
			const config = getConfig();
			if (!config.enabled) {
				throw new BinanceOrderRequestError('Binance trading is disabled', 'FEATURE_DISABLED', 403);
			}
			if (!config.configured) {
				throw new BinanceOrderRequestError(
					'Binance trading is enabled but not configured',
					'BINANCE_TRADING_UNAVAILABLE',
					503,
				);
			}

			const { symbol, orderId, origClientOrderId, limit } = normalizeOrderQuery(query);

			if (!config.allowedSymbols.includes(symbol)) {
				throw new BinanceOrderRequestError('symbol is not allowed for Binance trading');
			}

			let client;
			try {
				client = createClient(config);
			} catch (error) {
				throw new BinanceOrderServiceError('Binance client could not be initialized', 'BINANCE_CLIENT_UNAVAILABLE', 503);
			}

			if (orderId !== undefined || origClientOrderId !== undefined) {
				const params = {
					symbol,
					...(orderId !== undefined ? { orderId } : {}),
					...(origClientOrderId !== undefined ? { origClientOrderId } : {}),
				};
				try {
					const order = await client.getOrder(params);
					return {
						success: true,
						environment: config.environment,
						order: sanitizeOrderResponse(order || {}),
					};
				} catch (error) {
					if (isOrderNotFoundError(error)) {
						throw new BinanceOrderRequestError('Binance order not found', 'ORDER_NOT_FOUND', 404);
					}
					if (isDefinitiveBinanceRejection(error)) {
						throw new BinanceOrderRequestError('Binance rejected the request', 'BINANCE_REQUEST_REJECTED', 400);
					}
					throw new BinanceOrderServiceError('Binance order query failed', 'BINANCE_QUERY_FAILED', 502);
				}
			}

			try {
				const orders = await client.allOrders({ symbol, limit });
				const sanitizedOrders = Array.isArray(orders) ? orders.map(sanitizeOrderResponse) : [];
				return {
					success: true,
					environment: config.environment,
					orders: sanitizedOrders,
					count: sanitizedOrders.length,
				};
			} catch (error) {
				if (isDefinitiveBinanceRejection(error)) {
					throw new BinanceOrderRequestError('Binance rejected the request', 'BINANCE_REQUEST_REJECTED', 400);
				}
				throw new BinanceOrderServiceError('Binance order query failed', 'BINANCE_QUERY_FAILED', 502);
			}
		},

		async placeOrder(body, { idempotencyKey } = {}) {
			const config = getConfig();
			if (!config.enabled) throw new BinanceOrderRequestError('Binance trading is disabled', 'FEATURE_DISABLED', 403);
			if (!config.configured) {
				throw new BinanceOrderRequestError(
					'Binance trading is enabled but not configured',
					'BINANCE_TRADING_UNAVAILABLE',
					503,
				);
			}

			const order = normalizeRequest(body);

			// Runtime kill-switch: a paused or unavailable pause state
			// blocks every Binance path (live and dryRun) so the
			// operator can stop new submissions instantly. The check
			// happens before any client is constructed or signed call
			// is made.
			if (typeof controlService.getPauseState === 'function') {
				const pauseState = await controlService.getPauseState();
				if (pauseState && pauseState.isBlocked && pauseState.isBlocked()) {
					const message = pauseState.paused
						? `Binance order submissions are paused${pauseState.pausedBy ? ` by ${pauseState.pausedBy}` : ''}${pauseState.pausedReason ? `: ${pauseState.pausedReason}` : ''}`
						: pauseState.unavailable
							? 'Binance trading pause state is unavailable; refusing to submit until storage recovers'
							: 'Binance order submissions are blocked';
					throw new BinanceOrderServiceError(message, 'TRADING_PAUSED', 503);
				}
			}
			const requestIdempotencyKey = hasValue(idempotencyKey)
				? idempotencyKey
				: [body.idempotencyKey, body.idempotency_key].find(hasValue);
			if (!order.dryRun && !order.clientOrderId && !requestIdempotencyKey) {
				throw new BinanceOrderRequestError(
					'Live orders require idempotencyKey or clientOrderId',
					'LIVE_ORDER_ID_REQUIRED',
				);
			}
			let client;
			try {
				client = createClient(config);
			} catch (error) {
				throw new BinanceOrderServiceError('Binance client could not be initialized', 'BINANCE_CLIENT_UNAVAILABLE', 503);
			}

			const clientOrderId = order.clientOrderId
				|| (!order.dryRun ? deriveClientOrderId(requestIdempotencyKey, order) : undefined);
			if (!order.dryRun) {
				const existingOrder = await reconcileOrder(client, order.symbol, clientOrderId);
				if (existingOrder) {
					if (!reconciledOrderMatchesRequest(order, existingOrder, clientOrderId, requestIdempotencyKey)) {
						throw new BinanceOrderRequestError(
							'Reconciled Binance order does not match the request',
							'BINANCE_ORDER_CONFLICT',
							409,
						);
					}
					return {
						success: true,
						dryRun: false,
						environment: config.environment,
						order: sanitizeOrderResponse(existingOrder),
					};
				}
			}

			if (!config.allowedSymbols.includes(order.symbol)) {
				throw new BinanceOrderRequestError('symbol is not allowed for Binance trading');
			}

			let symbolInfo;
			let exchangeInfo;
			try {
				exchangeInfo = await client.getExchangeInfo({ symbol: order.symbol });
				symbolInfo = getSymbolInfo(exchangeInfo, order.symbol);
			} catch (error) {
				throw new BinanceOrderServiceError('Binance symbol validation failed', 'BINANCE_VALIDATION_FAILED');
			}

			if (!symbolInfo || symbolInfo.status !== 'TRADING' || symbolInfo.isSpotTradingAllowed === false) {
				throw new BinanceOrderRequestError('symbol is not available for Spot trading');
			}
			if (!Array.isArray(symbolInfo.orderTypes) || !symbolInfo.orderTypes.includes(order.type)) {
				throw new BinanceOrderRequestError('order type is not supported for this symbol');
			}
			if (order.quoteOrderQty !== undefined && symbolInfo.quoteOrderQtyMarketAllowed === false) {
				throw new BinanceOrderRequestError('quoteOrderQty is not supported for this symbol');
			}

			const filters = getFilters(symbolInfo, exchangeInfo);
			const quantityFilter = filters.get(order.type === 'MARKET' ? 'MARKET_LOT_SIZE' : 'LOT_SIZE') || filters.get('LOT_SIZE');
			const priceFilter = filters.get('PRICE_FILTER');
			const notionalFilter = filters.get('NOTIONAL') || filters.get('MIN_NOTIONAL');
			if (order.quantity !== undefined && !quantityFilter) {
				throw new BinanceOrderRequestError('Binance quantity filters are unavailable for this symbol');
			}
			if (order.price !== undefined && !priceFilter) {
				throw new BinanceOrderRequestError('Binance price filters are unavailable for this symbol');
			}
			if (!notionalFilter) {
				throw new BinanceOrderRequestError('Binance notional filters are unavailable for this symbol');
			}
			if (order.quantity !== undefined) validateFilterRange(order.quantity, quantityFilter, 'quantity', 'lot-size');
			if (order.price !== undefined) validatePriceRange(order.price, priceFilter);

			let notional;
			let boundedOrder = order;
			if (order.quoteOrderQty !== undefined) {
				notional = decimalParts(order.quoteOrderQty);
			} else if (order.type === 'LIMIT') {
				notional = multiplyDecimals(order.quantity, order.price);
			} else {
				try {
					const averagePrice = await client.getAvgPrice({ symbol: order.symbol });
					const price = averagePrice && averagePrice.price;
					if (!price || !decimalParts(price)) throw new Error('invalid average price');
					notional = multiplyDecimals(order.quantity, price);

					boundedOrder = deriveBoundedMarketBuy(order, config.maxNotional, price, symbolInfo, filters);
					if (boundedOrder.quoteOrderQty !== undefined) {
						// The converted order must respect the symbol's quote-order support.
						if (symbolInfo.quoteOrderQtyMarketAllowed === false) {
							throw new BinanceOrderRequestError('quoteOrderQty is not supported for this symbol');
						}
						notional = decimalParts(boundedOrder.quoteOrderQty);
					}
				} catch (error) {
					if (error instanceof BinanceOrderRequestError) throw error;
					throw new BinanceOrderServiceError('Binance market price validation failed', 'BINANCE_VALIDATION_FAILED');
				}
			}
			validateNotional(notional, filters, config.maxNotional, order.type === 'MARKET');

			const orderParams = buildOrderParams({ ...boundedOrder, clientOrderId });
			if (order.dryRun) {
				await validateOrderTestFilters(client, boundedOrder, orderParams, filters);
				return {
					success: true,
					dryRun: true,
					environment: config.environment,
					order: orderParams,
				};
			}

			await validateOrderTestFilters(client, boundedOrder, orderParams, filters);
			try {
				const response = await client.submitNewOrder(orderParams);
				return {
					success: true,
					dryRun: false,
					environment: config.environment,
					order: sanitizeOrderResponse(response || {}),
				};
			} catch (error) {
				if (isDefinitiveBinanceRejection(error)) {
					throw new BinanceOrderRequestError('Binance rejected the order', 'BINANCE_ORDER_REJECTED');
				}
				throw new BinanceOrderServiceError(
					'Binance accepted or may have accepted the order, but its final status is unknown; do not resubmit with a new idempotency key',
					'BINANCE_ORDER_STATUS_UNKNOWN',
					503,
				);
			}
		},
	};
}

const binanceOrderService = createBinanceOrderService();

module.exports = {
	BinanceOrderRequestError,
	BinanceOrderServiceError,
	TESTNET_BASE_URL,
	LIVE_BASE_URL,
	createBinanceOrderService,
	binanceOrderService,
	getConfig,
};
