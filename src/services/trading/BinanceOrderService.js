'use strict';

const crypto = require('crypto');
const { MainClient } = require('binance');

const TESTNET_BASE_URL = 'https://testnet.binance.vision';
const LIVE_BASE_URL = 'https://api.binance.com';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const ALLOWED_ORDER_TYPES = new Set(['MARKET', 'LIMIT']);
const ALLOWED_SIDES = new Set(['BUY', 'SELL']);
const ALLOWED_TIME_IN_FORCE = new Set(['GTC', 'IOC', 'FOK']);

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

function deriveClientOrderId(idempotencyKey) {
	if (!hasValue(idempotencyKey)) return undefined;
	const digest = crypto.createHash('sha256')
		.update(`cabros-binance-order:${idempotencyKey}`)
		.digest('hex')
		.slice(0, 32);
	return `cb_${digest}`;
}

function isOrderNotFoundError(error) {
	const code = error && (error.code ?? error.body?.code);
	return Number(code) === -2013 || /unknown order/i.test(error?.message || '');
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

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new BinanceOrderRequestError(`${field} must be a positive number`);
	}

	return parsed;
}

function decimalParts(value) {
	const source = String(value).trim().toLowerCase();
	if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/.test(source)) return null;

	const [mantissa, exponentText] = source.split('e');
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
		baseUrl: environment === 'live' ? LIVE_BASE_URL : TESTNET_BASE_URL,
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
		beautifyResponses: true,
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

function getFilters(symbolInfo) {
	return new Map((symbolInfo.filters || []).map((filter) => [filter.filterType, filter]));
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
		workingTime: response.workingTime,
		selfTradePreventionMode: response.selfTradePreventionMode,
		fills: Array.isArray(response.fills) ? response.fills.map(sanitizeFill) : undefined,
	}).filter(([, value]) => value !== undefined));
	return order;
}

function createBinanceOrderService({ createClient = createBinanceClient } = {}) {
	return {
		getStatus() {
			const config = getConfig();
			return {
				enabled: config.enabled,
				configured: config.configured,
				ready: config.enabled && config.configured,
				status: !config.enabled ? 'disabled' : config.configured ? 'ready' : 'misconfigured',
				environment: config.environment,
				allowedSymbols: config.allowedSymbols,
				maxNotionalConfigured: Number.isFinite(config.maxNotional) && config.maxNotional > 0,
			};
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
			if (!config.allowedSymbols.includes(order.symbol)) {
				throw new BinanceOrderRequestError('symbol is not allowed for Binance trading');
			}
			if (order.type === 'MARKET' && order.quantity !== undefined) {
				throw new BinanceOrderRequestError(
					'MARKET orders with quantity are unsupported when enforcing the notional cap; use quoteOrderQty',
					'MARKET_QUANTITY_NOTIONAL_UNSUPPORTED',
				);
			}

			let client;
			try {
				client = createClient(config);
			} catch (error) {
				throw new BinanceOrderServiceError('Binance client could not be initialized', 'BINANCE_CLIENT_UNAVAILABLE', 503);
			}

			let symbolInfo;
			try {
				const exchangeInfo = await client.getExchangeInfo({ symbol: order.symbol });
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

			const filters = getFilters(symbolInfo);
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
				} catch (error) {
					throw new BinanceOrderServiceError('Binance market price validation failed', 'BINANCE_VALIDATION_FAILED');
				}
			}
			validateNotional(notional, filters, config.maxNotional, order.type === 'MARKET');

			const clientOrderId = order.clientOrderId
				|| (!order.dryRun ? deriveClientOrderId(idempotencyKey) : undefined);
			const orderParams = buildOrderParams({ ...order, clientOrderId });
			if (order.dryRun) {
				return {
					success: true,
					dryRun: true,
					environment: config.environment,
					order: orderParams,
				};
			}

			try {
				const existingOrder = await reconcileOrder(client, order.symbol, clientOrderId);
				if (existingOrder) {
					return {
						success: true,
						dryRun: false,
						environment: config.environment,
						order: sanitizeOrderResponse(existingOrder),
					};
				}
				const response = await client.submitNewOrder(orderParams);
				return {
					success: true,
					dryRun: false,
					environment: config.environment,
					order: sanitizeOrderResponse(response || {}),
				};
			} catch (error) {
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
