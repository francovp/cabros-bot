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

const STOCK_EXCHANGES = new Set(['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'SPCFD', 'CBOE', 'NYSE_ARCA', 'NYSE ARCA', 'ARCA']);
const NON_EQUITY_EXCHANGES = new Set(['FX_IDC', 'CME_MINI', 'CBOT_MINI']);
const CRYPTO_EXCHANGES = new Set(['BINANCE', 'BYBIT', 'COINBASE', 'OKX', 'KRAKEN', 'BITFINEX', 'KUCOIN']);
const CRYPTO_SUFFIXES = ['USDT', 'BUSD', 'USDC', 'BTC', 'ETH', 'SOL', 'PERP'];
const BARE_CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'PERP'];

/**
 * Venues the TradingView MCP server resolves, taken from its own advertised
 * support string plus the `combined_analysis` venue list. Anything outside this
 * set is resolved by the server to KUCOIN and every call answers
 * "No data found for <SYMBOL> on KUCOIN".
 */
const MCP_SUPPORTED_EXCHANGES = new Set([
	'KUCOIN', 'BINANCE', 'BYBIT', 'MEXC', 'OKX', 'KUCOINSPOT',
	'EGX', 'BIST', 'NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'PCX',
	'BURSA', 'HKEX', 'SSE', 'SZSE', 'TWSE', 'TPEX',
]);

/**
 * Explicit, probe-verified venue aliases for OUTBOUND MCP calls only.
 *
 * Every entry was confirmed live against the configured MCP host: the source
 * venue answers "No data found for <SYMBOL> on KUCOIN" while the target venue
 * returns a full indicator payload. This is a closed lookup table on purpose —
 * suffix-shape or fuzzy-regex inference would remap venues that already work
 * and could route an unverified symbol to a wrong market.
 */
const MCP_EXCHANGE_ALIASES = new Map([
	// BATS (Cboe BZX) is not a venue the server knows; its US large-cap names
	// resolve on NASDAQ, which the server does support.
	['BATS', 'NASDAQ'],
	// Same NASDAQ venue under the delayed-data suffix used by the screener.
	['NASDAQ_DLY', 'NASDAQ'],
]);

/**
 * Venues the server has no equivalent for. Aliasing them would mean inventing a
 * market, so they stay unmapped and degrade through the normal fail-open path.
 */
const MCP_UNSUPPORTED_EXCHANGES = new Map([
	['FX_IDC', 'FX/spot feed with no supported MCP venue'],
	['SPCFD', 'index/CFD feed with no supported MCP venue'],
]);

/**
 * Resolve the venue to send to the MCP server for an alert's exchange prefix.
 *
 * This never touches the exchange recorded on the parsed signal or on stored
 * alert metadata: it only answers "which venue should the outbound call use".
 *
 * @param {string} exchange Raw exchange prefix from the alert.
 * @returns {{mapped: boolean, mappedExchange: string|null, unsupported: boolean, reason: string|null}}
 */
function resolveMcpExchange(exchange) {
	if (typeof exchange !== 'string') {
		return { mapped: false, mappedExchange: null, unsupported: false, reason: null };
	}

	const normalized = exchange.trim().toUpperCase();
	if (!normalized) {
		return { mapped: false, mappedExchange: null, unsupported: false, reason: null };
	}

	if (MCP_EXCHANGE_ALIASES.has(normalized)) {
		return {
			mapped: true,
			mappedExchange: MCP_EXCHANGE_ALIASES.get(normalized),
			unsupported: false,
			reason: `TradingView MCP cannot resolve ${normalized}; using the verified equivalent venue`,
		};
	}

	if (MCP_UNSUPPORTED_EXCHANGES.has(normalized)) {
		return {
			mapped: false,
			mappedExchange: normalized,
			unsupported: true,
			reason: `TradingView MCP has no venue for ${normalized} (${MCP_UNSUPPORTED_EXCHANGES.get(normalized)})`,
		};
	}

	return {
		mapped: false,
		mappedExchange: normalized,
		unsupported: !MCP_SUPPORTED_EXCHANGES.has(normalized),
		reason: MCP_SUPPORTED_EXCHANGES.has(normalized)
			? null
			: `TradingView MCP venue ${normalized} is not in the server's advertised support list`,
	};
}

function deriveAssetContext(text) {
	if (!text || typeof text !== 'string') {
		return null;
	}

	const parsed = parseTradingViewSignal(text);
	if (parsed && parsed.symbol) {
		const exchange = parsed.exchange || (parsed.symbol.endsWith('USDT') ? 'BINANCE' : null);
		// A known non-equity venue (FX_IDC, CME_MINI, CBOT_MINI) stays NEUTRAL: it is
		// neither equity nor crypto, so it must not be labelled as either. This check
		// has to gate the crypto/stock branches below — CME_MINI is a member of
		// CRYPTO_EXCHANGES (it lists ETH contracts), so without the guard the crypto
		// branch overrode the neutrality and produced e.g. "ETH crypto price news".
		const isNonEquityVenue = Boolean(exchange && NON_EQUITY_EXCHANGES.has(exchange));
		let assetClass = isNonEquityVenue ? null : 'stock';
		if (!isNonEquityVenue) {
			if (exchange && CRYPTO_EXCHANGES.has(exchange)) {
				assetClass = 'crypto';
			} else if (exchange && STOCK_EXCHANGES.has(exchange)) {
				assetClass = 'stock';
			} else if (CRYPTO_SUFFIXES.some(s => parsed.symbol.endsWith(s))) {
				assetClass = 'crypto';
			}
		}

		return {
			symbol: parsed.symbol,
			exchange,
			assetClass,
			side: parsed.side,
			timeframe: parsed.timeframe,
		};
	}

	// Exchange identifiers may contain underscores (`FX_IDC`, `CME_MINI`, `CBOT_MINI`),
// matching the pattern `parseTradingViewSignal` already uses. Without the `_` this
// returned null for every underscore-exchange form, forcing callers to keep a
// separate regex pass for those inputs.
	const explicitExchangeMatch = text.match(/(?:^|\s)(?<exchange>[A-Z_]+):(?<symbol>[A-Z0-9._-]{2,20})/i);
	if (explicitExchangeMatch && explicitExchangeMatch.groups && explicitExchangeMatch.groups.symbol) {
		const symbol = explicitExchangeMatch.groups.symbol.toUpperCase();
		const exchange = explicitExchangeMatch.groups.exchange.toUpperCase();

	// Same neutrality rule as the parsed branch above: a known non-equity venue
	// is neither equity nor crypto, so a crypto suffix must not relabel it.
	let assetClass = NON_EQUITY_EXCHANGES.has(exchange) ? null : 'stock';
	if (!NON_EQUITY_EXCHANGES.has(exchange)) {
		if (CRYPTO_EXCHANGES.has(exchange)) {
			assetClass = 'crypto';
		} else if (STOCK_EXCHANGES.has(exchange)) {
			assetClass = 'stock';
		} else if (CRYPTO_SUFFIXES.some(s => symbol.endsWith(s))) {
			assetClass = 'crypto';
		}
	}

		return {
			symbol,
			exchange,
			assetClass,
		};
	}

	const cryptoPairPattern = new RegExp(
		`(?:^|\\s)(?<symbol>[A-Z0-9._-]{2,20}/(?:${CRYPTO_SUFFIXES.join('|')}))(?=[^\\p{L}\\p{N}\\p{M}_]|$)`,
		'giu',
	);
	for (const cryptoPairMatch of text.matchAll(cryptoPairPattern)) {
		if (!cryptoPairMatch.groups || !cryptoPairMatch.groups.symbol) {
			continue;
		}
		const rawSymbol = cryptoPairMatch.groups.symbol;
		const symbol = rawSymbol.toUpperCase();
		return {
			symbol,
			exchange: null,
			assetClass: 'crypto',
		};
	}

	const cryptoSuffixPattern = new RegExp(
		`(?:^|\\s)(?<symbol>(?:[A-Z0-9._-]{2,20}(?:${CRYPTO_SUFFIXES.join('|')})|(?:${BARE_CRYPTO_SYMBOLS.join('|')})))(?=[^\\p{L}\\p{N}\\p{M}_/]|$)`,
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
	resolveMcpExchange,
	SUPPORTED_MCP_TIMEFRAMES,
	TIMEFRAME_MAP,
};
