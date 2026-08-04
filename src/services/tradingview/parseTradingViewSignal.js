const SUPPORTED_MCP_TIMEFRAMES = new Set(['5m', '15m', '1h', '4h', '1D', '1W', '1M']);

const TIMEFRAME_MAP = {
	'5': '5m',
	'5M': '5m',
	'15': '15m',
	'15M': '15m',
	'60': '1h',
	'1H': '1h',
	'240': '4h',
	'4H': '4h',
	'1440': '1D',
	D: '1D',
	'1D': '1D',
	'10080': '1W',
	W: '1W',
	'1W': '1W',
	'43200': '1M',
	M: '1M',
	'1M': '1M',
};

const SIDE_MAP = {
	VENTA: 'SELL',
	SELL: 'SELL',
	COMPRA: 'BUY',
	BUY: 'BUY',
};

function normalizeTradingViewTimeframe(rawTimeframe, fallback = '1h') {
	if (!rawTimeframe || typeof rawTimeframe !== 'string') {
		return SUPPORTED_MCP_TIMEFRAMES.has(fallback) ? fallback : '1h';
	}

	const normalizedToken = rawTimeframe.trim().toUpperCase();
	const mapped = TIMEFRAME_MAP[normalizedToken];

	if (mapped && SUPPORTED_MCP_TIMEFRAMES.has(mapped)) {
		return mapped;
	}

	if (SUPPORTED_MCP_TIMEFRAMES.has(rawTimeframe.trim())) {
		return rawTimeframe.trim();
	}

	return SUPPORTED_MCP_TIMEFRAMES.has(fallback) ? fallback : '1h';
}

function normalizeSignalSide(rawSide) {
	if (!rawSide || typeof rawSide !== 'string') {
		return null;
	}

	const normalized = rawSide.trim().toUpperCase();
	return SIDE_MAP[normalized] || null;
}

function parseTradingViewSignal(text, options = {}) {
	if (!text || typeof text !== 'string') {
		return null;
	}

	const defaultTimeframe = options.defaultTimeframe || '1h';
	const cleaned = text.trim();

	const symbolMatch = cleaned.match(/(?:^|\s)(?:(?<exchange>[A-Z_]+):)?(?<symbol>[A-Z0-9._-]{3,20})\s*\(\s*(?<timeframe>[A-Za-z0-9]+)\s*\)/i);
	if (!symbolMatch || !symbolMatch.groups) {
		return null;
	}

	const sideMatch = cleaned.match(/\b(VENTA|SELL|COMPRA|BUY)\b/i);
	if (!sideMatch) {
		return null;
	}

	const symbol = symbolMatch.groups.symbol ? symbolMatch.groups.symbol.toUpperCase() : null;
	const exchange = symbolMatch.groups.exchange ? symbolMatch.groups.exchange.toUpperCase() : null;
	const rawTimeframe = symbolMatch.groups.timeframe ? symbolMatch.groups.timeframe.toUpperCase() : null;
	const side = normalizeSignalSide(sideMatch[1]);

	if (!symbol || !side || !rawTimeframe) {
		return null;
	}

	const timeframe = normalizeTradingViewTimeframe(rawTimeframe, defaultTimeframe);

	return {
		symbol,
		exchange,
		rawTimeframe,
		timeframe,
		side,
		rawText: cleaned,
	};
}

const STOCK_EXCHANGES = new Set(['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'SPCFD', 'CBOE']);
const NON_EQUITY_EXCHANGES = new Set(['FX_IDC', 'CME_MINI', 'CBOT_MINI']);
const CRYPTO_EXCHANGES = new Set(['BINANCE', 'BYBIT', 'COINBASE', 'OKX', 'KRAKEN', 'BITFINEX', 'KUCOIN']);
const CRYPTO_SUFFIXES = ['USDT', 'BUSD', 'USDC', 'BTC', 'ETH', 'SOL', 'PERP'];
const BARE_CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'PERP'];

function deriveAssetContext(text) {
	if (!text || typeof text !== 'string') {
		return null;
	}

	const parsed = parseTradingViewSignal(text);
	if (parsed && parsed.symbol) {
		const exchange = parsed.exchange || (parsed.symbol.endsWith('USDT') ? 'BINANCE' : null);
		let assetClass = exchange && NON_EQUITY_EXCHANGES.has(exchange) ? null : 'stock';
		if (exchange && CRYPTO_EXCHANGES.has(exchange)) {
			assetClass = 'crypto';
		} else if (exchange && STOCK_EXCHANGES.has(exchange)) {
			assetClass = 'stock';
		} else if (!NON_EQUITY_EXCHANGES.has(exchange)
			&& CRYPTO_SUFFIXES.some(s => parsed.symbol.endsWith(s))) {
			assetClass = 'crypto';
		}

		return {
			symbol: parsed.symbol,
			exchange,
			assetClass,
			side: parsed.side,
			timeframe: parsed.timeframe,
		};
	}

	const explicitExchangeMatch = text.match(/(?:^|\s)(?<exchange>[A-Z]+):(?<symbol>[A-Z0-9._-]{2,20})/i);
	if (explicitExchangeMatch && explicitExchangeMatch.groups && explicitExchangeMatch.groups.symbol) {
		const symbol = explicitExchangeMatch.groups.symbol.toUpperCase();
		const exchange = explicitExchangeMatch.groups.exchange.toUpperCase();

		let assetClass = 'stock';
		if (CRYPTO_EXCHANGES.has(exchange)) {
			assetClass = 'crypto';
		} else if (STOCK_EXCHANGES.has(exchange)) {
			assetClass = 'stock';
		} else if (CRYPTO_SUFFIXES.some(s => symbol.endsWith(s))) {
			assetClass = 'crypto';
		}

		return {
			symbol,
			exchange,
			assetClass,
		};
	}

	const cryptoSuffixPattern = new RegExp(
		`(?:^|\\s)(?<symbol>(?:[A-Z0-9._-]{2,20}(?:${CRYPTO_SUFFIXES.join('|')})|(?:${BARE_CRYPTO_SYMBOLS.join('|')})))(?=[^\\p{L}\\p{N}\\p{M}_]|$)`,
		'giu',
	);
	for (const cryptoSuffixMatch of text.matchAll(cryptoSuffixPattern)) {
		if (!cryptoSuffixMatch.groups || !cryptoSuffixMatch.groups.symbol) {
			continue;
		}
		const rawSymbol = cryptoSuffixMatch.groups.symbol;
		const symbol = rawSymbol.toUpperCase();
		const hasAmbiguousQuote = BARE_CRYPTO_SYMBOLS.some(suffix => symbol.endsWith(suffix));
		if (hasAmbiguousQuote && rawSymbol !== symbol) {
			continue;
		}
		return {
			symbol,
			exchange: null,
			assetClass: 'crypto',
		};
	}

	return null;
}

function deriveCleanSearchQuery(text) {
	if (!text || typeof text !== 'string') {
		return '';
	}

	const context = deriveAssetContext(text);
	if (context && context.symbol) {
		if (context.assetClass === 'stock') {
			return `${context.symbol} stock price news market analyst`;
		}
		if (context.assetClass === 'crypto') {
			return `${context.symbol} crypto price news market analyst`;
		}
		return `${context.symbol} market news analyst`;
	}

	const cleanText = text
		.replace(/\bBATS:(?<sym>[A-Z0-9._-]+)/gi, '$<sym> stock')
		.replace(/\bBINANCE:(?<sym>[A-Z0-9._-]+)/gi, '$<sym> crypto')
		.replace(/\b[A-Z]+:(?<sym>[A-Z0-9._-]+)/gi, '$<sym>');

	return cleanText.trim();
}

module.exports = {
	parseTradingViewSignal,
	normalizeTradingViewTimeframe,
	normalizeSignalSide,
	deriveAssetContext,
	deriveCleanSearchQuery,
	SUPPORTED_MCP_TIMEFRAMES,
};
