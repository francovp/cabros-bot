'use strict';

jest.mock('binance', () => ({ MainClient: jest.fn() }));

const {
	BinanceOrderRequestError,
	createBinanceOrderService,
	binanceOrderService,
} = require('../../src/services/trading/BinanceOrderService');
const { MainClient } = require('binance');

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
				quantity: '0.1',
				price: '100',
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
			idempotencyKey: 'lot-size-check',
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
			idempotencyKey: 'lot-size-check-repeat',
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
			idempotencyKey: 'market-order-check',
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
			quoteOrderQty: '50',
			newClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
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

	it.each([
		['MIN_NOTIONAL', { filterType: 'MIN_NOTIONAL', minNotional: '10', applyToMarket: false }],
		['NOTIONAL', { filterType: 'NOTIONAL', minNotional: '10', maxNotional: '1000', applyMinToMarket: false }],
	])('honors %s market minimum applicability', async (filterType, notionalFilter) => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					notionalFilter,
				],
			})),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 5,
			dryRun: true,
		})).resolves.toMatchObject({ success: true, dryRun: true });
	});

	it('uses a deterministic client order id to reconcile an existing order', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				clientOrderId: 'cb_b07697a7210406a422c57a9ea9340bed',
				orderId: 99,
				status: 'FILLED',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			}),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		}, { idempotencyKey: 'restart-safe-order' })).resolves.toMatchObject({
			success: true,
			dryRun: false,
			order: { orderId: 99, status: 'FILLED' },
		});

		expect(client.getOrder).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			origClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
		});
		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('reconciles exact decimal strings returned by Binance', async () => {
		const client = {
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				clientOrderId: 'cb_b07697a7210406a422c57a9ea9340bed',
				orderId: 99,
				status: 'NEW',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.100000000000000005',
				price: '100.000000000000000005',
			}),
			getExchangeInfo: jest.fn(),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: '0.100000000000000005',
			price: '100.000000000000000005',
			dryRun: false,
		}, { idempotencyKey: 'restart-safe-order' })).resolves.toMatchObject({
			success: true,
			order: { orderId: 99, status: 'NEW' },
		});

		expect(client.getExchangeInfo).not.toHaveBeenCalled();
		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('disables Binance response beautification for order clients', async () => {
		const client = {
			getOrder: jest.fn().mockRejectedValue({ code: -2013, message: 'Unknown order sent.' }),
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', status: 'NEW' }),
		};
		MainClient.mockClear().mockImplementation(() => client);

		await binanceOrderService.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: '0.1',
			price: '100',
			idempotencyKey: 'beautify-disabled',
			dryRun: false,
		});

		expect(MainClient).toHaveBeenCalledWith(expect.objectContaining({
			beautifyResponses: false,
		}), expect.any(Object));
	});

	it('rejects a reconciled limit order with a mismatched time-in-force', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				clientOrderId: 'cb_b07697a7210406a422c57a9ea9340bed',
				orderId: 99,
				status: 'NEW',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			}),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			timeInForce: 'FOK',
			dryRun: false,
		}, { idempotencyKey: 'restart-safe-order' })).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
		});

		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('reconciles an existing order before current symbol status gates', async () => {
		const client = {
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				clientOrderId: 'cb_b07697a7210406a422c57a9ea9340bed',
				orderId: 99,
				status: 'FILLED',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			}),
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({ status: 'BREAK' })),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		}, { idempotencyKey: 'restart-safe-order' })).resolves.toMatchObject({
			success: true,
			dryRun: false,
			order: { orderId: 99, status: 'FILLED' },
		});

		expect(client.getOrder).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			origClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
		});
		expect(client.getExchangeInfo).not.toHaveBeenCalled();
		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('requires a stable order identifier for live requests', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		})).rejects.toMatchObject({ code: 'LIVE_ORDER_ID_REQUIRED' });

		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('rejects timeInForce on market orders', async () => {
		const service = createBinanceOrderService({ createClient: jest.fn() });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 50,
			timeInForce: 'GTC',
			dryRun: true,
		})).rejects.toMatchObject({ code: 'INVALID_ORDER_REQUEST' });
	});

	it('uses Binance order-test validation for dynamic limit price filters', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					{ filterType: 'PERCENT_PRICE', multiplierUp: '1.2', multiplierDown: '0.8', avgPriceMins: 5 },
				],
			})),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: true,
		})).resolves.toMatchObject({ success: true, dryRun: true });

		expect(client.testNewOrder).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			type: 'LIMIT',
			price: 100,
		}));
	});

	it('uses Binance order-test validation for account-dependent filters', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					{ filterType: 'MAX_POSITION', maxPosition: '1' },
				],
			})),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 50,
			dryRun: true,
		})).resolves.toMatchObject({ success: true, dryRun: true });

		expect(client.testNewOrder).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			type: 'MARKET',
			quoteOrderQty: 50,
		}));
	});

	it('uses Binance order-test validation when exchangeInfo contains exchange-wide EXCHANGE_MAX_NUM_ORDERS filter', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue({
				symbols: [{
					symbol: 'BTCUSDT',
					status: 'TRADING',
					orderTypes: ['MARKET', 'LIMIT'],
					isSpotTradingAllowed: true,
					quoteOrderQtyMarketAllowed: true,
					filters: [
						{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
						{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					],
				}],
				exchangeFilters: [
					{ filterType: 'EXCHANGE_MAX_NUM_ORDERS', maxNumOrders: 1000 },
				],
			}),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 50,
			dryRun: true,
		})).resolves.toMatchObject({ success: true, dryRun: true });

		expect(client.testNewOrder).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			type: 'MARKET',
			quoteOrderQty: 50,
		}));
	});

	it('uses Binance order-test validation when exchangeInfo contains exchange-wide MAX_NUM_ALGO_ORDERS filter', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue({
				symbols: [{
					symbol: 'BTCUSDT',
					status: 'TRADING',
					orderTypes: ['MARKET', 'LIMIT'],
					isSpotTradingAllowed: true,
					quoteOrderQtyMarketAllowed: true,
					filters: [
						{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
						{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					],
				}],
				exchangeFilters: [
					{ filterType: 'MAX_NUM_ALGO_ORDERS', maxNumAlgoOrders: 5 },
				],
			}),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 50,
			dryRun: true,
		})).resolves.toMatchObject({ success: true, dryRun: true });

		expect(client.testNewOrder).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			type: 'MARKET',
			quoteOrderQty: 50,
		}));
	});

	it('maps definitive Binance submission rejections separately from unknown outcomes', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn().mockRejectedValue({ code: -2010, message: 'Account has insufficient balance' }),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			idempotencyKey: 'definitive-rejection',
			dryRun: false,
		})).rejects.toMatchObject({ code: 'BINANCE_ORDER_REJECTED', statusCode: 400 });
	});

	it.each([
		[-1003, 429],
		[-1015, 400],
		[-1021, 400],
		[-1034, 429],
	])('treats Binance pre-execution error %s as a definitive rejection', async (code, statusCode) => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn().mockRejectedValue({ code, statusCode }),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			idempotencyKey: `definitive-rejection-${code}`,
			dryRun: false,
		})).rejects.toMatchObject({ code: 'BINANCE_ORDER_REJECTED', statusCode: 400 });
	});

	it('preserves exact decimal strings in submitted order parameters', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.000000000000000001', maxPrice: '1000000', tickSize: '0.000000000000000001' },
					{ filterType: 'LOT_SIZE', minQty: '0.000000000000000001', maxQty: '100', stepSize: '0.000000000000000001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
				],
			})),
			submitNewOrder: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', status: 'NEW' }),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: '0.100000000000000005',
			price: '100.000000000000000005',
			idempotencyKey: 'decimal-preservation',
			dryRun: false,
		});

		expect(client.submitNewOrder).toHaveBeenCalledWith(expect.objectContaining({
			quantity: '0.100000000000000005',
			price: '100.000000000000000005',
		}));
	});

	it('maps transient Binance order-test failures to retryable service errors', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					{ filterType: 'PERCENT_PRICE', multiplierUp: '1.2', multiplierDown: '0.8', avgPriceMins: 5 },
				],
			})),
			testNewOrder: jest.fn().mockRejectedValue(new Error('request timeout')),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: true,
		})).rejects.toMatchObject({ code: 'BINANCE_VALIDATION_FAILED', statusCode: 502 });
	});

	it('keeps unknown execution responses indeterminate', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn().mockRejectedValue({ code: -1006, message: 'Unexpected response' }),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			idempotencyKey: 'unknown-execution',
			dryRun: false,
		})).rejects.toMatchObject({ code: 'BINANCE_ORDER_STATUS_UNKNOWN', statusCode: 503 });
	});

	it('rejects a reconciled order that does not match the request', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				clientOrderId: 'cb_b07697a7210406a422c57a9ea9340bed',
				orderId: 99,
				status: 'FILLED',
				side: 'SELL',
				type: 'LIMIT',
				origQty: '0.1',
				price: '100',
			}),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		}, { idempotencyKey: 'restart-safe-order' })).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
		});

		expect(client.submitNewOrder).not.toHaveBeenCalled();
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
			idempotencyKey: 'ambiguous-order-check',
			dryRun: false,
		})).rejects.toMatchObject({ code: 'BINANCE_ORDER_STATUS_UNKNOWN', statusCode: 503 });
		expect(client.submitNewOrder).toHaveBeenCalledTimes(1);
	});
});
