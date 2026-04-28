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

	const symbolMatch = cleaned.match(/(?:^|\s)(?:(?<exchange>[A-Z]+):)?(?<symbol>[A-Z0-9._-]{3,20})\s*\(\s*(?<timeframe>[A-Za-z0-9]+)\s*\)/i);
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

module.exports = {
	parseTradingViewSignal,
	normalizeTradingViewTimeframe,
	normalizeSignalSide,
	SUPPORTED_MCP_TIMEFRAMES,
};
