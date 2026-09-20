'use strict';

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const PROVIDER_NAME = 'twelve-data';
const DEFAULT_BASE_URL = 'https://api.twelvedata.com';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_RPM = 8;
const SUPPORTED_EXCHANGES = Object.freeze(['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'FX_IDC', 'SPCFD']);
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

const TRANSIENT_REASONS = Object.freeze(new Set([
	REASONS.RATE_LIMITED,
	REASONS.TIMEOUT,
	REASONS.UNAVAILABLE,
	'binance_unavailable',
	'market_data_unavailable',
]));

const STRUCTURAL_REASONS = Object.freeze(new Set([
	REASONS.NOT_CONFIGURED,
	REASONS.MISCONFIGURED,
	REASONS.INVALID_RESPONSE,
	REASONS.NO_DATA,
	'unparseable_symbol',
	'unsupported_exchange',
	'missing_barrier',
	'binance_invalid_symbol',
]));

function isTransientReason(reason) {
	return typeof reason === 'string' && TRANSIENT_REASONS.has(reason);
}

function isStructuralReason(reason) {
	return typeof reason === 'string' && STRUCTURAL_REASONS.has(reason);
}

class EquityMarketDataError extends Error {
	constructor(reason, options = {}) {
		super(reason);
		this.name = 'EquityMarketDataError';
		this.reason = reason;
		if (typeof options.status === 'number') {
			this.status = options.status;
		}
		if (typeof options.retryAfterSeconds === 'number' && Number.isFinite(options.retryAfterSeconds)) {
			this.retryAfterSeconds = options.retryAfterSeconds;
		}
		if (options.cause) {
			this.cause = options.cause;
		}
	}
}

let pacingQueue = Promise.resolve();
let lastScheduledAtMs = 0;
let cooldownUntilMs = 0;

function _resetPacerForTesting() {
	pacingQueue = Promise.resolve();
	lastScheduledAtMs = 0;
	cooldownUntilMs = 0;
}

function parseRpm(value) {
	if (value !== undefined && value !== null && value !== '') {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed) && parsed >= 0) {
			return Math.min(parsed, 1200);
		}
	}
	return process.env.NODE_ENV === 'test' ? 0 : DEFAULT_RPM;
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
	let normalized = exchange.trim().toUpperCase();
	if (normalized.endsWith('_DLY')) {
		normalized = normalized.slice(0, -4);
	}
	if (normalized === 'NYSE_ARCA' || normalized === 'ARCA') {
		return 'NYSE ARCA';
	}
	if (normalized === 'FX' || normalized === 'FOREX') {
		return 'FX_IDC';
	}
	return normalized;
}

function normalizeSymbol(symbol) {
	if (!symbol || typeof symbol !== 'string') {
		return null;
	}
	let cleaned = symbol.trim().toUpperCase();
	if (cleaned.endsWith(')')) {
		const openParenIndex = cleaned.lastIndexOf('(');
		if (openParenIndex > 0 && /^[A-Za-z0-9]+$/.test(cleaned.slice(openParenIndex + 1, -1))) {
			cleaned = cleaned.slice(0, openParenIndex).trim();
		}
	}
	if (/^[A-Z]{6}$/.test(cleaned) && !cleaned.includes('/')) {
		cleaned = `${cleaned.slice(0, 3)}/${cleaned.slice(3)}`;
	}
	return cleaned;
}

function resolveQueryExchange(exchange) {
	const normalized = normalizeExchange(exchange);
	if (!normalized || normalized === 'UNKNOWN' || normalized === 'FX_IDC' || normalized === 'SPCFD') {
		return undefined;
	}
	return normalized;
}

function parseRetryAfter(headerValue) {
	if (!headerValue || typeof headerValue !== 'string') return null;
	const trimmed = headerValue.trim();
	const asSeconds = Number(trimmed);
	if (Number.isFinite(asSeconds) && asSeconds >= 0) {
		return Math.ceil(asSeconds);
	}
	const asDate = Date.parse(trimmed);
	if (!Number.isNaN(asDate)) {
		const diffSeconds = Math.ceil((asDate - Date.now()) / 1000);
		return Math.max(0, diffSeconds);
	}
	return null;
}

async function waitForPacing(maxWaitMs) {
	const config = getConfig();
	const rpm = config.rpm;

	const reservation = pacingQueue.then(async () => {
		const now = Date.now();
		if (rpm <= 0 && cooldownUntilMs <= now) {
			lastScheduledAtMs = now;
			return;
		}

		const minIntervalMs = rpm > 0 ? Math.ceil(60000 / rpm) : 0;
		const nextAllowedTime = Math.max(lastScheduledAtMs + minIntervalMs, cooldownUntilMs, now);
		lastScheduledAtMs = nextAllowedTime;
		const delayMs = nextAllowedTime - now;

		if (delayMs > 0) {
			if (maxWaitMs !== undefined && delayMs >= maxWaitMs) {
				throw new EquityMarketDataError(REASONS.TIMEOUT, { status: 408 });
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	});

	pacingQueue = reservation.catch(() => {});
	await reservation;
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

	const rc = getRuntimeConfig?.();
	const rcRpm = rc?.EQUITY_MARKET_DATA_RPM;
	const effectiveRpm = rcRpm !== undefined ? rcRpm : parseRpm(process.env.EQUITY_MARKET_DATA_RPM || process.env.TWELVE_DATA_RPM);

	return {
		enabled,
		provider,
		apiKey,
		configured: enabled && provider === PROVIDER_NAME && apiKey.length > 0,
		timeoutMs: parseTimeout(process.env.EQUITY_MARKET_DATA_TIMEOUT_MS),
		rpm: effectiveRpm,
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
		ready: status === 'ready',
		status,
		supportedExchanges: [...SUPPORTED_EXCHANGES],
		timeoutMs: config.timeoutMs,
		rpm: config.rpm,
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

function buildUrl(pathname, params = {}) {
	const configuredBaseUrl = process.env.TWELVE_DATA_BASE_URL || DEFAULT_BASE_URL;
	const baseUrl = configuredBaseUrl.endsWith('/') ? configuredBaseUrl : `${configuredBaseUrl}/`;
	const url = new URL(pathname.replace(/^\//, ''), baseUrl);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== '') {
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
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

	const totalTimeoutMs = timeoutOverride === undefined ? config.timeoutMs : parseTimeout(timeoutOverride);
	const startMs = Date.now();

	await waitForPacing(totalTimeoutMs);

	const elapsedMs = Date.now() - startMs;
	const remainingFetchTimeoutMs = Math.max(1, totalTimeoutMs - elapsedMs);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), remainingFetchTimeoutMs);

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

		if (response.status === 429) {
			const rawHeader = response.headers && typeof response.headers.get === 'function'
				? response.headers.get('retry-after')
				: null;
			const retryAfterSeconds = parseRetryAfter(rawHeader);
			if (retryAfterSeconds && retryAfterSeconds > 0) {
				cooldownUntilMs = Date.now() + (retryAfterSeconds * 1000);
				throw new EquityMarketDataError(REASONS.RATE_LIMITED, { retryAfterSeconds, status: response.status });
			}
			cooldownUntilMs = Date.now() + (config.rpm > 0 ? Math.ceil(60000 / config.rpm) : 7500);
			throw new EquityMarketDataError(REASONS.RATE_LIMITED, { status: response.status });
		}

		if (!response.ok || !body || body.status === 'error') {
			const reason = classifyResponseError(response.status, body);
			if (reason === REASONS.RATE_LIMITED) {
				cooldownUntilMs = Date.now() + (config.rpm > 0 ? Math.ceil(60000 / config.rpm) : 7500);
			}
			throw new EquityMarketDataError(reason, { status: response.status });
		}

		return body;
	} catch (error) {
		if (error instanceof EquityMarketDataError) {
			throw error;
		}
		if (error && error.name === 'AbortError') {
			throw new EquityMarketDataError(REASONS.TIMEOUT);
		}
		throw new EquityMarketDataError(REASONS.UNAVAILABLE, { cause: error });
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

async function getQuote({ symbol, exchange, timeoutMs } = {}) {
	const normSymbol = normalizeSymbol(symbol);
	const queryExchange = resolveQueryExchange(exchange);
	const body = await requestJson('/quote', { symbol: normSymbol, exchange: queryExchange }, timeoutMs);
	const price = parsePrice(body.close ?? body.price);
	if (price === null) {
		throw new EquityMarketDataError(REASONS.INVALID_RESPONSE);
	}
	const change = body.change !== undefined && body.change !== null && body.change !== '' ? Number(body.change) : null;
	const percentChange = body.percent_change !== undefined && body.percent_change !== null && body.percent_change !== '' ? Number(body.percent_change) : null;

	return {
		symbol: body.symbol || normSymbol,
		name: body.name || null,
		exchange: body.exchange || queryExchange || null,
		currency: body.currency || 'USD',
		price,
		change: Number.isFinite(change) ? change : null,
		percentChange: Number.isFinite(percentChange) ? percentChange : null,
		isMarketOpen: typeof body.is_market_open === 'boolean' ? body.is_market_open : null,
		datetime: body.datetime || null,
	};
}

async function getEntryPrice({ symbol, exchange, timeoutMs } = {}) {
	const quote = await getQuote({ symbol, exchange, timeoutMs });
	return quote.price;
}

async function getHistoricalBars({ symbol, exchange, interval, startTime, endTime, timeoutMs } = {}) {
	const providerInterval = INTERVALS[interval];
	if (!providerInterval || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
		throw new EquityMarketDataError(REASONS.INVALID_RESPONSE);
	}

	const normSymbol = normalizeSymbol(symbol);
	const queryExchange = resolveQueryExchange(exchange);
	const body = await requestJson('/time_series', {
		symbol: normSymbol,
		exchange: queryExchange,
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
	TRANSIENT_REASONS,
	STRUCTURAL_REASONS,
	isTransientReason,
	isStructuralReason,
	EquityMarketDataError,
	getStatus,
	isSupportedExchange,
	getProviderName,
	getQuote,
	getEntryPrice,
	getHistoricalBars,
	parseTimestamp,
	normalizeExchange,
	normalizeSymbol,
	resolveQueryExchange,
	_resetPacerForTesting,
};
