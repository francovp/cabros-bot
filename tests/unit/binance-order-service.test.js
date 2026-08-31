'use strict';

jest.mock('binance', () => ({ MainClient: jest.fn() }));

// Default to an open control service for the trading control singleton
// so tests that hit the module-level `binanceOrderService` don't trip
// the fail-closed gate. Tests that need pause/unavailable behavior
// build a custom service via `createBinanceOrderService` directly.
const mockControl = {
	paused: false,
	unavailable: false,
	pausedBy: null,
	pausedAt: null,
	pausedReason: null,
};

jest.mock('../../src/services/trading/TradingControlService', () => {
	const openState = () => ({
		paused: mockControl.paused,
		pausedBy: mockControl.pausedBy,
		pausedAt: mockControl.pausedAt,
		pausedReason: mockControl.pausedReason,
		resumedBy: null,
		resumedAt: null,
		lastChangedAt: null,
		lastChangedBy: null,
		lastAction: mockControl.paused ? 'pause' : null,
		unavailable: mockControl.unavailable,
		inactive: false,
		storage: 'memory',
		isBlocked() {
			return this.paused || (this.unavailable && !this.inactive);
		},
	});
	const tradingControlService = {
		async getPauseState() { return openState(); },
		async pause() { return openState(); },
		async resume() { return openState(); },
		getStatus() {
			return {
				enabled: true,
				storage: 'memory',
				paused: mockControl.paused,
				pausedBy: mockControl.pausedBy,
				pausedAt: mockControl.pausedAt,
				pausedReason: mockControl.pausedReason,
				lastChangedAt: null,
				lastChangedBy: null,
				lastAction: mockControl.paused ? 'pause' : null,
				firestoreReady: false,
			};
		},
		readAction() { return null; },
		readReason() { return null; },
		normalizeActor(a) { return typeof a === 'string' ? a.trim().slice(0, 80) : 'unknown'; },
		normalizeReason(r) { return typeof r === 'string' ? r.trim().slice(0, 280) || null : null; },
	};
	return {
		tradingControlService,
		TradingControlError: class TradingControlError extends Error {
			constructor(message, code, statusCode) {
				super(message);
				this.code = code;
				this.statusCode = statusCode;
			}
		},
		TradingControlState: class TradingControlState {},
		STATE_DOC_PATH: 'tradingControl/state',
		COLLECTION_NAME: 'tradingControl',
		STATE_DOC_ID: 'state',
		createTradingControlService: () => tradingControlService,
	};
});

const {
	BinanceOrderRequestError,
	createBinanceOrderService,
	binanceOrderService,
} = require('../../src/services/trading/BinanceOrderService');
const { MainClient } = require('binance');

// Default open control service: trading is enabled, pause is never active,
// storage is always available. Tests that exercise the kill-switch inject
// a custom `controlService` instead.
function openControlService() {
	return {
		async getPauseState() {
			return {
				paused: false,
				pausedBy: null,
				pausedAt: null,
				pausedReason: null,
				resumedBy: null,
				resumedAt: null,
				lastChangedAt: null,
				lastChangedBy: null,
				lastAction: null,
				unavailable: false,
				inactive: false,
				storage: 'memory',
				isBlocked() { return false; },
			};
		},
		getStatus() {
			return {
				enabled: true,
				storage: 'memory',
				paused: false,
				pausedBy: null,
				pausedAt: null,
				pausedReason: null,
				lastChangedAt: null,
				lastChangedBy: null,
				lastAction: null,
				firestoreReady: false,
			};
		},
	};
}

// Wrap createBinanceOrderService so existing tests get the open control
// service by default. Tests that need different behavior pass
// `controlService` explicitly.
function createServiceWithDefaultControl(options = {}) {
	if (options.controlService) {
		return createBinanceOrderService(options);
	}
	return createBinanceOrderService({
		...options,
		controlService: openControlService(),
	});
}

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
		mockControl.paused = false;
		mockControl.unavailable = false;
		mockControl.pausedBy = null;
		mockControl.pausedAt = null;
		mockControl.pausedReason = null;
	});

	afterEach(() => restoreEnv(savedEnv));

	it('rejects disabled trading before constructing a Binance client', async () => {
		delete process.env.ENABLE_BINANCE_TRADING;
		const createClient = jest.fn();
		const service = createServiceWithDefaultControl({ createClient });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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

	it('allows quantity-based market orders with average-price notional validation', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: true,
		});

		expect(client.getAvgPrice).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
		expect(result).toMatchObject({
			success: true,
			dryRun: true,
			order: {
				symbol: 'BTCUSDT',
				side: 'SELL',
				type: 'MARKET',
				quantity: 0.001,
			},
		});
	});

	it('rejects quantity-based market orders when estimated notional exceeds maxNotional', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '100';
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'MARKET',
			quantity: 0.01, // 0.01 * 50000 = 500 > 100
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			message: expect.stringContaining('configured maximum'),
		});
	});

	it('bounds quantity-based market BUYs with exchange-enforced quoteOrderQty', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '100';
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.001, // 0.001 * 50000 = 50 <= 100
			dryRun: true,
		});

		expect(result.success).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.order.quoteOrderQty).toBe('50');
		expect(result.order.quantity).toBeUndefined();
		expect(client.getAvgPrice).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
	});

	it('keeps base-quantity market SELLs unchanged without quoteOrderQty conversion', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '100';
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: true,
		});

		expect(result.success).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.order.quantity).toBe(0.001);
		expect(result.order.quoteOrderQty).toBeUndefined();
	});

	it('rejects quantity-based market BUYs above maxNotional before any provider call', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '10';
		const getAvgPrice = jest.fn().mockResolvedValue({ price: '50000.00' });
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice,
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 1, // 1 * 50000 = 50000 > 10
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			message: expect.stringContaining('configured maximum'),
		});
	});

	it('preserves exact decimal precision when converting MARKET BUYs to quoteOrderQty', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '100.2' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: '0.1',
			dryRun: true,
		});

		expect(result.order.quoteOrderQty).toBe('10.02');
	});

	it('quantizes converted MARKET BUY quoteOrderQty to symbol quote precision', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				quotePrecision: 8,
			})),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.123456789' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: '0.001',
			dryRun: true,
		});

		expect(result.order.quoteOrderQty).toBe('50.00012345');
	});

	it('rejects converted MARKET BUYs when the symbol disallows quoteOrderQty', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				quoteOrderQtyMarketAllowed: false,
			})),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			message: expect.stringContaining('quoteOrderQty is not supported'),
		});
	});

	it('keeps quantity-based market orders unconverted for SELL when quoteOrderQty is not allowed', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
				],
			})),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: true,
		});

		expect(result.order.quantity).toBe(0.001);
		expect(result.order.quoteOrderQty).toBeUndefined();
	});

	it('reconciles an accepted quote-sized MARKET BUY after idempotency cache loss', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
		let callCount = 0;
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
			testNewOrder: jest.fn().mockResolvedValue({}),
			submitNewOrder: jest.fn().mockRejectedValue(new Error('provider timeout')),
			getOrder: jest.fn((params) => {
				callCount += 1;
				if (callCount === 1) throw { code: -2013, message: 'Unknown order sent.' };
				return Promise.resolve({
					symbol: 'BTCUSDT',
					orderId: 77,
					clientOrderId: params?.origClientOrderId,
					status: 'FILLED',
					side: 'BUY',
					type: 'MARKET',
					origQty: '0.00000000',
					origQuoteOrderQty: '50.00',
					cummulativeQuoteQty: '50.00',
					executedQty: '0.00100000',
				});
			}),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: false,
		}, { idempotencyKey: 'reconcile-cache-loss' })).rejects.toMatchObject({ code: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		const reconciled = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: false,
		}, { idempotencyKey: 'reconcile-cache-loss' });

		expect(reconciled.success).toBe(true);
		expect(reconciled.order.orderId).toBe(77);
	});

	it('reconciles a quote-sized MARKET BUY when matching canonical request fingerprint', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getOrder: jest.fn().mockImplementation(async (params) => ({
				symbol: 'BTCUSDT',
				orderId: 99,
				clientOrderId: params?.origClientOrderId,
				status: 'FILLED',
				side: 'BUY',
				type: 'MARKET',
				origQty: '0.00000000',
				origQuoteOrderQty: '50.00',
				cummulativeQuoteQty: '50.00',
				executedQty: '0.00100000',
			})),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		const reconciled = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: false,
		}, { idempotencyKey: 'quote-market-buy' });

		expect(reconciled.success).toBe(true);
		expect(reconciled.order.orderId).toBe(99);
	});


	it('rejects changed quantity during quote-sized MARKET BUY reconciliation with 409 conflict', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
		const clientOrderId = `cb_${'b'.repeat(32)}`;
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 88,
				clientOrderId,
				status: 'FILLED',
				side: 'BUY',
				type: 'MARKET',
				origQty: '0.00000000',
				origQuoteOrderQty: '50.00',
				cummulativeQuoteQty: '50.00',
				executedQty: '0.00100000',
			}),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.005,
			clientOrderId,
			dryRun: false,
		})).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
			message: expect.stringContaining('Reconciled Binance order does not match the request'),
		});
	});

	it('rejects quantity-based market orders when getAvgPrice fails', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockRejectedValue(new Error('Binance price service unavailable')),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'MARKET',
			quantity: 0.001,
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'BINANCE_VALIDATION_FAILED',
		});
	});

	it('enforces MARKET_LOT_SIZE filters on quantity-based market orders', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MARKET_LOT_SIZE', minQty: '0.01', maxQty: '10', stepSize: '0.01' },
					{ filterType: 'NOTIONAL', minNotional: '10', maxNotional: '10000', applyMaxToMarket: false },
				],
			})),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'MARKET',
			quantity: 0.005, // Below minQty 0.01
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			message: expect.stringContaining('minimum'),
		});
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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
			getOrder: jest.fn().mockImplementation(async (params) => ({
				symbol: 'BTCUSDT',
				clientOrderId: params?.origClientOrderId,
				orderId: 99,
				status: 'FILLED',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			})),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
			getOrder: jest.fn().mockImplementation(async (params) => ({
				symbol: 'BTCUSDT',
				clientOrderId: params?.origClientOrderId,
				orderId: 99,
				status: 'NEW',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.100000000000000005',
				price: '100.000000000000000005',
			})),
			getExchangeInfo: jest.fn(),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

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

	it('fingerprints clientOrderId so different order parameters produce different clientOrderIds', async () => {
		const client = {
			getOrder: jest.fn().mockRejectedValue({ code: -2013, message: 'Unknown order sent.' }),
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', status: 'NEW' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		}, { idempotencyKey: 'same-key' });

		const firstClientOrderId = client.submitNewOrder.mock.calls[0][0].newClientOrderId;

		await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.2,
			price: 100,
			dryRun: false,
		}, { idempotencyKey: 'same-key' });

		const secondClientOrderId = client.submitNewOrder.mock.calls[1][0].newClientOrderId;

		expect(firstClientOrderId).not.toBe(secondClientOrderId);
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
			getOrder: jest.fn().mockImplementation(async (params) => ({
				symbol: 'BTCUSDT',
				clientOrderId: params?.origClientOrderId,
				orderId: 99,
				status: 'NEW',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			})),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
			getOrder: jest.fn().mockImplementation(async (params) => ({
				symbol: 'BTCUSDT',
				clientOrderId: params?.origClientOrderId,
				orderId: 99,
				status: 'FILLED',
				side: 'BUY',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			})),
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({ status: 'BREAK' })),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
						{ filterType: 'MAX_NUM_ALGO_ORDERS', maxNumAlgoOrders: 5 },
					],
				}],
				exchangeFilters: [],
			}),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

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

	it('uses Binance order-test validation when exchangeInfo contains exchange-wide EXCHANGE_MAX_ALGO_ORDERS filter', async () => {
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
					{ filterType: 'EXCHANGE_MAX_ALGO_ORDERS', maxNumAlgoOrders: 5 },
				],
			}),
			testNewOrder: jest.fn().mockResolvedValue({}),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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
		const service = createServiceWithDefaultControl({ createClient: () => client });

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

	describe('BINANCE_DATA_BASE_URL forwarding', () => {
		it('forwards configured BINANCE_DATA_BASE_URL to the live Binance client', async () => {
			process.env.ENABLE_BINANCE_TRADING = 'true';
			process.env.BINANCE_API_KEY = 'test-api-key';
			process.env.BINANCE_API_SECRET = 'test-api-secret';
			process.env.BINANCE_TRADING_ENV = 'live';
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
			process.env.BINANCE_DATA_BASE_URL = 'https://api1.binance.com';

			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				submitNewOrder: jest.fn().mockResolvedValue({ orderId: 1, status: 'FILLED' }),
			};
			MainClient.mockClear().mockImplementation(() => client);

			await binanceOrderService.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
				idempotencyKey: 'idem-base-url-live',
				dryRun: false,
			});

			expect(MainClient).toHaveBeenCalledWith(expect.objectContaining({
				baseUrl: 'https://api1.binance.com',
			}), expect.any(Object));
		});

		it('keeps default testnet host for testnet environment when BINANCE_DATA_BASE_URL is set', async () => {
			process.env.ENABLE_BINANCE_TRADING = 'true';
			process.env.BINANCE_API_KEY = 'test-api-key';
			process.env.BINANCE_API_SECRET = 'test-api-secret';
			process.env.BINANCE_TRADING_ENV = 'testnet';
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
			process.env.BINANCE_DATA_BASE_URL = 'https://api1.binance.com';

			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				submitNewOrder: jest.fn().mockResolvedValue({ orderId: 1, status: 'FILLED' }),
			};
			MainClient.mockClear().mockImplementation(() => client);

			await binanceOrderService.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
				idempotencyKey: 'idem-base-url-testnet',
				dryRun: false,
			});

			expect(MainClient).toHaveBeenCalledWith(expect.objectContaining({
				baseUrl: 'https://testnet.binance.vision',
			}), expect.any(Object));
		});

		it('falls back to default live Binance base URL when BINANCE_DATA_BASE_URL is malformed', async () => {
			process.env.ENABLE_BINANCE_TRADING = 'true';
			process.env.BINANCE_API_KEY = 'test-api-key';
			process.env.BINANCE_API_SECRET = 'test-api-secret';
			process.env.BINANCE_TRADING_ENV = 'live';
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
			process.env.BINANCE_DATA_BASE_URL = 'not-a-url';

			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				submitNewOrder: jest.fn().mockResolvedValue({ orderId: 1, status: 'FILLED' }),
			};
			MainClient.mockClear().mockImplementation(() => client);

			await binanceOrderService.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
				idempotencyKey: 'idem-base-url-malformed',
				dryRun: false,
			});

			expect(MainClient).toHaveBeenCalledWith(expect.objectContaining({
				baseUrl: 'https://api.binance.com',
			}), expect.any(Object));
		});
	});

	describe('getOrders', () => {
		it('rejects disabled trading before constructing a Binance client', async () => {
			delete process.env.ENABLE_BINANCE_TRADING;
			const createClient = jest.fn();
			const service = createServiceWithDefaultControl({ createClient });

			await expect(service.getOrders({ symbol: 'BTCUSDT' })).rejects.toMatchObject({
				code: 'FEATURE_DISABLED',
				statusCode: 403,
			});
			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects unconfigured trading when credentials or symbols are missing', async () => {
			delete process.env.BINANCE_API_KEY;
			const createClient = jest.fn();
			const service = createServiceWithDefaultControl({ createClient });

			await expect(service.getOrders({ symbol: 'BTCUSDT' })).rejects.toMatchObject({
				code: 'BINANCE_TRADING_UNAVAILABLE',
				statusCode: 503,
			});
			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects missing or empty symbol', async () => {
			const service = createBinanceOrderService({ createClient: jest.fn() });

			await expect(service.getOrders({})).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('symbol is required'),
			});

			await expect(service.getOrders({ symbol: '   ' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('symbol is required'),
			});
		});

		it('rejects invalid symbol format or disallowed symbols', async () => {
			const service = createBinanceOrderService({ createClient: jest.fn() });

			await expect(service.getOrders({ symbol: 'INVALID!' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('symbol must be a Binance Spot symbol'),
			});

			await expect(service.getOrders({ symbol: 'ETHUSDT' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('symbol is not allowed for Binance trading'),
			});
		});

		it('rejects invalid orderId', async () => {
			const service = createBinanceOrderService({ createClient: jest.fn() });

			await expect(service.getOrders({ symbol: 'BTCUSDT', orderId: 'abc' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('orderId must be a positive integer'),
			});

			await expect(service.getOrders({ symbol: 'BTCUSDT', orderId: -5 })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('orderId must be a positive integer'),
			});
		});

		it('rejects invalid origClientOrderId / clientOrderId', async () => {
			const service = createBinanceOrderService({ createClient: jest.fn() });

			await expect(service.getOrders({ symbol: 'BTCUSDT', origClientOrderId: 'bad order id with spaces!' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('origClientOrderId must contain 1-36 safe characters'),
			});
		});

		it('rejects non-numeric limit', async () => {
			const service = createBinanceOrderService({ createClient: jest.fn() });

			await expect(service.getOrders({ symbol: 'BTCUSDT', limit: 'invalid' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				message: expect.stringContaining('limit must be an integer between 1 and 100'),
			});
		});

		it('queries single order status by orderId', async () => {
			const client = {
				getOrder: jest.fn().mockResolvedValue({
					symbol: 'BTCUSDT',
					orderId: 42,
					clientOrderId: 'cb_test_1',
					price: '60000.00000000',
					origQty: '0.00100000',
					executedQty: '0.00100000',
					cummulativeQuoteQty: '60.00000000',
					status: 'FILLED',
					timeInForce: 'GTC',
					type: 'LIMIT',
					side: 'BUY',
					time: 1700000000000,
					updateTime: 1700000005000,
					isWorking: true,
					secret: 'must-not-leak',
				}),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			const result = await service.getOrders({ symbol: 'btcusdt', orderId: '42' });
			expect(client.getOrder).toHaveBeenCalledWith({
				symbol: 'BTCUSDT',
				orderId: 42,
			});
			expect(result).toEqual({
				success: true,
				environment: 'testnet',
				order: {
					symbol: 'BTCUSDT',
					orderId: 42,
					clientOrderId: 'cb_test_1',
					price: '60000.00000000',
					origQty: '0.00100000',
					executedQty: '0.00100000',
					cummulativeQuoteQty: '60.00000000',
					status: 'FILLED',
					timeInForce: 'GTC',
					type: 'LIMIT',
					side: 'BUY',
					time: 1700000000000,
					updateTime: 1700000005000,
					isWorking: true,
				},
			});
			expect(result.order.secret).toBeUndefined();
		});

		it('queries single order status by origClientOrderId / clientOrderId', async () => {
			const client = {
				getOrder: jest.fn().mockResolvedValue({
					symbol: 'BTCUSDT',
					orderId: 43,
					clientOrderId: 'custom-client-id',
					price: '0.00000000',
					origQty: '0.00500000',
					executedQty: '0.00500000',
					cummulativeQuoteQty: '300.00000000',
					status: 'FILLED',
					timeInForce: 'GTC',
					type: 'MARKET',
					side: 'BUY',
				}),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			const result = await service.getOrders({ symbol: 'BTCUSDT', clientOrderId: 'custom-client-id' });
			expect(client.getOrder).toHaveBeenCalledWith({
				symbol: 'BTCUSDT',
				origClientOrderId: 'custom-client-id',
			});
			expect(result).toMatchObject({
				success: true,
				environment: 'testnet',
				order: {
					symbol: 'BTCUSDT',
					orderId: 43,
					clientOrderId: 'custom-client-id',
					status: 'FILLED',
					type: 'MARKET',
				},
			});
		});

		it('returns 404 when single order is not found on Binance', async () => {
			const client = {
				getOrder: jest.fn().mockRejectedValue({ code: -2013, message: 'Order does not exist.' }),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			await expect(service.getOrders({ symbol: 'BTCUSDT', orderId: 9999 })).rejects.toMatchObject({
				code: 'ORDER_NOT_FOUND',
				statusCode: 404,
				message: 'Binance order not found',
			});
		});

		it('queries recent order history when no orderId or clientOrderId is provided with clamped limit', async () => {
			const client = {
				allOrders: jest.fn().mockResolvedValue([
					{
						symbol: 'BTCUSDT',
						orderId: 101,
						clientOrderId: 'order-1',
						status: 'FILLED',
						type: 'LIMIT',
						side: 'BUY',
						price: '60000.00000000',
						origQty: '0.00100000',
						executedQty: '0.00100000',
						cummulativeQuoteQty: '60.00000000',
					},
					{
						symbol: 'BTCUSDT',
						orderId: 102,
						clientOrderId: 'order-2',
						status: 'CANCELED',
						type: 'LIMIT',
						side: 'SELL',
						price: '70000.00000000',
						origQty: '0.00100000',
						executedQty: '0.00000000',
						cummulativeQuoteQty: '0.00000000',
					},
				]),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			const result = await service.getOrders({ symbol: 'BTCUSDT', limit: 200 }); // clamped to 100
			expect(client.allOrders).toHaveBeenCalledWith({
				symbol: 'BTCUSDT',
				limit: 100,
			});
			expect(result).toEqual({
				success: true,
				environment: 'testnet',
				orders: [
					{
						symbol: 'BTCUSDT',
						orderId: 101,
						clientOrderId: 'order-1',
						status: 'FILLED',
						type: 'LIMIT',
						side: 'BUY',
						price: '60000.00000000',
						origQty: '0.00100000',
						executedQty: '0.00100000',
						cummulativeQuoteQty: '60.00000000',
					},
					{
						symbol: 'BTCUSDT',
						orderId: 102,
						clientOrderId: 'order-2',
						status: 'CANCELED',
						type: 'LIMIT',
						side: 'SELL',
						price: '70000.00000000',
						origQty: '0.00100000',
						executedQty: '0.00000000',
						cummulativeQuoteQty: '0.00000000',
					},
				],
				count: 2,
			});
		});

		it('uses default limit of 50 when limit is omitted', async () => {
			const client = {
				allOrders: jest.fn().mockResolvedValue([]),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			const result = await service.getOrders({ symbol: 'BTCUSDT' });
			expect(client.allOrders).toHaveBeenCalledWith({
				symbol: 'BTCUSDT',
				limit: 50,
			});
			expect(result).toEqual({
				success: true,
				environment: 'testnet',
				orders: [],
				count: 0,
			});
		});

		it('maps definitive Binance query rejection to 400', async () => {
			const client = {
				allOrders: jest.fn().mockRejectedValue({ code: -1015, message: 'Too many requests' }),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			await expect(service.getOrders({ symbol: 'BTCUSDT' })).rejects.toMatchObject({
				code: 'BINANCE_REQUEST_REJECTED',
				statusCode: 400,
			});
		});

		it('maps provider failure or timeout to 502', async () => {
			const client = {
				allOrders: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			await expect(service.getOrders({ symbol: 'BTCUSDT' })).rejects.toMatchObject({
				code: 'BINANCE_QUERY_FAILED',
				statusCode: 502,
			});
		});
	});

	describe('runtime kill-switch', () => {
		function buildControlService(overrides = {}) {
			return {
				async getPauseState() {
					return {
						paused: Boolean(overrides.paused),
						pausedBy: overrides.pausedBy || null,
						pausedAt: overrides.pausedAt || null,
						pausedReason: overrides.pausedReason || null,
						resumedBy: overrides.resumedBy || null,
						resumedAt: overrides.resumedAt || null,
						lastChangedAt: overrides.lastChangedAt || null,
						lastChangedBy: overrides.lastChangedBy || null,
						lastAction: overrides.lastAction || null,
						unavailable: Boolean(overrides.unavailable),
						inactive: Boolean(overrides.inactive),
						storage: overrides.storage || 'memory',
						isBlocked() {
							return this.paused || (this.unavailable && !this.inactive);
						},
					};
				},
				getStatus() {
					return {
						enabled: true,
						storage: overrides.storage || 'memory',
						paused: Boolean(overrides.paused),
						pausedBy: overrides.pausedBy || null,
						pausedAt: overrides.pausedAt || null,
						pausedReason: overrides.pausedReason || null,
						lastChangedAt: overrides.lastChangedAt || null,
						lastChangedBy: overrides.lastChangedBy || null,
						lastAction: overrides.lastAction || null,
						firestoreReady: overrides.storage === 'firestore',
					};
				},
				readAction() { return null; },
				readReason() { return null; },
				normalizeActor(a) { return typeof a === 'string' ? a.trim().slice(0, 80) : 'unknown'; },
				normalizeReason(r) { return typeof r === 'string' ? r.trim().slice(0, 280) || null : null; },
			};
		}

		it('rejects live order submissions with TRADING_PAUSED before constructing a client', async () => {
			const createClient = jest.fn();
			const controlService = buildControlService({
				paused: true,
				pausedBy: 'incident-commander',
				pausedAt: '2026-08-30T12:00:00Z',
				pausedReason: 'suspected credential leak',
				lastAction: 'pause',
			});
			const service = createBinanceOrderService({ createClient, controlService });

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quoteOrderQty: 50,
			})).rejects.toMatchObject({
				code: 'TRADING_PAUSED',
				statusCode: 503,
			});

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects dryRun submissions while paused to avoid signed testNewOrder calls', async () => {
			const createClient = jest.fn();
			const controlService = buildControlService({
				paused: true,
				pausedBy: 'incident-commander',
				pausedReason: 'strategy rollback',
			});
			const service = createBinanceOrderService({ createClient, controlService });

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quoteOrderQty: 50,
				dryRun: true,
			})).rejects.toMatchObject({
				code: 'TRADING_PAUSED',
				statusCode: 503,
			});

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rechecks the pause state before a signed order-test request', async () => {
			const openState = buildControlService().getPauseState;
			const pausedState = buildControlService({ paused: true });
			const getPauseState = jest.fn()
				.mockResolvedValueOnce(await openState())
				.mockResolvedValueOnce(await pausedState.getPauseState());
			const controlService = {
				getPauseState,
			};
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
					filters: [
						...exchangeInfo().symbols[0].filters,
						{ filterType: 'PERCENT_PRICE', multiplierUp: '2', multiplierDown: '0.5', avgPriceMins: 5 },
					],
				})),
				testNewOrder: jest.fn().mockResolvedValue({}),
			};
			const service = createBinanceOrderService({ createClient: () => client, controlService });

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
				dryRun: true,
			})).rejects.toMatchObject({ code: 'TRADING_PAUSED', statusCode: 503 });

			expect(getPauseState).toHaveBeenCalledTimes(2);
			expect(client.testNewOrder).not.toHaveBeenCalled();
		});

		it('rechecks the pause state before submitting a live order', async () => {
			const openState = buildControlService().getPauseState;
			const pausedState = buildControlService({ paused: true });
			const getPauseState = jest.fn()
				.mockResolvedValueOnce(await openState())
				.mockResolvedValueOnce(await openState())
				.mockResolvedValueOnce(await pausedState.getPauseState());
			const controlService = { getPauseState };
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
					filters: [
						...exchangeInfo().symbols[0].filters,
						{ filterType: 'PERCENT_PRICE', multiplierUp: '2', multiplierDown: '0.5', avgPriceMins: 5 },
					],
				})),
				testNewOrder: jest.fn().mockResolvedValue({}),
				submitNewOrder: jest.fn().mockResolvedValue({ orderId: 1 }),
			};
			const service = createBinanceOrderService({ createClient: () => client, controlService });

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
				clientOrderId: 'live-order-1',
				dryRun: false,
			})).rejects.toMatchObject({ code: 'TRADING_PAUSED', statusCode: 503 });

			expect(getPauseState).toHaveBeenCalledTimes(3);
			expect(client.testNewOrder).toHaveBeenCalledTimes(1);
			expect(client.submitNewOrder).not.toHaveBeenCalled();
		});

		it('fails closed when the pause state is unavailable and trading is enabled', async () => {
			const createClient = jest.fn();
			const controlService = buildControlService({
				unavailable: true,
			});
			const service = createBinanceOrderService({ createClient, controlService });

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
				dryRun: true,
			})).rejects.toMatchObject({
				code: 'TRADING_PAUSED',
				statusCode: 503,
			});

			expect(createClient).not.toHaveBeenCalled();
		});

		it('does not block submissions when the control service reports an inactive path', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				submitNewOrder: jest.fn(),
			};
			const controlService = buildControlService({ inactive: true });
			const service = createBinanceOrderService({ createClient: () => client, controlService });

			const result = await service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
				dryRun: true,
			});

			expect(result).toMatchObject({ success: true, dryRun: true });
			expect(client.getExchangeInfo).toHaveBeenCalledTimes(1);
		});

		it('refreshes persisted pause state through getStatus without leaking secrets', async () => {
			const controlService = buildControlService({
				getPauseState: undefined,
			});
			const persistedState = buildControlService({
				paused: true,
				pausedBy: 'incident-commander',
				pausedAt: '2026-08-30T12:00:00Z',
				pausedReason: 'investigation',
				storage: 'firestore',
				lastAction: 'pause',
			}).getPauseState;
			controlService.getPauseState = jest.fn(() => persistedState());
			const service = createBinanceOrderService({
				createClient: jest.fn(),
				controlService,
			});

			const status = await service.getStatus();
			expect(status).toMatchObject({
				paused: true,
				pausedBy: 'incident-commander',
				pausedAt: '2026-08-30T12:00:00Z',
				pausedReason: 'investigation',
				controlStorage: 'firestore',
				lastAction: 'pause',
			});
			expect(status).not.toHaveProperty('BINANCE_API_KEY');
			expect(status).not.toHaveProperty('apiSecret');
		});
	});
});
