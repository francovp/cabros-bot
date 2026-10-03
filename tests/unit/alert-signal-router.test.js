'use strict';

jest.mock('binance', () => ({ MainClient: jest.fn() }));

const mockPlaceOrder = jest.fn();

jest.mock('../../src/services/trading/BinanceOrderService', () => ({
	binanceOrderService: { placeOrder: (...args) => mockPlaceOrder(...args) },
	getConfig: () => mockConfig,
}));

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
	captureExternalFailure: jest.fn(),
	captureRuntimeMessage: jest.fn(),
}));

const {
	routeAlertToOrder,
	deriveOrderIntent,
	buildAutoTradeKey,
	getAutoTradeConfig,
	__resetForTesting,
} = require('../../src/services/trading/AlertSignalRouter');

const TRADING_ENV_KEYS = [
	'ENABLE_AUTO_TRADE',
	'AUTO_TRADE_DRY_RUN',
	'AUTO_TRADE_MAX_NOTIONAL',
	'AUTO_TRADE_MIN_ABS_SENTIMENT',
	'AUTO_TRADE_COOLDOWN_BARS',
	'ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION',
	'ENABLE_BINANCE_TRADING',
	'BINANCE_API_KEY',
	'BINANCE_API_SECRET',
	'BINANCE_TRADING_ALLOWED_SYMBOLS',
	'BINANCE_TRADING_MAX_NOTIONAL',
	'BINANCE_TRADING_ENV',
];

let originalEnv;
let mockConfig;

beforeEach(() => {
	originalEnv = {};
	for (const key of TRADING_ENV_KEYS) originalEnv[key] = process.env[key];
	for (const key of TRADING_ENV_KEYS) delete process.env[key];

	mockConfig = {
		enabled: true,
		configured: true,
		environment: 'testnet',
		allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
		maxNotional: 1000,
	};

	mockPlaceOrder.mockReset();
	mockPlaceOrder.mockResolvedValue({
		success: true,
		dryRun: true,
		environment: 'testnet',
		order: { orderId: 111, symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED' },
	});
	__resetForTesting();
});

afterEach(() => {
	for (const key of TRADING_ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

function enableLiveAutoTrade() {
	process.env.ENABLE_AUTO_TRADE = 'true';
	process.env.AUTO_TRADE_DRY_RUN = 'false';
	process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
}

function buyAlert(overrides = {}) {
	return {
		text: 'BINANCE:BTCUSDT 1h COMPRA',
		enriched: {
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			current_price: 50000,
			...(overrides.enriched || {}),
		},
	};
}

function buyParsed(overrides = {}) {
	return {
		exchange: 'BINANCE',
		symbol: 'BTCUSDT',
		timeframe: '1h',
		side: 'BUY',
		...(overrides || {}),
	};
}

describe('getAutoTradeConfig', () => {
	it('is disabled with dry-run safe defaults when nothing is configured', () => {
		const config = getAutoTradeConfig();
		expect(config.enabled).toBe(false);
		expect(config.dryRun).toBe(true);
		expect(config.maxNotional).toBe(100);
		expect(config.minAbsSentiment).toBe(0.3);
		expect(config.cooldownBars).toBe(1);
	});

	it('falls back to defaults for malformed numeric values', () => {
		process.env.AUTO_TRADE_MAX_NOTIONAL = 'not-a-number';
		process.env.AUTO_TRADE_COOLDOWN_BARS = '-3';
		process.env.AUTO_TRADE_MIN_ABS_SENTIMENT = '5';
		const config = getAutoTradeConfig();
		expect(config.maxNotional).toBe(100);
		expect(config.cooldownBars).toBe(1);
		expect(config.minAbsSentiment).toBe(0.3);
	});

	it('clamps cooldown bars to the documented 1-10 range', () => {
		process.env.AUTO_TRADE_COOLDOWN_BARS = '99';
		expect(getAutoTradeConfig().cooldownBars).toBe(10);
	});
});

describe('buildAutoTradeKey', () => {
	it('namespaces the key and preserves side so opposite flips are independent', () => {
		const buy = buildAutoTradeKey({ exchange: 'binance', symbol: 'btcusdt', timeframe: '1H', side: 'buy' });
		const sell = buildAutoTradeKey({ exchange: 'binance', symbol: 'btcusdt', timeframe: '1H', side: 'SELL' });
		expect(buy).toBe('autotrade|BINANCE|BTCUSDT|1h|BUY');
		expect(sell).toBe('autotrade|BINANCE|BTCUSDT|1h|SELL');
		expect(buy).not.toBe(sell);
	});

	it('returns null without a symbol or side', () => {
		expect(buildAutoTradeKey({ symbol: null, side: 'BUY' })).toBeNull();
		expect(buildAutoTradeKey({ symbol: 'BTCUSDT', side: null })).toBeNull();
	});
});

describe('deriveOrderIntent', () => {
	const config = { dryRun: true, maxNotional: 100, minAbsSentiment: 0.3, cooldownBars: 1, requireRepeatSuppression: false };

	it('derives a bounded MARKET BUY from an enriched bullish alert', () => {
		const intent = deriveOrderIntent({ alert: buyAlert(), parsed: buyParsed(), config });
		expect(intent.skip).toBeUndefined();
		expect(intent.side).toBe('BUY');
		expect(intent.order).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: 100, dryRun: true });
	});

	it('never exceeds the Binance trading notional cap', () => {
		mockConfig.maxNotional = 25;
		const intent = deriveOrderIntent({ alert: buyAlert(), parsed: buyParsed(), config: { ...config, maxNotional: 5000 } });
		expect(intent.order.quoteOrderQty).toBe(25);
	});

	it('skips alerts below the sentiment threshold', () => {
		const intent = deriveOrderIntent({
			alert: buyAlert({ enriched: { sentiment_score: 0.1 } }),
			parsed: buyParsed(),
			config,
		});
		expect(intent.skip).toBe('SENTIMENT_BELOW_THRESHOLD');
	});

	it('refuses to guess a side when the signal was not parsed', () => {
		const intent = deriveOrderIntent({ alert: buyAlert(), parsed: { symbol: 'BTCUSDT' }, config });
		expect(intent.skip).toBe('NO_PARSED_SIDE');
	});

	it('does not auto-sell without a balance lookup', () => {
		const intent = deriveOrderIntent({
			alert: buyAlert({ enriched: { sentiment_score: -0.9 } }),
			parsed: buyParsed({ side: 'SELL' }),
			config,
		});
		expect(intent.skip).toBe('SELL_NOT_SUPPORTED_PENDING_BALANCE_LOOKUP');
	});

	it('requires an observed price', () => {
		const intent = deriveOrderIntent({
			alert: { text: 'x', enriched: { sentiment_score: 0.8 } },
			parsed: buyParsed(),
			config,
		});
		expect(intent.skip).toBe('NO_CURRENT_PRICE');
	});

	it('skips un-enriched alerts', () => {
		expect(deriveOrderIntent({ alert: { text: 'x' }, parsed: buyParsed(), config }).skip)
			.toBe('NO_ENRICHED_ALERT');
	});
});

describe('routeAlertToOrder', () => {
	it('is a no-op when auto-trade is disabled', async () => {
		const result = await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		expect(result).toEqual({ executed: false, reason: 'AUTO_TRADE_DISABLED' });
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('is a no-op when Binance trading is enabled but unconfigured', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		mockConfig.configured = false;
		const result = await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		expect(result.reason).toBe('BINANCE_TRADING_NOT_CONFIGURED');
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('submits a dry-run order and reports the outcome', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		const result = await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		expect(result.executed).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.orderId).toBe(111);
		expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
		const [body, options] = mockPlaceOrder.mock.calls[0];
		expect(body.dryRun).toBe(true);
		expect(options.idempotencyKey).toContain('auto-trade:r1');
	});

	it('refuses a live order on an unresolvable timeframe', async () => {
		enableLiveAutoTrade();
		const result = await routeAlertToOrder({
			alert: buyAlert(),
			parsed: buyParsed({ timeframe: '3m' }),
			requestId: 'r1',
		});
		expect(result.reason).toBe('UNKNOWN_TIMEFRAME_CANNOT_DEDUPLICATE');
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('refuses a live order when process-wide repeat suppression is off', async () => {
		enableLiveAutoTrade();
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'false';
		const result = await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		expect(result.reason).toBe('LIVE_ORDER_REQUIRES_REPEAT_SUPPRESSION');
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('submits a live order when repeat suppression is on and timeframe resolves', async () => {
		enableLiveAutoTrade();
		mockPlaceOrder.mockResolvedValue({
			success: true, dryRun: false, environment: 'testnet', order: { orderId: 222 },
		});
		const result = await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		expect(result.executed).toBe(true);
		expect(result.dryRun).toBe(false);
		expect(mockPlaceOrder.mock.calls[0][0].dryRun).toBe(false);
	});

	it('suppresses a duplicate signal within the cooldown window', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		const second = await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r2' });
		expect(second.reason).toBe('COOLDOWN_ACTIVE');
		expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
	});

	it('does not suppress an opposite-side flip', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		const flip = await routeAlertToOrder({
			alert: buyAlert({ enriched: { sentiment_score: -0.9 } }),
			parsed: buyParsed({ side: 'SELL' }),
			requestId: 'r2',
		});
		// SELL is refused for its own reason, proving the BUY cooldown did not match.
		expect(flip.reason).toBe('SELL_NOT_SUPPORTED_PENDING_BALANCE_LOOKUP');
	});

	it('rejects symbols outside the operator allow-list', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		const result = await routeAlertToOrder({
			alert: buyAlert(),
			parsed: buyParsed({ symbol: 'SOLUSDT' }),
			requestId: 'r1',
		});
		expect(result.reason).toBe('SYMBOL_NOT_ALLOWED');
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('fails open when the order service throws', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		const error = Object.assign(new Error('Binance unavailable'), { code: 'BINANCE_ORDER_FAILED', statusCode: 502 });
		mockPlaceOrder.mockRejectedValue(error);
		await expect(routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' }))
			.resolves.toEqual({ executed: false, reason: 'ORDER_FAILED', code: 'BINANCE_ORDER_FAILED' });
	});

	it('does not record a cooldown when the order fails', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		mockPlaceOrder.mockRejectedValueOnce(new Error('boom'));
		await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r1' });
		const retry = await routeAlertToOrder({ alert: buyAlert(), parsed: buyParsed(), requestId: 'r2' });
		expect(retry.executed).toBe(true);
	});
});
