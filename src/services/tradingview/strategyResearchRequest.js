'use strict';

class StrategyResearchRequestError extends Error {
	constructor(message, code = 'INVALID_REQUEST') {
		super(message);
		this.name = 'StrategyResearchRequestError';
		this.code = code;
	}
}

const SUPPORTED_STRATEGIES = new Set([
	'rsi',
	'bollinger',
	'macd',
	'ema_cross',
	'supertrend',
	'donchian',
]);

const SUPPORTED_INTERVALS = new Set(['1h', '1d']);

const INTERVAL_MAP = {
	'1H': '1h',
	'1D': '1d',
	'4H': '1h',
	'240': '1h',
	'60': '1h',
	'1440': '1d',
	'D': '1d',
};

function parseResearchSymbolIdentifier(rawSymbol, defaultExchange = 'BINANCE') {
	if (!rawSymbol || typeof rawSymbol !== 'string') {
		throw new StrategyResearchRequestError(
			'symbol is required and must be a string (e.g. "BINANCE:BTCUSDT" or "BTCUSDT")',
			'MISSING_SYMBOL',
		);
	}

	const trimmed = rawSymbol.trim().toUpperCase();
	if (!trimmed) {
		throw new StrategyResearchRequestError('symbol cannot be empty', 'EMPTY_SYMBOL');
	}

	if (trimmed.includes(':')) {
		const parts = trimmed.split(':');
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			throw new StrategyResearchRequestError(
				`Invalid symbol format: "${rawSymbol}". Expected EXCHANGE:SYMBOL (e.g. BINANCE:BTCUSDT)`,
				'INVALID_SYMBOL_FORMAT',
			);
		}
		return {
			raw: trimmed,
			exchange: parts[0],
			symbol: parts[1],
		};
	}

	return {
		raw: `${defaultExchange}:${trimmed}`,
		exchange: defaultExchange,
		symbol: trimmed,
	};
}

function normalizeResearchInterval(rawInterval) {
	if (rawInterval === undefined || rawInterval === null || rawInterval === '') {
		return '1h';
	}

	if (typeof rawInterval !== 'string') {
		throw new StrategyResearchRequestError('interval must be a string', 'INVALID_INTERVAL');
	}

	const upper = rawInterval.trim().toUpperCase();
	const mapped = INTERVAL_MAP[upper];
	if (mapped && SUPPORTED_INTERVALS.has(mapped)) {
		return mapped;
	}

	const lower = rawInterval.trim().toLowerCase();
	if (SUPPORTED_INTERVALS.has(lower)) {
		return lower;
	}

	throw new StrategyResearchRequestError(
		`Unsupported interval: "${rawInterval}". Upstream backtest engine accepts only 1h and 1d (4h is mapped to 1h).`,
		'UNSUPPORTED_INTERVAL',
	);
}

function parsePeriod(rawPeriod) {
	if (rawPeriod === undefined || rawPeriod === null || rawPeriod === '') {
		return '1y';
	}

	if (typeof rawPeriod !== 'string') {
		throw new StrategyResearchRequestError('period must be a string', 'INVALID_PERIOD');
	}

	const lower = rawPeriod.trim().toLowerCase();
	if (!/^\d+[dwmy]$/.test(lower)) {
		throw new StrategyResearchRequestError(
			`Invalid period format: "${rawPeriod}". Expected formats like 1m, 3m, 6m, 1y, 2y, 5y.`,
			'INVALID_PERIOD_FORMAT',
		);
	}

	return lower;
}

function parseOptionalNumber(value, name, { min = 0, max = Infinity, isInteger = false } = {}) {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}

	const num = Number(value);
	if (!Number.isFinite(num) || (isInteger && !Number.isInteger(num))) {
		throw new StrategyResearchRequestError(
			`${name} must be a valid ${isInteger ? 'integer' : 'number'}`,
			'INVALID_NUMBER',
		);
	}

	if (num < min || num > max) {
		throw new StrategyResearchRequestError(
			`${name} must be between ${min} and ${max}`,
			'OUT_OF_BOUNDS',
		);
	}

	return num;
}

function validateStrategyEnum(rawStrategy) {
	if (!rawStrategy || typeof rawStrategy !== 'string') {
		throw new StrategyResearchRequestError(
			`strategy is required and must be one of: ${Array.from(SUPPORTED_STRATEGIES).join(', ')}`,
			'MISSING_STRATEGY',
		);
	}

	const lower = rawStrategy.trim().toLowerCase();
	if (!SUPPORTED_STRATEGIES.has(lower)) {
		throw new StrategyResearchRequestError(
			`Unsupported strategy: "${rawStrategy}". Supported strategies: ${Array.from(SUPPORTED_STRATEGIES).join(', ')}`,
			'UNSUPPORTED_STRATEGY',
		);
	}

	return lower;
}

function parseCompareStrategiesRequest(req = {}) {
	const source = req.method === 'POST' ? (req.body || {}) : (req.query || {});
	const defaultExchange = (typeof source.exchange === 'string' && source.exchange.trim().toUpperCase()) || 'BINANCE';
	const symbolInfo = parseResearchSymbolIdentifier(source.symbol, defaultExchange);

	const interval = normalizeResearchInterval(source.interval);
	const period = parsePeriod(source.period);
	const initial_capital = parseOptionalNumber(source.initial_capital, 'initial_capital', { min: 1 });
	const commission_pct = parseOptionalNumber(source.commission_pct, 'commission_pct', { min: 0, max: 100 });
	const slippage_pct = parseOptionalNumber(source.slippage_pct, 'slippage_pct', { min: 0, max: 100 });

	return {
		symbol: symbolInfo.symbol,
		exchange: symbolInfo.exchange,
		rawSymbol: symbolInfo.raw,
		interval,
		period,
		...(initial_capital !== undefined ? { initial_capital } : {}),
		...(commission_pct !== undefined ? { commission_pct } : {}),
		...(slippage_pct !== undefined ? { slippage_pct } : {}),
	};
}

function parseWalkForwardRequest(req = {}) {
	const source = req.method === 'GET' ? (req.query || {}) : (req.body || {});
	const defaultExchange = (typeof source.exchange === 'string' && source.exchange.trim().toUpperCase()) || 'BINANCE';
	const symbolInfo = parseResearchSymbolIdentifier(source.symbol, defaultExchange);

	const strategy = validateStrategyEnum(source.strategy);
	const interval = normalizeResearchInterval(source.interval);
	const period = parsePeriod(source.period);
	const n_splits = parseOptionalNumber(source.n_splits ?? 5, 'n_splits', { min: 2, max: 10, isInteger: true });
	const train_ratio = parseOptionalNumber(source.train_ratio ?? 0.7, 'train_ratio', { min: 0.5, max: 0.9 });
	const initial_capital = parseOptionalNumber(source.initial_capital, 'initial_capital', { min: 1 });
	const commission_pct = parseOptionalNumber(source.commission_pct, 'commission_pct', { min: 0, max: 100 });
	const slippage_pct = parseOptionalNumber(source.slippage_pct, 'slippage_pct', { min: 0, max: 100 });

	let include_trade_log = false;
	if (source.include_trade_log !== undefined && source.include_trade_log !== null) {
		include_trade_log = source.include_trade_log === true || source.include_trade_log === 'true';
	}

	return {
		symbol: symbolInfo.symbol,
		exchange: symbolInfo.exchange,
		rawSymbol: symbolInfo.raw,
		strategy,
		interval,
		period,
		n_splits,
		train_ratio,
		include_trade_log,
		...(initial_capital !== undefined ? { initial_capital } : {}),
		...(commission_pct !== undefined ? { commission_pct } : {}),
		...(slippage_pct !== undefined ? { slippage_pct } : {}),
	};
}

function parseBacktestRequest(req = {}) {
	const source = req.method === 'GET' ? (req.query || {}) : (req.body || {});
	const defaultExchange = (typeof source.exchange === 'string' && source.exchange.trim().toUpperCase()) || 'BINANCE';
	const symbolInfo = parseResearchSymbolIdentifier(source.symbol, defaultExchange);

	const strategy = validateStrategyEnum(source.strategy);
	const interval = normalizeResearchInterval(source.interval);
	const period = parsePeriod(source.period);
	const initial_capital = parseOptionalNumber(source.initial_capital, 'initial_capital', { min: 1 });
	const commission_pct = parseOptionalNumber(source.commission_pct, 'commission_pct', { min: 0, max: 100 });
	const slippage_pct = parseOptionalNumber(source.slippage_pct, 'slippage_pct', { min: 0, max: 100 });

	let include_trade_log = false;
	if (source.include_trade_log !== undefined && source.include_trade_log !== null) {
		include_trade_log = source.include_trade_log === true || source.include_trade_log === 'true';
	}

	return {
		symbol: symbolInfo.symbol,
		exchange: symbolInfo.exchange,
		rawSymbol: symbolInfo.raw,
		strategy,
		interval,
		period,
		include_trade_log,
		...(initial_capital !== undefined ? { initial_capital } : {}),
		...(commission_pct !== undefined ? { commission_pct } : {}),
		...(slippage_pct !== undefined ? { slippage_pct } : {}),
	};
}

module.exports = {
	StrategyResearchRequestError,
	SUPPORTED_STRATEGIES,
	SUPPORTED_INTERVALS,
	parseResearchSymbolIdentifier,
	normalizeResearchInterval,
	parseCompareStrategiesRequest,
	parseWalkForwardRequest,
	parseBacktestRequest,
};
