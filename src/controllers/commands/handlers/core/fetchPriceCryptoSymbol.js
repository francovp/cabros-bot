'use strict';

const { round10 } = require('../../../helpers');
const { MainClient } = require('binance');
const sentryService = require('../../../../services/monitoring/SentryService');
const equityMarketDataService = require('../../../../services/storage/EquityMarketDataService');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');

const client = new MainClient({
	// Optional (default: false) - when true, response strings are parsed to floats (only for known keys).
	beautifyResponses: true,
});

const CRYPTO_QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];
const FOREX_PAIRS = new Set(['USDCLP', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD']);

function formatTickerPrice(value) {
	const price = Number(value);
	if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid 24h ticker payload');
	return price >= 1 ? round10(price, -2) : price;
}

function formatCryptoTicker(ticker, symbol) {
	const changePercent = Number(ticker?.priceChangePercent);
	const highPrice = formatTickerPrice(ticker?.highPrice);
	const lowPrice = formatTickerPrice(ticker?.lowPrice);
	const quoteVolume = Number(ticker?.quoteVolume);
	if (!Number.isFinite(changePercent) || !Number.isFinite(quoteVolume) || quoteVolume < 0) {
		throw new Error('Invalid 24h ticker payload');
	}

	const direction = changePercent > 0 ? '▲ ' : changePercent < 0 ? '▼ ' : '';
	const sign = changePercent > 0 ? '+' : '';
	const quoteAsset = CRYPTO_QUOTE_SUFFIXES.find((quote) => symbol?.endsWith(quote)) || '';
	return {
		changePercent,
		highPrice,
		lowPrice,
		quoteVolume,
		message: `24h: ${direction}${sign}${changePercent.toFixed(2)}% | Rango: ${lowPrice} – ${highPrice}\nVol: ${new Intl.NumberFormat('en-US', {
			notation: 'compact',
			maximumFractionDigits: 1,
		}).format(quoteVolume)}${quoteAsset ? ` ${quoteAsset}` : ''}`,
	};
}

function classifyPriceQuery(rawInput) {
	if (!rawInput || typeof rawInput !== 'string' || rawInput.trim() === '') {
		return { valid: false, error: 'missing_symbol' };
	}

	const input = rawInput.trim();
	const colonIdx = input.indexOf(':');
	let exchange = null;
	let symbol = input;

	if (colonIdx !== -1) {
		exchange = input.slice(0, colonIdx).trim().toUpperCase();
		symbol = input.slice(colonIdx + 1).trim().toUpperCase();
	} else {
		symbol = input.toUpperCase();
	}

	// Remove trailing timeframe suffix like (D) or (1h) if present
	symbol = symbol.replace(/\s*\([A-Za-z0-9]+\)$/, '');

	if (exchange) {
		if (exchange === 'BINANCE' || exchange === 'BYBIT' || exchange === 'COINBASE' || exchange === 'OKX' || exchange === 'KRAKEN') {
			return { valid: true, assetClass: 'crypto', exchange: 'BINANCE', symbol };
		}
		if (equityMarketDataService.isSupportedExchange(exchange)) {
			return {
				valid: true,
				assetClass: 'equity',
				exchange: equityMarketDataService.normalizeExchange(exchange),
				symbol,
			};
		}
		return {
			valid: true,
			assetClass: 'unsupported',
			exchange,
			symbol,
			reason: `Exchange ${exchange} no soportado para consulta de precios.`,
		};
	}

	// Bare symbols (no exchange prefix)
	const cleanSlashSymbol = symbol.replace('/', '');
	if (CRYPTO_QUOTE_SUFFIXES.some(suffix => symbol.endsWith(`/${suffix}`) || (symbol.length > 4 && symbol.endsWith(suffix)))) {
		return { valid: true, assetClass: 'crypto', exchange: 'BINANCE', symbol: cleanSlashSymbol };
	}

	if (FOREX_PAIRS.has(cleanSlashSymbol) || symbol.includes('/')) {
		return { valid: true, assetClass: 'equity', exchange: 'FX_IDC', symbol };
	}

	if (symbol === 'SPX' || symbol === 'NDX') {
		return { valid: true, assetClass: 'equity', exchange: 'SPCFD', symbol };
	}

	// Typical stock ticker (1-6 alphanumeric characters)
	if (/^[A-Z0-9._-]{1,6}$/.test(symbol)) {
		return { valid: true, assetClass: 'equity', exchange: null, symbol };
	}

	// Fallback to crypto
	return { valid: true, assetClass: 'crypto', exchange: 'BINANCE', symbol };
}

async function fetchCryptoPrice(symbol, options = {}) {
	const { parentSpan } = options;
	const priceFetchSpan = sentryService.startInactiveSpan({
		name: 'binance.get_avg_price',
		op: 'http.client',
		onlyIfParent: true,
		parentSpan,
		attributes: {
			'provider.name': 'binance',
			'provider.operation': 'getAvgPrice',
			'crypto.symbol': symbol || 'missing',
		},
	});

	try {
		const data = await client.getAvgPrice({ symbol });
		const price = data.price >= 1 ? round10(data.price, 0) : data.price;
		let ticker;
		const tickerSpan = sentryService.startInactiveSpan({
			name: 'binance.get_24hr_change_statistics',
			op: 'http.client',
			onlyIfParent: true,
			parentSpan,
			attributes: {
				'provider.name': 'binance',
				'provider.operation': 'get24hrChangeStatistics',
				'crypto.symbol': symbol || 'missing',
			},
		});
		try {
			const tickerClient = new MainClient({ beautifyResponses: true }, {
				timeout: getRuntimeConfig().BINANCE_FETCH_TIMEOUT_MS,
			});
			ticker = formatCryptoTicker(await tickerClient.get24hrChangeStatistics({ symbol }), symbol);
		} catch (error) {
			console.warn('Unable to enrich Binance price with 24h ticker:', error.message);
		} finally {
			sentryService.endSpan(tickerSpan);
		}

		const baseMessage = `Precio de ${symbol} es ${price}`;
		return {
			symbol,
			price,
			assetClass: 'crypto',
			...(ticker ? {
				changePercent24h: ticker.changePercent,
				highPrice24h: ticker.highPrice,
				lowPrice24h: ticker.lowPrice,
				quoteVolume24h: ticker.quoteVolume,
			} : {}),
			message: ticker ? `${baseMessage}\n${ticker.message}` : baseMessage,
		};
	} catch (e) {
		console.error('Error fetching symbol price from Binance:', e);
		const isInvalidSymbol = (e && e.code === -1121) || (e && e.message && /invalid symbol/i.test(e.message));
		const errorMessage = isInvalidSymbol
			? `No se encontró el símbolo ${symbol} en Binance.`
			: `No se pudo obtener el precio de ${symbol} en Binance.`;
		const error = new Error(errorMessage);
		error.userMessage = errorMessage;
		error.originalError = e;
		error.isUserFriendly = isInvalidSymbol;
		throw error;
	} finally {
		sentryService.endSpan(priceFetchSpan);
	}
}

async function fetchEquityPrice(symbol, exchange, options = {}) {
	const status = equityMarketDataService.getStatus();
	if (!status.enabled) {
		const error = new Error('El servicio de datos de acciones no está habilitado.');
		error.userMessage = 'El servicio de datos de acciones no está habilitado.';
		error.isUserFriendly = true;
		throw error;
	}

	if (!status.configured) {
		const error = new Error('El proveedor de datos de acciones no está configurado.');
		error.userMessage = 'El proveedor de datos de acciones no está configurado.';
		error.isUserFriendly = true;
		throw error;
	}

	const { parentSpan, timeoutMs } = options;
	const priceFetchSpan = sentryService.startInactiveSpan({
		name: 'twelve_data.get_quote',
		op: 'http.client',
		onlyIfParent: true,
		parentSpan,
		attributes: {
			'provider.name': 'twelve-data',
			'provider.operation': 'getQuote',
			'equity.symbol': symbol || 'missing',
			'equity.exchange': exchange || 'default',
		},
	});

	const startTime = Date.now();
	try {
		const quote = await equityMarketDataService.getQuote({ symbol, exchange, timeoutMs });
		const price = quote.price >= 1 ? round10(quote.price, -2) : quote.price;
		let changeStr = '';
		if (quote.percentChange !== null && quote.percentChange !== undefined) {
			const sign = quote.percentChange > 0 ? '+' : '';
			changeStr = ` (${sign}${quote.percentChange.toFixed(2)}%)`;
		}
		const message = `Precio de ${quote.symbol} es ${price}${changeStr}`;
		return {
			symbol: quote.symbol,
			name: quote.name,
			exchange: quote.exchange,
			currency: quote.currency,
			price,
			change: quote.change,
			percentChange: quote.percentChange,
			assetClass: 'equity',
			message,
		};
	} catch (e) {
		const durationMs = Date.now() - startTime;
		console.error('Error fetching equity quote from Twelve Data:', e);
		sentryService.captureExternalFailure({
			channel: 'telegram',
			feature: 'price-command',
			external: {
				provider: 'twelve-data',
				attemptCount: 1,
				durationMs,
				lastErrorMessage: e.message,
				lastErrorCode: e.reason || e.code,
			},
			extra: {
				command: 'getPrice',
				symbol,
				exchange,
			},
		});

		let userMessage = `No se pudo obtener el precio de ${symbol} en Twelve Data.`;
		let isUserFriendly = false;
		if (e.reason === equityMarketDataService.REASONS.TIMEOUT) {
			userMessage = `No se pudo obtener el precio de ${symbol} (tiempo de espera agotado).`;
		} else if (e.reason === equityMarketDataService.REASONS.RATE_LIMITED) {
			userMessage = `No se pudo obtener el precio de ${symbol} (límite de peticiones alcanzado).`;
		} else if (e.reason === equityMarketDataService.REASONS.NO_DATA || e.reason === equityMarketDataService.REASONS.INVALID_RESPONSE) {
			userMessage = `No se encontró información de precio para el símbolo ${symbol}.`;
			isUserFriendly = true;
		}

		const error = new Error(userMessage);
		error.userMessage = userMessage;
		error.originalError = e;
		error.isUserFriendly = isUserFriendly;
		throw error;
	} finally {
		sentryService.endSpan(priceFetchSpan);
	}
}

const fetchSymbolPrice = async (context, options = {}) => {
	const text = (context && context.message && context.message.text) || '';
	const messageSplited = text.trim().split(/\s+/);
	const rawSymbol = messageSplited[1] || '';

	const classification = classifyPriceQuery(rawSymbol);
	if (!classification.valid) {
		const error = new Error('Por favor indica un símbolo. Ejemplo: /precio BTCUSDT o /precio NVDA');
		error.userMessage = 'Por favor indica un símbolo. Ejemplo: /precio BTCUSDT o /precio NVDA';
		error.isUserFriendly = true;
		throw error;
	}

	if (classification.assetClass === 'unsupported') {
		const error = new Error(classification.reason);
		error.userMessage = classification.reason;
		error.isUserFriendly = true;
		throw error;
	}

	if (classification.assetClass === 'equity') {
		return fetchEquityPrice(classification.symbol, classification.exchange, options);
	}

	return fetchCryptoPrice(classification.symbol, options);
};

module.exports = {
	classifyPriceQuery,
	fetchCryptoPrice,
	fetchEquityPrice,
	fetchSymbolPrice,
};
