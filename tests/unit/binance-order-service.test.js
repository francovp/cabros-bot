'use strict';

const {
	BinanceOrderRequestError,
	createBinanceOrderService,
} = require('../../src/services/trading/BinanceOrderService');

function exchangeInfo(overrides = {}) {
	return {
		symbols: [{
			symbol: 'BTCUSDT',
			status: 'TRADING',
			orderTypes: ['MARKET', 'LIMIT'],
			isSpotTradingAllowed: true,
			quoteOrderQtyMarketAllowed: true,
			filters: [
				{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
				{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
				{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
			],
			...overrides,
		}],
	};
}

function configureTrading() {
	process.env.ENABLE_BINANCE_TRADING = 'true';
	process.env.BINANCE_API_KEY = 'test-api-key';
	process.env.BINANCE_API_SECRET = 'test-api-secret';
	process.env.BINANCE_TRADING_ENV = 'testnet';
	process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
	process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
}

describe('BinanceOrderService', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		configureTrading();
	});

	afterEach(() => restoreEnv(savedEnv));

	it('rejects disabled trading before constructing a Binance client', async () => {
		delete process.env.ENABLE_BINANCE_TRADING;
		const createClient = jest.fn();
		const service = createBinanceOrderService({ createClient });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 50,
		})).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

		expect(createClient).not.toHaveBeenCalled();
	});

	it('validates a limit order in dry-run mode without submitting it', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: '0.1',
			price: '100',
			timeInForce: 'GTC',
		})).resolves.toMatchObject({
			success: true,
			dryRun: true,
			environment: 'testnet',
			order: {
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.1,
				price: 100,
				timeInForce: 'GTC',
			},
		});

		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('rejects a quantity that violates the Binance lot-size step before submission', async () => {
		const client = { getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()) };
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: '0.10005',
			price: '100',
			timeInForce: 'GTC',
			dryRun: false,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
		});

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: '0.10005',
			price: '100',
			timeInForce: 'GTC',
			dryRun: false,
		})).rejects.toBeInstanceOf(BinanceOrderRequestError);
	});

	it('submits a validated market quote order once and sanitizes the result', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 42,
				clientOrderId: 'abc',
				status: 'FILLED',
				executedQty: '0.0008',
				cummulativeQuoteQty: '50',
				fills: [{ price: '62500', qty: '0.0008', commission: '0.05', commissionAsset: 'USDT' }],
				secret: 'must-not-escape',
			}),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: '50',
			dryRun: false,
		})).resolves.toEqual({
			success: true,
			dryRun: false,
			environment: 'testnet',
			order: {
				symbol: 'BTCUSDT',
				orderId: 42,
				clientOrderId: 'abc',
				status: 'FILLED',
				executedQty: '0.0008',
				cummulativeQuoteQty: '50',
				fills: [{ price: '62500', qty: '0.0008', commission: '0.05', commissionAsset: 'USDT' }],
			},
		});

		expect(client.submitNewOrder).toHaveBeenCalledTimes(1);
		expect(client.submitNewOrder).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 50,
			newOrderRespType: 'FULL',
		});
	});

	it('rejects quantity-based market orders when the notional cap cannot be enforced', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.1,
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'MARKET_QUANTITY_NOTIONAL_UNSUPPORTED',
		});

		expect(client.getAvgPrice).not.toHaveBeenCalled();
	});

	it('honors Binance maximum notional and its market applicability flag', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'NOTIONAL', minNotional: '10', maxNotional: '75', applyMaxToMarket: false },
				],
			})),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.2,
			price: 500,
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
		});

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 80,
			dryRun: true,
		})).resolves.toMatchObject({ success: true, dryRun: true });
	});

	it('does not retry an ambiguous Binance submission failure', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn().mockRejectedValue(new Error('provider timeout')),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		})).rejects.toMatchObject({ code: 'BINANCE_ORDER_STATUS_UNKNOWN', statusCode: 503 });
		expect(client.submitNewOrder).toHaveBeenCalledTimes(1);
	});
});
