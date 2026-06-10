const {
	normalizeTradingViewTimeframe,
	SUPPORTED_MCP_TIMEFRAMES,
} = require('./parseTradingViewSignal');

const SUPPORTED_TIMEFRAME_ALIASES = new Set([
	'5',
	'5M',
	'15',
	'15M',
	'60',
	'1H',
	'240',
	'4H',
	'1440',
	'D',
	'1D',
	'10080',
	'W',
	'1W',
	'43200',
	'M',
	'1M',
]);

class VolumeConfirmationRequestError extends Error {
	constructor(message, code = 'INVALID_REQUEST') {
		super(message);
		this.name = 'VolumeConfirmationRequestError';
		this.code = code;
	}
}

function parseVolumeConfirmationRequest(req = {}) {
	const body = getRequestBody(req);
	const { exchange, symbol } = parseSymbolIdentifier(body.symbol);
	const timeframe = parseTimeframe(body);

	return {
		exchange,
		symbol,
		rawSymbol: `${exchange}:${symbol}`,
		timeframe,
	};
}

function getRequestBody(req = {}) {
	if (!Object.prototype.hasOwnProperty.call(req, 'body') || req.body === undefined) {
		return {};
	}

	if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
		throw new VolumeConfirmationRequestError('request body must be a JSON object');
	}

	return req.body;
}

function parseSymbolIdentifier(rawSymbol) {
	if (typeof rawSymbol !== 'string' || !rawSymbol.trim()) {
		throw new VolumeConfirmationRequestError('symbol must be a non-empty string in EXCHANGE:SYMBOL format');
	}

	const trimmed = rawSymbol.trim().toUpperCase();
	const match = trimmed.match(/^(?<exchange>[A-Z0-9._-]+):(?<symbol>[A-Z0-9._-]{1,30})$/);

	if (!match || !match.groups) {
		throw new VolumeConfirmationRequestError('symbol must use EXCHANGE:SYMBOL format');
	}

	return {
		exchange: match.groups.exchange,
		symbol: match.groups.symbol,
	};
}

function parseTimeframe(body = {}) {
	if (
		Object.prototype.hasOwnProperty.call(body, 'timeframe')
		&& body.timeframe !== undefined
		&& typeof body.timeframe !== 'string'
	) {
		throw new VolumeConfirmationRequestError('timeframe must be a string');
	}

	const rawTimeframe = typeof body.timeframe === 'string' && body.timeframe.trim()
		? body.timeframe.trim()
		: (process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '1h');
	const normalizedToken = rawTimeframe.toUpperCase();

	if (!SUPPORTED_MCP_TIMEFRAMES.has(rawTimeframe) && !SUPPORTED_TIMEFRAME_ALIASES.has(normalizedToken)) {
		throw new VolumeConfirmationRequestError(`Unsupported timeframe: ${rawTimeframe}`);
	}

	return normalizeTradingViewTimeframe(rawTimeframe, '1h');
}

function getVolumeDecision(analysis = {}) {
	const ratio = Number(analysis.volume_analysis?.volume_ratio);

	if (!Number.isFinite(ratio)) {
		return {
			confirmed: null,
			decision: 'unknown',
			volumeRatio: null,
		};
	}

	return {
		confirmed: ratio >= 1.2,
		decision: ratio >= 1.2 ? 'confirm' : 'deny',
		volumeRatio: ratio,
	};
}

module.exports = {
	VolumeConfirmationRequestError,
	parseVolumeConfirmationRequest,
	getVolumeDecision,
};
