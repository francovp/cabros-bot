'use strict';

const { parseTradingViewSignal, normalizeTradingViewTimeframe } = require('./parseTradingViewSignal');
const { MainClient } = require('binance');
const equityMarketDataService = require('../storage/EquityMarketDataService');

let binanceClient = null;
function getBinanceClient() {
	if (!binanceClient) {
		binanceClient = new MainClient({ beautifyResponses: true });
	}
	return binanceClient;
}

// Map timeframes to standard risk percentages (stopLoss %, takeProfit %)
const TIMEFRAME_RISK_MAP = {
	'5m': { stop: 0.015, target: 0.030 },
	'15m': { stop: 0.015, target: 0.030 },
	'1h': { stop: 0.025, target: 0.050 },
	'4h': { stop: 0.025, target: 0.050 },
	'1D': { stop: 0.050, target: 0.100 },
	'1W': { stop: 0.050, target: 0.100 },
	'1M': { stop: 0.050, target: 0.100 },
};

const DEFAULT_RISK = { stop: 0.025, target: 0.050 };

function formatDerivedLevel(price) {
	if (!Number.isFinite(price) || price <= 0) return price;
	if (price >= 100) return Number(price.toFixed(2));
	if (price >= 1) return Number(price.toFixed(4));
	return Number(price.toPrecision(6));
}

function calculateFallbackRiskLevels(currentPrice, timeframe = '1h', side = 'BUY') {
	if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
		return null;
	}

	const normalizedTf = normalizeTradingViewTimeframe(timeframe, '1h');
	const riskConfig = TIMEFRAME_RISK_MAP[normalizedTf] || DEFAULT_RISK;
	const isShort = side === 'SELL';

	const invalidationLevel = isShort
		? currentPrice * (1 + riskConfig.stop)
		: currentPrice * (1 - riskConfig.stop);

	const targetLevel = isShort
		? currentPrice * (1 - riskConfig.target)
		: currentPrice * (1 + riskConfig.target);

	const risk = Math.abs(currentPrice - invalidationLevel);
	const reward = Math.abs(targetLevel - currentPrice);
	const riskRewardRatio = risk > 0 ? Number((reward / risk).toFixed(2)) : 2.0;

	return {
		current_price: formatDerivedLevel(currentPrice),
		invalidation_level: formatDerivedLevel(invalidationLevel),
		target_level: formatDerivedLevel(targetLevel),
		risk_reward_ratio: riskRewardRatio,
		setup_type: 'trend_continuation',
		levelsSource: 'derived-quote',
	};
}

const CRYPTO_QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];

async function fetchQuotePriceForSignal(parsedSignal, options = {}) {
	if (!parsedSignal || !parsedSignal.symbol) {
		return null;
	}

	const { symbol, exchange } = parsedSignal;
	const isCrypto = exchange === 'BINANCE'
		|| (!exchange && CRYPTO_QUOTE_SUFFIXES.some(suffix => symbol.endsWith(suffix)))
		|| (parsedSignal.assetClass === 'crypto');

	if (isCrypto) {
		try {
			const client = options.binanceClient || getBinanceClient();
			const data = await client.getAvgPrice({ symbol });
			const price = Number(data && data.price);
			if (Number.isFinite(price) && price > 0) {
				return price;
			}
		} catch (error) {
			console.warn(`[FallbackTradePlan] Failed to fetch crypto price for ${symbol} from Binance:`, error.message);
		}
		return null;
	}

	// Equity / Stock
	try {
		const eqService = options.equityMarketDataService || equityMarketDataService;
		const status = eqService.getStatus();
		if (status.configured && status.enabled) {
			const quote = await eqService.getQuote({
				symbol,
				exchange,
				timeoutMs: options.timeoutMs || 2500,
			});
			const price = Number(quote && quote.price);
			if (Number.isFinite(price) && price > 0) {
				return price;
			}
		}
	} catch (error) {
		console.warn(`[FallbackTradePlan] Failed to fetch equity quote for ${symbol} from Twelve Data:`, error.message);
	}

	return null;
}

async function deriveFallbackTradePlan(textOrSignal, options = {}) {
	if (!textOrSignal) {
		return null;
	}

	const parsedSignal = typeof textOrSignal === 'string'
		? parseTradingViewSignal(textOrSignal)
		: textOrSignal;

	if (!parsedSignal || !parsedSignal.symbol || !parsedSignal.side) {
		return null;
	}

	let currentPrice = (typeof options.currentPrice === 'number' && Number.isFinite(options.currentPrice) && options.currentPrice > 0)
		? options.currentPrice
		: null;

	if (currentPrice === null) {
		currentPrice = await fetchQuotePriceForSignal(parsedSignal, options);
	}

	if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
		return null;
	}

	const riskLevels = calculateFallbackRiskLevels(currentPrice, parsedSignal.timeframe, parsedSignal.side);
	if (!riskLevels) {
		return null;
	}

	return {
		...riskLevels,
		price_data: { current_price: riskLevels.current_price },
		symbol: parsedSignal.symbol,
		exchange: parsedSignal.exchange || (parsedSignal.symbol.endsWith('USDT') ? 'BINANCE' : 'UNKNOWN'),
		timeframe: parsedSignal.timeframe || '1h',
		side: parsedSignal.side,
	};
}

module.exports = {
	calculateFallbackRiskLevels,
	fetchQuotePriceForSignal,
	deriveFallbackTradePlan,
	TIMEFRAME_RISK_MAP,
	formatDerivedLevel,
};
