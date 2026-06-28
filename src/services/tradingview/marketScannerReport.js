const {
	normalizeTradingViewTimeframe,
	SUPPORTED_MCP_TIMEFRAMES,
} = require('./parseTradingViewSignal');
const { rankScannerItems } = require('./marketScannerScoring');

const SUPPORTED_SCAN_TYPES = new Set([
	'top_gainers',
	'top_losers',
	'bollinger_scan',
	'volume_breakout_scanner',
	'smart_volume_scanner',
]);

const DEFAULT_SCAN_LIMIT = 5;
const MAX_SCAN_LIMIT = 20;
const DEFAULT_EXCHANGE = 'BINANCE';

const SCAN_SECTIONS = {
	top_gainers: { emoji: '🟢', title: 'TOP GANADORES' },
	top_losers: { emoji: '🔴', title: 'TOP PERDEDORES' },
	volume_breakout_scanner: { emoji: '💥', title: 'BREAKOUT DE VOLUMEN' },
	smart_volume_scanner: { emoji: '🔎', title: 'VOLUMEN INTELIGENTE' },
	bollinger_scan: { emoji: '🔥', title: 'SQUEEZE BOLLINGER' },
};

const DEFAULT_SCANS = ['top_gainers', 'top_losers', 'volume_breakout_scanner'];

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

class MarketScannerRequestError extends Error {
	constructor(message, code = 'INVALID_REQUEST') {
		super(message);
		this.name = 'MarketScannerRequestError';
		this.code = code;
	}
}

function parseMarketScannerRequest(req = {}) {
	const body = getRequestBody(req);
	const exchange = parseExchange(body);
	const timeframe = parseTimeframe(body);
	const scans = parseScans(body);
	const limit = parseLimit(body);
	const bbwThreshold = parseBbwThreshold(body);
	const ranked = parseRanked(body);

	return { exchange, timeframe, scans, limit, bbwThreshold, ranked };
}

function getRequestBody(req = {}) {
	if (!Object.prototype.hasOwnProperty.call(req, 'body') || req.body === undefined) {
		return {};
	}

	if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
		throw new MarketScannerRequestError('request body must be a JSON object');
	}

	return req.body;
}

function parseExchange(body = {}) {
	if (
		Object.prototype.hasOwnProperty.call(body, 'exchange')
		&& body.exchange !== undefined
	) {
		if (typeof body.exchange !== 'string' || !body.exchange.trim()) {
			throw new MarketScannerRequestError('exchange must be a non-empty string');
		}

		return body.exchange.trim().toUpperCase();
	}

	return (process.env.MARKET_SCANNER_DEFAULT_EXCHANGE || DEFAULT_EXCHANGE).toUpperCase();
}

function parseTimeframe(body = {}) {
	if (
		Object.prototype.hasOwnProperty.call(body, 'timeframe')
		&& body.timeframe !== undefined
		&& typeof body.timeframe !== 'string'
	) {
		throw new MarketScannerRequestError('timeframe must be a string');
	}

	const rawTimeframe = typeof body.timeframe === 'string' && body.timeframe.trim()
		? body.timeframe.trim()
		: (process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '4h');
	const normalizedToken = rawTimeframe.toUpperCase();

	if (!SUPPORTED_MCP_TIMEFRAMES.has(rawTimeframe) && !SUPPORTED_TIMEFRAME_ALIASES.has(normalizedToken)) {
		throw new MarketScannerRequestError(`Unsupported timeframe: ${rawTimeframe}`);
	}

	return normalizeTradingViewTimeframe(rawTimeframe, '4h');
}

function parseScans(body = {}) {
	if (
		!Object.prototype.hasOwnProperty.call(body, 'scans')
		|| body.scans === undefined
		|| body.scans === null
	) {
		return [...DEFAULT_SCANS];
	}

	if (!Array.isArray(body.scans)) {
		throw new MarketScannerRequestError('scans must be an array of scan type strings');
	}

	const scans = body.scans
		.map((scan) => (typeof scan === 'string' ? scan.trim() : scan))
		.filter((scan) => scan !== '');

	if (scans.length === 0) {
		return [...DEFAULT_SCANS];
	}

	const invalid = scans.filter((scan) => typeof scan !== 'string' || !SUPPORTED_SCAN_TYPES.has(scan));
	if (invalid.length > 0) {
		throw new MarketScannerRequestError(
			`Unsupported scan types: ${invalid.join(', ')}. Supported: ${[...SUPPORTED_SCAN_TYPES].join(', ')}`,
		);
	}

	return scans;
}

function parseLimit(body = {}) {
	if (
		!Object.prototype.hasOwnProperty.call(body, 'limit')
		|| body.limit === undefined
		|| body.limit === null
	) {
		return DEFAULT_SCAN_LIMIT;
	}

	const limit = Number(body.limit);
	if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
		throw new MarketScannerRequestError('limit must be an integer');
	}

	return Math.max(1, Math.min(limit, MAX_SCAN_LIMIT));
}

function parseBbwThreshold(body = {}) {
	if (
		!Object.prototype.hasOwnProperty.call(body, 'bbw_threshold')
		|| body.bbw_threshold === undefined
		|| body.bbw_threshold === null
	) {
		return 0.05;
	}

	const threshold = Number(body.bbw_threshold);
	if (!Number.isFinite(threshold)) {
		throw new MarketScannerRequestError('bbw_threshold must be a number');
	}

	return threshold;
}

function parseRanked(body = {}) {
	if (
		!Object.prototype.hasOwnProperty.call(body, 'ranked')
		|| body.ranked === undefined
		|| body.ranked === null
	) {
		return false;
	}

	if (body.ranked === true || body.ranked === 'true') {
		return true;
	}

	if (body.ranked === false || body.ranked === 'false') {
		return false;
	}

	throw new MarketScannerRequestError('ranked must be a boolean');
}

function buildMarketScannerReport(scanResults = [], options = {}) {
	const now = options.now || new Date();
	const exchange = options.exchange || DEFAULT_EXCHANGE;
	const timeframe = options.timeframe || '4h';
	const ranked = options.ranked === true;

	const lines = [
		`📡 *SCANNER DE MERCADO — ${formatReportDate(now)}*`,
		`_${exchange} · ${timeframe}_`,
	];

	scanResults.forEach((scanResult) => {
		const section = SCAN_SECTIONS[scanResult.scan];
		if (!section) {
			return;
		}

		lines.push('');
		lines.push(`*${section.emoji} ${section.title}*`);

		if (scanResult.error) {
			lines.push(`⚠️ Error: ${scanResult.error}`);
			return;
		}

		let itemsToRender = scanResult.items || [];
		if (scanResult.scan === 'top_gainers') {
			itemsToRender = itemsToRender.filter((item) => typeof item.changePercent === 'number' && item.changePercent > 0);
		} else if (scanResult.scan === 'top_losers') {
			itemsToRender = itemsToRender.map((item) => {
				if (typeof item.changePercent === 'number') {
					return { ...item, changePercent: -Math.abs(item.changePercent) };
				}
				return item;
			});
			itemsToRender = itemsToRender.filter((item) => typeof item.changePercent === 'number' && item.changePercent < 0);
		}

		if (ranked) {
			itemsToRender = rankScannerItems(itemsToRender, scanResult.scan);
		}

		if (itemsToRender.length === 0) {
			lines.push('No hay.');
			return;
		}

		itemsToRender.forEach((item, index) => {
			lines.push(formatScanItem(item, index + 1, scanResult.scan, ranked));
		});
	});

	return lines.join('\n');
}

function formatScanItem(item, rank, scanType, ranked = false) {
	const symbol = stripExchange(item.symbol);
	const price = formatCurrency(numberOrNull(item.indicators?.close ?? null));
	const change = formatPercent(numberOrNull(item.changePercent ?? null));

	let suffix = '';

	if (scanType === 'top_gainers' || scanType === 'top_losers') {
		const rsi = numberOrNull(item.indicators?.RSI ?? null);
		suffix = ` | RSI ${formatNumber(rsi, 1)}`;
	} else if (scanType === 'volume_breakout_scanner' || scanType === 'smart_volume_scanner') {
		const volRatio = numberOrNull(item.volume_ratio ?? null);
		const breakoutEmoji = getBreakoutEmoji(item.breakout_type);
		suffix = ` | Vol ${formatNumber(volRatio, 1)}x ${breakoutEmoji}`;

		if (scanType === 'smart_volume_scanner' && item.trading_recommendation) {
			suffix += ` ${stripEmoji(item.trading_recommendation)}`;
		}
	} else if (scanType === 'bollinger_scan') {
		const bbw = numberOrNull(item.bbw ?? null);
		suffix = ` | BBW ${formatNumber(bbw, 2)}`;
	}

	if (ranked && item._score !== undefined) {
		suffix += ` | 🏆 ${item._score}/100`;
		if (item._scoreReason) {
			suffix += ` ${item._scoreReason}`;
		}
	}

	return `${rank}. ${symbol} ${price} (${change})${suffix}`;
}

function getBreakoutEmoji(breakoutType) {
	if (typeof breakoutType !== 'string') {
		return '';
	}

	const normalized = breakoutType.trim().toLowerCase();
	if (normalized === 'bullish') {
		return '📈';
	}

	if (normalized === 'bearish') {
		return '📉';
	}

	return '';
}

function stripEmoji(text) {
	if (typeof text !== 'string') {
		return '';
	}

	return text.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
}

function stripExchange(symbol) {
	if (typeof symbol !== 'string') {
		return 'UNKNOWN';
	}

	const parts = symbol.split(':');
	return parts[parts.length - 1] || 'UNKNOWN';
}

function formatReportDate(date) {
	const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date);
	const day = String(date.getDate()).padStart(2, '0');
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const year = date.getFullYear();
	return `${weekday} ${day}/${month}/${year}`;
}

function formatCurrency(value) {
	if (value === null) {
		return 'N/A';
	}

	const decimals = Math.abs(value) >= 1 ? 2 : 6;
	return `$${value.toLocaleString('en-US', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	})}`;
}

function formatPercent(value) {
	if (value === null) {
		return 'N/A';
	}

	const sign = value > 0 ? '+' : '';
	return `${sign}${value.toFixed(1)}%`;
}

function formatNumber(value, decimals) {
	if (value === null) {
		return 'N/A';
	}

	return value.toFixed(decimals);
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

module.exports = {
	MarketScannerRequestError,
	parseMarketScannerRequest,
	buildMarketScannerReport,
	SUPPORTED_SCAN_TYPES,
};
