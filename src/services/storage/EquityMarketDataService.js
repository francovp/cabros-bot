'use strict';

const PROVIDER_NAME = 'twelve-data';
const DEFAULT_BASE_URL = 'https://api.twelvedata.com';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const SUPPORTED_EXCHANGES = Object.freeze(['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA']);
const INTERVALS = Object.freeze({
	'5m': '5min',
	'15m': '15min',
	'1h': '1h',
	'4h': '4h',
	'1D': '1day',
	'1W': '1week',
});

const REASONS = Object.freeze({
	NOT_CONFIGURED: 'twelve_data_not_configured',
	TIMEOUT: 'twelve_data_timeout',
	RATE_LIMITED: 'twelve_data_rate_limited',
	MISCONFIGURED: 'twelve_data_misconfigured',
	INVALID_RESPONSE: 'twelve_data_invalid_response',
	NO_DATA: 'twelve_data_no_data',
	UNAVAILABLE: 'twelve_data_unavailable',
});

class EquityMarketDataError extends Error {
	constructor(reason) {
		super(reason);
		this.name = 'EquityMarketDataError';
		this.reason = reason;
	}
}

function parseTimeout(value) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.min(parsed, MAX_TIMEOUT_MS);
}

function normalizeExchange(exchange) {
	if (!exchange || typeof exchange !== 'string') {
		return null;
	}
	const normalized = exchange.trim().toUpperCase();
	if (normalized === 'NYSE_ARCA') {
		return 'NYSE ARCA';
	}
	return normalized;
}

function getConfig() {
	const rawProvider = typeof process.env.EQUITY_MARKET_DATA_PROVIDER === 'string'
		? process.env.EQUITY_MARKET_DATA_PROVIDER.trim().toLowerCase()
		: '';
	const provider = rawProvider === 'twelvedata' || rawProvider === 'twelve_data'
		? PROVIDER_NAME
		: rawProvider;
	const enabled = process.env.ENABLE_EQUITY_MARKET_DATA === 'true';
	const apiKey = typeof process.env.TWELVE_DATA_API_KEY === 'string'
		? process.env.TWELVE_DATA_API_KEY.trim()
		: '';

	return {
		enabled,
		provider,
		apiKey,
		configured: enabled && provider === PROVIDER_NAME && apiKey.length > 0,
		timeoutMs: parseTimeout(process.env.EQUITY_MARKET_DATA_TIMEOUT_MS),
	};
}

function getStatus() {
	const config = getConfig();
	const status = !config.enabled
		? 'disabled'
		: config.configured ? 'ready' : 'misconfigured';

	return {
		provider: config.provider || null,
		enabled: config.enabled,
		configured: config.configured,
		ready: config.enabled && config.configured,
		status,
		supportedExchanges: [...SUPPORTED_EXCHANGES],
		timeoutMs: config.timeoutMs,
	};
}

function isSupportedExchange(exchange) {
	const normalized = normalizeExchange(exchange);
	return normalized ? SUPPORTED_EXCHANGES.includes(normalized) : false;
}

function getProviderName(exchange, assetClass) {
	const normalizedExchange = normalizeExchange(exchange) || String(exchange || '').trim().toUpperCase();
	const normalizedAssetClass = String(assetClass || '').trim().toLowerCase();
	const isClassifiedBareStock = normalizedExchange === 'UNKNOWN' && normalizedAssetClass === 'stock';
	return (isSupportedExchange(normalizedExchange) || isClassifiedBareStock) && getConfig().configured
		? PROVIDER_NAME
		: null;
}

function buildUrl(path, params) {
	const configuredBaseUrl = process.env.TWELVE_DATA_BASE_URL || DEFAULT_BASE_URL;
	const baseUrl = configuredBaseUrl.endsWith('/') ? configuredBaseUrl : `${configuredBaseUrl}/`;
	const url = new URL(path.replace(/^\//, ''), baseUrl);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== '') {
			url.searchParams.set(key, String(value));
		}
	}

	return url;
}

function classifyResponseError(statusCode, body) {
	const providerCode = Number(body && body.code);
	if (statusCode === 429 || providerCode === 429) {
		return REASONS.RATE_LIMITED;
	}
	if (statusCode === 401 || statusCode === 403 || providerCode === 401 || providerCode === 403) {
		return REASONS.MISCONFIGURED;
	}
	if (statusCode === 400 || statusCode === 404 || providerCode === 400 || providerCode === 404) {
		return REASONS.INVALID_RESPONSE;
	}
	return REASONS.UNAVAILABLE;
}

async function requestJson(path, params, timeoutOverride) {
	const config = getConfig();
	if (!config.configured) {
		throw new EquityMarketDataError(REASONS.NOT_CONFIGURED);
	}

	const controller = new AbortController();
	const timeoutMs = timeoutOverride === undefined ? config.timeoutMs : parseTimeout(timeoutOverride);
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(buildUrl(path, params), {
			headers: {
				Accept: 'application/json',
				Authorization: `apikey ${config.apiKey}`,
			},
			signal: controller.signal,
		});

		let body;
		try {
			body = await response.json();
		} catch {
			throw new EquityMarketDataError(REASONS.INVALID_RESPONSE);
		}

		if (!response.ok || !body || body.status === 'error') {
			throw new EquityMarketDataError(classifyResponseError(response.status, body));
		}

		return body;
	} catch (error) {
		if (error instanceof EquityMarketDataError) {
			throw error;
		}
		if (error && error.name === 'AbortError') {
			throw new EquityMarketDataError(REASONS.TIMEOUT);
		}
		throw new EquityMarketDataError(REASONS.UNAVAILABLE);
	} finally {
		clearTimeout(timeoutId);
	}
}

function parsePrice(value) {
	const price = Number(value);
	return Number.isFinite(price) && price > 0 ? price : null;
}

function parseTimestamp(value) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value < 1e12 ? value * 1000 : value;
	}

	if (typeof value !== 'string' || value.trim() === '') {
		return null;
	}

	const text = value.trim();
	const normalized = text.includes('T') ? text : text.replace(' ', 'T');
	const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
	const timestamp = date.getTime();
	return Number.isFinite(timestamp) ? timestamp : null;
}

async function getEntryPrice({ symbol, exchange, timeoutMs } = {}) {
	const normalizedExchange = normalizeExchange(exchange) || exchange;
	const body = await requestJson('/quote', { symbol, exchange: normalizedExchange }, timeoutMs);
	const price = parsePrice(body.close ?? body.price);
	if (price === null) {
		throw new EquityMarketDataError(REASONS.INVALID_RESPONSE);
	}
	return price;
}

async function getHistoricalBars({ symbol, exchange, interval, startTime, endTime, timeoutMs } = {}) {
	const providerInterval = INTERVALS[interval];
	if (!providerInterval || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
		throw new EquityMarketDataError(REASONS.INVALID_RESPONSE);
	}

	const normalizedExchange = normalizeExchange(exchange) || exchange;
	const body = await requestJson('/time_series', {
		symbol,
		exchange: normalizedExchange,
		interval: providerInterval,
		start_date: new Date(startTime).toISOString(),
		end_date: new Date(endTime).toISOString(),
		outputsize: 5000,
		timezone: 'UTC',
		adjust: 'none',
		prepost: 'false',
	}, timeoutMs);

	if (!Array.isArray(body.values)) {
		throw new EquityMarketDataError(REASONS.INVALID_RESPONSE);
	}

	const bars = body.values.map((value) => {
		const timestamp = parseTimestamp(value && value.datetime);
		const open = parsePrice(value && value.open);
		const high = parsePrice(value && value.high);
		const low = parsePrice(value && value.low);
		const close = parsePrice(value && value.close);
		if (timestamp === null || open === null || high === null || low === null || close === null) {
			return null;
		}
		return [timestamp, String(open), String(high), String(low), String(close)];
	}).filter((bar) => bar && bar[0] >= startTime && bar[0] <= endTime);

	if (bars.length === 0) {
		throw new EquityMarketDataError(REASONS.NO_DATA);
	}

	return bars.sort((left, right) => left[0] - right[0]);
}

module.exports = {
	PROVIDER_NAME,
	SUPPORTED_EXCHANGES,
	REASONS,
	EquityMarketDataError,
	getStatus,
	isSupportedExchange,
	getProviderName,
	getEntryPrice,
	getHistoricalBars,
	parseTimestamp,
};
