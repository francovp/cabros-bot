/* global saveEnv, restoreEnv */
'use strict';

const crypto = require('crypto');

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
				unavailable: mockControl.unavailable,
				blocked: Boolean(mockControl.paused || mockControl.unavailable),
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
	BinanceOrderServiceError,
	createBinanceOrderService,
	binanceOrderService,
	sellableQuantity,
	deriveAllowedAssets,
	deriveSymbolAssets,
} = require('../../src/services/trading/BinanceOrderService');
const { resetOrderProvenanceForTesting } = require('../../src/services/trading/orderProvenance');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
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
		resetOrderProvenanceForTesting();
		jest.spyOn(AlertStorageService, 'isEnabled').mockReturnValue(true);
		jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue({});
		jest.spyOn(AlertStorageService, 'getAlertById').mockImplementation(async (id) => {
			if (!id || id.startsWith('nonexistent')) return null;
			return { id, setupType: 'breakout' };
		});
		mockControl.paused = false;
		mockControl.unavailable = false;
		mockControl.pausedBy = null;
		mockControl.pausedAt = null;
		mockControl.pausedReason = null;
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		jest.restoreAllMocks();
		jest.clearAllMocks();
	});

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

	it('validates a Spot trailing stop-limit using the symbol trailing-delta filter', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['STOP_LOSS_LIMIT'],
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					{ filterType: 'TRAILING_DELTA', minTrailingAboveDelta: 10, maxTrailingAboveDelta: 500, minTrailingBelowDelta: 10, maxTrailingBelowDelta: 500 },
				],
			})),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'STOP_LOSS_LIMIT',
			quantity: '0.2',
			price: '99',
			stopPrice: '100',
			timeInForce: 'GTC',
			trailingDelta: 100,
		})).resolves.toMatchObject({
			success: true,
			dryRun: true,
			order: {
				type: 'STOP_LOSS_LIMIT',
				stopPrice: '100',
				trailingDelta: 100,
			},
		});

		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('rejects a trailing delta outside the side-specific Spot filter before submission', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['STOP_LOSS_LIMIT'],
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					{ filterType: 'TRAILING_DELTA', minTrailingAboveDelta: 10, maxTrailingAboveDelta: 500, minTrailingBelowDelta: 10, maxTrailingBelowDelta: 500 },
				],
			})),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'STOP_LOSS_LIMIT',
			quantity: '0.2',
			price: '99',
			stopPrice: '100',
			timeInForce: 'GTC',
			trailingDelta: 501,
		})).rejects.toThrow('trailingDelta');

		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('validates contingent stopPrice against the Spot price filter', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({ orderTypes: ['STOP_LOSS'] })),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '60000' }),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'STOP_LOSS',
			quantity: '0.2',
			stopPrice: '59000.001',
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			message: expect.stringContaining('tick size'),
		});

		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('builds a Spot OTOCO bracket preview with a limit maker target and stop-limit leg', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			submitNewOrderListOTOCO: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
		})).resolves.toMatchObject({
			success: true,
			dryRun: true,
			orderList: {
				workingType: 'LIMIT',
				workingSide: 'BUY',
				workingPrice: '100',
				workingQuantity: '0.2',
				pendingSide: 'SELL',
				pendingAboveType: 'LIMIT_MAKER',
				pendingAbovePrice: '110',
				pendingBelowType: 'STOP_LOSS_LIMIT',
				pendingBelowStopPrice: '90',
				pendingBelowPrice: '89',
			},
		});

		expect(client.submitNewOrderListOTOCO).not.toHaveBeenCalled();
	});

	it('builds a Spot OTOCO bracket preview for a SELL-entry with a TAKE_PROFIT_LIMIT target and stop-limit leg', async () => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			submitNewOrderListOTOCO: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '110',
			stopLimitPrice: '111',
			takeProfitPrice: '90',
			timeInForce: 'GTC',
		})).resolves.toMatchObject({
			orderList: {
				pendingSide: 'BUY',
				pendingAboveType: 'STOP_LOSS_LIMIT',
				pendingAboveStopPrice: '110',
				pendingAbovePrice: '111',
				pendingAboveTimeInForce: 'GTC',
				pendingBelowType: 'TAKE_PROFIT_LIMIT',
				pendingBelowStopPrice: '90',
				pendingBelowPrice: '90',
				pendingBelowTimeInForce: 'GTC',
			},
		});
	});

	it.each(['IOC', 'FOK'])('rejects BRACKET_LIMIT timeInForce %s because its entry or protective stop could expire', async (timeInForce) => {
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
		};
		const createClient = jest.fn(() => client);
		const service = createServiceWithDefaultControl({ createClient });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			statusCode: 400,
			message: expect.stringContaining('GTC'),
		});

		expect(createClient).not.toHaveBeenCalled();
	});

	it('reserves and submits a live OTOCO list once with deterministic component IDs', async () => {
		const storage = {
			getReservation: jest.fn().mockResolvedValue(null),
			reserve: jest.fn().mockImplementation(async (input) => ({
				outcome: 'reserved',
				state: 'RESERVED',
				keyHash: 'b'.repeat(64),
				...input,
			})),
			recordOrderList: jest.fn().mockResolvedValue({}),
			updateReservation: jest.fn().mockResolvedValue({}),
		};
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			submitNewOrderListOTOCO: jest.fn().mockImplementation(async (params) => ({
				orderListId: 77,
				symbol: params.symbol,
				listClientOrderId: params.listClientOrderId,
				listOrderStatus: 'EXECUTING',
				orders: [],
				orderReports: [],
			})),
		};
		const service = createServiceWithDefaultControl({
			createClient: () => client,
			bracketOrderStorageService: storage,
		});

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
			dryRun: false,
		}, { idempotencyKey: 'live-bracket-key' });

		expect(result).toMatchObject({ success: true, dryRun: false, orderList: { orderListId: 77 } });
		expect(storage.reserve).toHaveBeenCalledTimes(1);
		expect(client.submitNewOrderListOTOCO).toHaveBeenCalledTimes(1);
		expect(storage.reserve.mock.invocationCallOrder[0]).toBeLessThan(client.submitNewOrderListOTOCO.mock.invocationCallOrder[0]);
		expect(client.submitNewOrderListOTOCO).toHaveBeenCalledWith(expect.objectContaining({
			listClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
			workingClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
			pendingAboveClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
			pendingBelowClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
			workingType: 'LIMIT',
			pendingAboveType: 'LIMIT_MAKER',
			pendingBelowType: 'STOP_LOSS_LIMIT',
		}));
		expect(storage.recordOrderList).toHaveBeenCalledWith(expect.objectContaining({
			keyHash: 'b'.repeat(64),
			requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		}));
		expect(JSON.stringify(storage.recordOrderList.mock.calls[0])).not.toContain('live-bracket-key');
	});

	it('reconciles an existing bracket reservation and never submits it again', async () => {
		const storage = {
			getReservation: jest.fn().mockResolvedValue(null),
			reserve: jest.fn().mockImplementation(async (input) => ({
				outcome: 'existing',
				existingState: 'SUBMITTED',
				state: 'SUBMITTED',
				keyHash: 'c'.repeat(64),
				...input,
			})),
			recordOrderList: jest.fn().mockResolvedValue({}),
			updateReservation: jest.fn().mockResolvedValue({}),
		};
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			getOCO: jest.fn().mockImplementation(async ({ origClientOrderId }) => ({
				orderListId: 77,
				symbol: 'BTCUSDT',
				listClientOrderId: origClientOrderId,
				listOrderStatus: 'EXECUTING',
				orders: [],
				orderReports: [],
			})),
			submitNewOrderListOTOCO: jest.fn(),
		};
		const service = createServiceWithDefaultControl({
			createClient: () => client,
			bracketOrderStorageService: storage,
		});

		const result = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
			dryRun: false,
		}, { idempotencyKey: 'live-bracket-key' });

		expect(result).toMatchObject({ success: true, orderList: { orderListId: 77 } });
		expect(client.getOCO).toHaveBeenCalledWith({ origClientOrderId: storage.reserve.mock.calls[0][0].listClientOrderId });
		expect(client.submitNewOrderListOTOCO).not.toHaveBeenCalled();
	});

	it('rejects bracket idempotency replays that change provenance', async () => {
		let reservation = null;
		const storage = {
			getReservation: jest.fn(async () => reservation && { ...reservation }),
			reserve: jest.fn(async (input) => {
				reservation = {
					keyHash: 'e'.repeat(64),
					state: 'RESERVED',
					...input,
				};
				return { outcome: 'reserved', ...reservation };
			}),
			recordOrderList: jest.fn(async () => { reservation.state = 'SUBMITTED'; }),
			updateReservation: jest.fn().mockResolvedValue({}),
		};
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			submitNewOrderListOTOCO: jest.fn().mockImplementation(async (params) => ({
				orderListId: 88,
				symbol: params.symbol,
				listClientOrderId: params.listClientOrderId,
				listOrderStatus: 'EXECUTING',
				orders: [],
				orderReports: [],
			})),
			getOCO: jest.fn(),
		};
		const service = createServiceWithDefaultControl({
			createClient: () => client,
			bracketOrderStorageService: storage,
		});
		const request = {
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
			dryRun: false,
			origin: 'auto_trade',
			setupType: 'breakout',
		};

		await service.placeOrder(request, { idempotencyKey: 'bracket-provenance-key' });

		await expect(service.placeOrder({ ...request, origin: 'manual' }, { idempotencyKey: 'bracket-provenance-key' }))
			.rejects.toMatchObject({ code: 'BINANCE_ORDER_CONFLICT', statusCode: 409 });
		await expect(service.placeOrder({ ...request, setupType: 'pullback' }, { idempotencyKey: 'bracket-provenance-key' }))
			.rejects.toMatchObject({ code: 'BINANCE_ORDER_CONFLICT', statusCode: 409 });

		expect(client.getOCO).not.toHaveBeenCalled();
		expect(client.submitNewOrderListOTOCO).toHaveBeenCalledTimes(1);
	});

	it('reconciles legacy bracket reservations without changing stored provenance', async () => {
		const idempotencyKey = 'legacy-bracket-provenance-key';
		const request = {
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
			dryRun: false,
			origin: 'auto_trade',
			setupType: 'breakout',
		};
		const legacyFingerprint = crypto.createHash('sha256').update([
			request.symbol,
			request.side,
			request.type,
			request.quantity,
			request.price,
			request.stopPrice,
			request.stopLimitPrice,
			request.takeProfitPrice,
			request.timeInForce,
			request.alertId || '',
		].join(':')).digest('hex');
		const legacyListClientOrderId = `cb_${crypto.createHash('sha256')
			.update(`cabros-binance-bracket:${idempotencyKey}:${legacyFingerprint}:list`)
			.digest('hex')
			.slice(0, 32)}`;
		const storedRequest = {
			symbol: request.symbol,
			side: request.side,
			type: request.type,
			quantity: request.quantity,
			price: request.price,
			stopPrice: request.stopPrice,
			stopLimitPrice: request.stopLimitPrice,
			takeProfitPrice: request.takeProfitPrice,
			timeInForce: request.timeInForce,
			origin: request.origin,
			setupType: request.setupType,
		};
		const reservation = {
			keyHash: 'd'.repeat(64),
			requestFingerprint: legacyFingerprint,
			listClientOrderId: legacyListClientOrderId,
			symbol: request.symbol,
			environment: 'testnet',
			state: 'SUBMITTED',
		};
		const orderList = {
			orderListId: 90,
			symbol: request.symbol,
			listClientOrderId: legacyListClientOrderId,
			listOrderStatus: 'EXECUTING',
			orders: [],
			orderReports: [],
		};
		const storage = {
			getReservation: jest.fn(async () => ({ ...reservation })),
			getBracketOrder: jest.fn().mockResolvedValue({ request: storedRequest }),
			recordOrderList: jest.fn().mockResolvedValue({ request: storedRequest }),
			updateReservation: jest.fn().mockResolvedValue({}),
		};
		const client = {
			getOCO: jest.fn().mockResolvedValue(orderList),
			submitNewOrderListOTOCO: jest.fn(),
		};
		const service = createServiceWithDefaultControl({
			createClient: () => client,
			bracketOrderStorageService: storage,
		});

		await expect(service.placeOrder(request, { idempotencyKey })).resolves.toMatchObject({
			success: true,
			origin: 'auto_trade',
			setupType: 'breakout',
		});
		expect(client.getOCO).toHaveBeenCalledWith({ origClientOrderId: legacyListClientOrderId });
		expect(storage.recordOrderList).toHaveBeenCalledWith(expect.objectContaining({
			request: storedRequest,
			requestFingerprint: legacyFingerprint,
		}));

		await expect(service.placeOrder({ ...request, origin: 'manual' }, { idempotencyKey }))
			.rejects.toMatchObject({ code: 'BINANCE_ORDER_CONFLICT', statusCode: 409 });
		await expect(service.placeOrder({ ...request, setupType: 'pullback' }, { idempotencyKey }))
			.rejects.toMatchObject({ code: 'BINANCE_ORDER_CONFLICT', statusCode: 409 });

		storage.getBracketOrder.mockResolvedValue(null);
		const requestWithoutProvenance = { ...request };
		delete requestWithoutProvenance.origin;
		delete requestWithoutProvenance.setupType;
		await expect(service.placeOrder(requestWithoutProvenance, { idempotencyKey }))
			.rejects.toMatchObject({ code: 'BINANCE_ORDER_CONFLICT', statusCode: 409 });
		expect(client.getOCO).toHaveBeenCalledTimes(1);
		expect(client.submitNewOrderListOTOCO).not.toHaveBeenCalled();
	});

	it('allows existing non-GTC bracket reservations to be reconciled while rejecting new submissions', async () => {
		const idempotencyKey = 'legacy-ioc-bracket-key';
		const request = {
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'IOC',
			dryRun: false,
		};
		const legacyFingerprint = crypto.createHash('sha256').update([
			request.symbol,
			request.side,
			request.type,
			request.quantity,
			request.price,
			request.stopPrice,
			request.stopLimitPrice,
			request.takeProfitPrice,
			request.timeInForce,
			'',
		].join(':')).digest('hex');
		const legacyListClientOrderId = `cb_${crypto.createHash('sha256')
			.update(`cabros-binance-bracket:${idempotencyKey}:${legacyFingerprint}:list`)
			.digest('hex')
			.slice(0, 32)}`;
		const storedRequest = {
			symbol: request.symbol,
			side: request.side,
			type: request.type,
			quantity: request.quantity,
			price: request.price,
			stopPrice: request.stopPrice,
			stopLimitPrice: request.stopLimitPrice,
			takeProfitPrice: request.takeProfitPrice,
			timeInForce: request.timeInForce,
		};
		const reservation = {
			keyHash: 'f'.repeat(64),
			requestFingerprint: legacyFingerprint,
			listClientOrderId: legacyListClientOrderId,
			symbol: request.symbol,
			environment: 'testnet',
			state: 'SUBMITTED',
		};
		const orderList = {
			orderListId: 91,
			symbol: request.symbol,
			listClientOrderId: legacyListClientOrderId,
			listOrderStatus: 'EXECUTING',
			orders: [],
			orderReports: [],
		};
		const storage = {
			getReservation: jest.fn()
				.mockResolvedValueOnce(null)
				.mockResolvedValue({ ...reservation }),
			getBracketOrder: jest.fn().mockResolvedValue({ request: storedRequest }),
			recordOrderList: jest.fn().mockResolvedValue({ request: storedRequest }),
			updateReservation: jest.fn().mockResolvedValue({}),
		};
		const client = {
			getOCO: jest.fn().mockResolvedValue(orderList),
			submitNewOrderListOTOCO: jest.fn(),
		};
		const createClient = jest.fn(() => client);
		const service = createServiceWithDefaultControl({
			createClient,
			bracketOrderStorageService: storage,
		});

		// 1. Without reservation: rejected before client initialization or submission
		await expect(service.placeOrder(request, { idempotencyKey })).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			statusCode: 400,
			message: expect.stringContaining('GTC'),
		});
		expect(createClient).not.toHaveBeenCalled();
		expect(client.getOCO).not.toHaveBeenCalled();
		expect(client.submitNewOrderListOTOCO).not.toHaveBeenCalled();

		// 2. With matching existing reservation: successfully reconciled
		await expect(service.placeOrder(request, { idempotencyKey })).resolves.toMatchObject({
			success: true,
			dryRun: false,
			orderList: expect.objectContaining({ orderListId: 91 }),
		});
		expect(createClient).toHaveBeenCalledTimes(1);
		expect(client.getOCO).toHaveBeenCalledWith({ origClientOrderId: legacyListClientOrderId });
		expect(client.submitNewOrderListOTOCO).not.toHaveBeenCalled();
	});

	it('allows a bracket idempotency key to retry after the kill switch blocks pre-submit', async () => {
		let reservation = null;
		let pauseChecks = 0;
		const storage = {
			getReservation: jest.fn(async () => reservation && { ...reservation }),
			reserve: jest.fn(async (input) => {
				if (reservation?.state === 'ABORTED_BEFORE_SUBMIT') {
					reservation.state = 'RESERVED';
					reservation.updatedAt = new Date();
					return { outcome: 'reserved', ...reservation };
				}
				reservation = {
					keyHash: 'f'.repeat(64),
					state: 'RESERVED',
					...input,
				};
				return { outcome: 'reserved', ...reservation };
			}),
			recordOrderList: jest.fn(async () => { reservation.state = 'SUBMITTED'; }),
			updateReservation: jest.fn(async ({ state }) => {
				reservation.state = state;
				return { state };
			}),
		};
		const controlService = {
			async getPauseState() {
				pauseChecks += 1;
				const paused = pauseChecks === 3;
				return {
					paused,
					unavailable: false,
					isBlocked() { return this.paused; },
				};
			},
		};
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			submitNewOrderListOTOCO: jest.fn().mockImplementation(async (params) => ({
				orderListId: 89,
				symbol: params.symbol,
				listClientOrderId: params.listClientOrderId,
				listOrderStatus: 'EXECUTING',
				orders: [],
				orderReports: [],
			})),
		};
		const service = createBinanceOrderService({
			createClient: () => client,
			controlService,
			bracketOrderStorageService: storage,
		});
		const request = {
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
			dryRun: false,
		};

		await expect(service.placeOrder(request, { idempotencyKey: 'retry-blocked-bracket' }))
			.rejects.toMatchObject({ code: 'TRADING_PAUSED', statusCode: 503 });
		expect(reservation.state).toBe('ABORTED_BEFORE_SUBMIT');
		expect(client.submitNewOrderListOTOCO).not.toHaveBeenCalled();

		await expect(service.placeOrder(request, { idempotencyKey: 'retry-blocked-bracket' }))
			.resolves.toMatchObject({ success: true, orderList: { orderListId: 89 } });

		expect(client.submitNewOrderListOTOCO).toHaveBeenCalledTimes(1);
	});

	it('reconciles an existing bracket before applying changed symbol and notional gates', async () => {
		let reservation = null;
		let existingOrderList = null;
		const storage = {
			getReservation: jest.fn(async () => reservation),
			reserve: jest.fn().mockImplementation(async (input) => {
				reservation = {
					keyHash: 'd'.repeat(64),
					requestFingerprint: input.requestFingerprint,
					listClientOrderId: input.listClientOrderId,
					symbol: input.symbol,
					environment: input.environment,
					state: 'RESERVED',
				};
				return { outcome: 'reserved', ...reservation };
			}),
			recordOrderList: jest.fn().mockImplementation(async ({ orderList }) => {
				existingOrderList = orderList;
				reservation.state = 'SUBMITTED';
			}),
			updateReservation: jest.fn().mockResolvedValue({}),
		};
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			submitNewOrderListOTOCO: jest.fn().mockImplementation(async (params) => ({
				orderListId: 78,
				symbol: params.symbol,
				listClientOrderId: params.listClientOrderId,
				listOrderStatus: 'EXECUTING',
				orders: [],
				orderReports: [],
			})),
			getOCO: jest.fn(async () => existingOrderList),
		};
		const service = createServiceWithDefaultControl({
			createClient: () => client,
			bracketOrderStorageService: storage,
		});
		const request = {
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
			dryRun: false,
		};

		await service.placeOrder(request, { idempotencyKey: 'changed-gates-bracket' });
		process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'ETHUSDT';
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '1';

		await expect(service.placeOrder(request, { idempotencyKey: 'changed-gates-bracket' }))
			.resolves.toMatchObject({ success: true, dryRun: false, orderList: { orderListId: 78 } });

		expect(storage.getReservation).toHaveBeenCalledTimes(2);
		expect(storage.reserve).toHaveBeenCalledTimes(1);
		expect(client.getExchangeInfo).toHaveBeenCalledTimes(1);
		expect(client.getOCO).toHaveBeenCalledTimes(1);
		expect(client.submitNewOrderListOTOCO).toHaveBeenCalledTimes(1);
	});

	it('fails closed before OTOCO submission when durable reservation storage is unavailable', async () => {
		const storage = {
			getReservation: jest.fn().mockResolvedValue(null),
			reserve: jest.fn().mockRejectedValue(Object.assign(new Error('firestore unavailable'), { code: 'STORAGE_UNAVAILABLE' })),
		};
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['LIMIT', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT'],
			})),
			submitNewOrderListOTOCO: jest.fn(),
		};
		const service = createServiceWithDefaultControl({
			createClient: () => client,
			bracketOrderStorageService: storage,
		});

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'BRACKET_LIMIT',
			quantity: '0.2',
			price: '100',
			stopPrice: '90',
			stopLimitPrice: '89',
			takeProfitPrice: '110',
			timeInForce: 'GTC',
			dryRun: false,
		}, { idempotencyKey: 'live-bracket-key' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', statusCode: 503 });

		expect(client.submitNewOrderListOTOCO).not.toHaveBeenCalled();
	});

	it('rejects the Futures-only trailing stop order name', async () => {
		const service = createServiceWithDefaultControl({ createClient: jest.fn() });
		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'TRAILING_STOP_MARKET',
			quantity: '0.1',
		})).rejects.toThrow('type');
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

	it('includes a contingent market BUY trigger price in configured notional validation', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '200';
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({ orderTypes: ['STOP_LOSS'] })),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'STOP_LOSS',
			quantity: '1',
			stopPrice: '1000',
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			message: expect.stringContaining('configured maximum'),
		});

		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('fails closed for a contingent market BUY with no fixed trigger-price bound', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '200';
		const client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
				orderTypes: ['STOP_LOSS'],
				filters: [
					{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
					{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
					{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
					{ filterType: 'TRAILING_DELTA', minTrailingAboveDelta: 10, maxTrailingAboveDelta: 500, minTrailingBelowDelta: 10, maxTrailingBelowDelta: 500 },
				],
			})),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'STOP_LOSS',
			quantity: '1',
			trailingDelta: 100,
			dryRun: true,
		})).rejects.toMatchObject({
			code: 'INVALID_ORDER_REQUEST',
			message: expect.stringContaining('stopPrice'),
		});

		expect(client.submitNewOrder).not.toHaveBeenCalled();
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

	it.each([
		['MARKET', { quantity: '0.1' }, undefined],
		['LIMIT', { quantity: '0.1', price: '100', timeInForce: 'GTC' }, '100'],
	])('preserves the deployed client-order identity for %s retries', async (type, fields, price) => {
		const idempotencyKey = `legacy-${type.toLowerCase()}-key`;
		const fingerprint = [
			'BTCUSDT',
			'SELL',
			type,
			fields.quantity,
			'',
			price ?? '',
			fields.timeInForce ?? '',
		].join(':');
		const expectedClientOrderId = `cb_${crypto.createHash('sha256')
			.update(`cabros-binance-order:${idempotencyKey}:${fingerprint}`)
			.digest('hex')
			.slice(0, 32)}`;
		const client = {
			getOrder: jest.fn().mockResolvedValue(null),
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
			submitNewOrder: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', status: 'NEW' }),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type,
			...fields,
			dryRun: false,
		}, { idempotencyKey });

		expect(client.getOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', origClientOrderId: expectedClientOrderId });
		expect(client.submitNewOrder).toHaveBeenCalledWith(expect.objectContaining({ newClientOrderId: expectedClientOrderId }));
	});

	it('reconciles LIMIT_MAKER orders without requiring an explicit time-in-force', async () => {
		const client = {
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 101,
				clientOrderId: 'existing-maker-order',
				status: 'NEW',
				side: 'BUY',
				type: 'LIMIT_MAKER',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			}),
			getExchangeInfo: jest.fn(),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT_MAKER',
			quantity: '0.1',
			price: '100',
			clientOrderId: 'existing-maker-order',
			dryRun: false,
		})).resolves.toMatchObject({ success: true, order: { orderId: 101, type: 'LIMIT_MAKER' } });

		expect(client.submitNewOrder).not.toHaveBeenCalled();
		expect(client.getExchangeInfo).not.toHaveBeenCalled();
	});

	it.each([
		['trailingDelta', { stopPrice: '90.00000000', trailingDelta: 100 }, { stopPrice: '90' }],
		['stopPrice', { stopPrice: '90.00000000', trailingDelta: 100 }, { trailingDelta: 100 }],
	])('rejects reconciliation when the retry omits existing %s', async (_field, existingFields, requestFields) => {
		const client = {
			getOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 102,
				clientOrderId: 'existing-trailing-stop',
				status: 'NEW',
				side: 'SELL',
				type: 'STOP_LOSS',
				...existingFields,
				origQty: '0.1',
			}),
			getExchangeInfo: jest.fn(),
			submitNewOrder: jest.fn(),
		};
		const service = createServiceWithDefaultControl({ createClient: () => client });

		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'STOP_LOSS',
			quantity: '0.1',
			...requestFields,
			clientOrderId: 'existing-trailing-stop',
			dryRun: false,
		})).rejects.toMatchObject({ code: 'BINANCE_ORDER_CONFLICT', statusCode: 409 });

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

	it('preserves bound provenance when an order is reconciled without or with matching provenance', async () => {
		const client = {
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
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		// First: bind initial order with provenance
		const first = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
			origin: 'auto_trade',
			alertId: 'alert-initial',
			setupType: 'breakout',
		}, { idempotencyKey: 'prov-test-key' });

		expect(first.origin).toBe('auto_trade');
		expect(first.alertId).toBe('alert-initial');
		expect(first.setupType).toBe('breakout');

		// Second: retry with matching or omitted provenance preserves initial values
		const second = await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		}, { idempotencyKey: 'prov-test-key' });

		expect(second.origin).toBe('auto_trade');
		expect(second.alertId).toBe('alert-initial');
		expect(second.setupType).toBe('breakout');
	});

	it('rejects reconciled order when incoming provenance conflicts with bound provenance', async () => {
		const client = {
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
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			submitNewOrder: jest.fn(),
		};
		const service = createBinanceOrderService({ createClient: () => client });

		// First: bind initial order
		await service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
		}, { idempotencyKey: 'prov-conflict-key' });

		// Retry with different origin
		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
			origin: 'manual',
			alertId: 'alert-1',
			setupType: 'breakout',
		}, { idempotencyKey: 'prov-conflict-key' })).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
		});

		// Retry with different alertId
		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
			origin: 'auto_trade',
			alertId: 'different-alert',
			setupType: 'breakout',
		}, { idempotencyKey: 'prov-conflict-key' })).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
		});

		// Retry with different setupType
		await expect(service.placeOrder({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'pullback',
		}, { idempotencyKey: 'prov-conflict-key' })).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
		});
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

	describe('demo environment', () => {
		function configureDemoTrading() {
			process.env.ENABLE_BINANCE_TRADING = 'true';
			process.env.BINANCE_API_KEY = 'test-api-key';
			process.env.BINANCE_API_SECRET = 'test-api-secret';
			process.env.BINANCE_TRADING_ENV = 'demo';
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
		}

		it('getStatus reports environment demo and configured:true', () => {
			configureDemoTrading();
			const service = createBinanceOrderService({ createClient: jest.fn() });
			const status = service.getStatus();
			expect(status.environment).toBe('demo');
			expect(status.configured).toBe(true);
			expect(status.ready).toBe(true);
			expect(status.status).toBe('ready');
		});

		it('getStatus reports configured:false when credentials are missing in demo env', () => {
			configureDemoTrading();
			delete process.env.BINANCE_API_KEY;
			const service = createBinanceOrderService({ createClient: jest.fn() });
			const status = service.getStatus();
			expect(status.environment).toBe('demo');
			expect(status.configured).toBe(false);
			expect(status.ready).toBe(false);
		});

		it('routes MainClient baseUrl to demo-api.binance.com when env is demo', async () => {
			configureDemoTrading();
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
				idempotencyKey: 'idem-demo-env',
				dryRun: false,
			});

			expect(MainClient).toHaveBeenCalledWith(expect.objectContaining({
				baseUrl: 'https://demo-api.binance.com',
			}), expect.any(Object));
		});

		it('does not use BINANCE_DATA_BASE_URL for the demo environment', async () => {
			configureDemoTrading();
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
				idempotencyKey: 'idem-demo-no-custom-url',
				dryRun: false,
			});

			// demo always uses https://demo-api.binance.com; BINANCE_DATA_BASE_URL only applies to live
			expect(MainClient).toHaveBeenCalledWith(expect.objectContaining({
				baseUrl: 'https://demo-api.binance.com',
			}), expect.any(Object));
		});

		it('placeOrder dry-run in demo env returns environment:demo', async () => {
			configureDemoTrading();
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.1',
				price: '100',
			});

			expect(result).toMatchObject({
				success: true,
				dryRun: true,
				environment: 'demo',
			});
			expect(client.getExchangeInfo).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
		});

		it('getOrders returns environment:demo in response', async () => {
			configureDemoTrading();
			const client = {
				allOrders: jest.fn().mockResolvedValue([]),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.getOrders({ symbol: 'BTCUSDT' });
			expect(result).toMatchObject({
				success: true,
				environment: 'demo',
				orders: [],
				count: 0,
			});
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

		it('hydrates component orderReports when querying orderList without pre-existing reports', async () => {
			const client = {
				getOCO: jest.fn().mockResolvedValue({
					orderListId: 55,
					symbol: 'BTCUSDT',
					listClientOrderId: 'cb-list-55',
					listOrderStatus: 'ALL_DONE',
					orders: [
						{ symbol: 'BTCUSDT', orderId: 201, clientOrderId: 'cb-work-55' },
						{ symbol: 'BTCUSDT', orderId: 202, clientOrderId: 'cb-tp-55' },
					],
				}),
				getOrder: jest.fn().mockImplementation(async ({ origClientOrderId }) => ({
					symbol: 'BTCUSDT',
					orderId: origClientOrderId === 'cb-work-55' ? 201 : 202,
					clientOrderId: origClientOrderId,
					status: 'FILLED',
					executedQty: '0.1',
					side: origClientOrderId === 'cb-work-55' ? 'BUY' : 'SELL',
					type: 'LIMIT',
					price: origClientOrderId === 'cb-work-55' ? '60000' : '65000',
				})),
				getAccountTradeList: jest.fn().mockResolvedValue([
					{ price: '60000', qty: '0.1', commission: '0.0001', commissionAsset: 'BNB', time: 1000 },
				]),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			const result = await service.getOrders({ symbol: 'BTCUSDT', orderListId: 55 });
			expect(result.orderList.orderReports).toHaveLength(2);
			expect(result.orderList.orderReports[0]).toMatchObject({
				orderId: 201,
				status: 'FILLED',
				fills: expect.any(Array),
			});
		});

		it('recovers stored bracket request provenance on getOrders query', async () => {
			const client = {
				getOCO: jest.fn().mockResolvedValue({
					orderListId: 55,
					symbol: 'BTCUSDT',
					listClientOrderId: 'cb-list-55',
					orders: [],
					orderReports: [],
				}),
			};
			const bracketStorage = {
				recordOrderList: jest.fn().mockResolvedValue({
					orderListId: 55,
					terminal: false,
					request: {
						origin: 'admin_alert',
						alertId: 'alert-provenance-1',
						setupType: 'breakout',
					},
				}),
			};
			const service = createServiceWithDefaultControl({
				createClient: () => client,
				bracketOrderStorageService: bracketStorage,
			});

			const result = await service.getOrders({ symbol: 'BTCUSDT', orderListId: 55 });
			expect(result).toMatchObject({
				success: true,
				origin: 'admin_alert',
				alertId: 'alert-provenance-1',
				setupType: 'breakout',
			});
		});

		it('preserves ORDER_LIST_NOT_FOUND (404) when returned order list belongs to a different symbol', async () => {
			const client = {
				getOCO: jest.fn().mockResolvedValue({
					orderListId: 55,
					symbol: 'ETHUSDT',
					listClientOrderId: 'cb-list-55',
				}),
			};
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT,ETHUSDT';
			const service = createServiceWithDefaultControl({ createClient: () => client });

			await expect(service.getOrders({ symbol: 'BTCUSDT', orderListId: 55 })).rejects.toMatchObject({
				code: 'ORDER_LIST_NOT_FOUND',
				statusCode: 404,
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

	describe('cancelOrder', () => {
		it('rejects disabled trading before constructing a Binance client', async () => {
			delete process.env.ENABLE_BINANCE_TRADING;
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
			})).rejects.toMatchObject({ code: 'FEATURE_DISABLED', statusCode: 403 });

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects misconfigured trading before constructing a Binance client', async () => {
			delete process.env.BINANCE_TRADING_MAX_NOTIONAL;
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
			})).rejects.toMatchObject({ code: 'BINANCE_TRADING_UNAVAILABLE', statusCode: 503 });

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects symbols outside the allow-list before touching Binance', async () => {
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.cancelOrder({
				symbol: 'ETHUSDT',
				orderId: 42,
			})).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				statusCode: 400,
			});

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects missing symbol before touching Binance', async () => {
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.cancelOrder({
				orderId: 42,
			})).rejects.toMatchObject({ code: 'INVALID_ORDER_REQUEST', statusCode: 400 });

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects ambiguous bodies missing both orderId and origClientOrderId', async () => {
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
			})).rejects.toMatchObject({ code: 'INVALID_ORDER_REQUEST', statusCode: 400 });

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects bodies that supply both orderId and origClientOrderId', async () => {
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
				origClientOrderId: 'cabros-574-1',
			})).rejects.toMatchObject({ code: 'INVALID_ORDER_REQUEST', statusCode: 400 });

			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects unknown body fields before touching Binance', async () => {
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
				quantity: 0.5,
			})).rejects.toMatchObject({ code: 'INVALID_ORDER_REQUEST', statusCode: 400 });

			expect(createClient).not.toHaveBeenCalled();
		});

		it('cancels a resting order by orderId and returns a sanitized response', async () => {
			const client = {
				cancelOrder: jest.fn().mockResolvedValue({
					symbol: 'BTCUSDT',
					orderId: 42,
					clientOrderId: 'cabros-574-1',
					status: 'CANCELED',
					type: 'LIMIT',
					side: 'SELL',
					origQty: '0.1',
					executedQty: '0',
					price: '60000.00',
					secret: 'must-not-leak',
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
			});

			expect(client.cancelOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', orderId: 42 });
			expect(result).toEqual({
				success: true,
				environment: 'testnet',
				cancelled: true,
				order: {
					symbol: 'BTCUSDT',
					orderId: 42,
					clientOrderId: 'cabros-574-1',
					status: 'CANCELED',
					type: 'LIMIT',
					side: 'SELL',
					origQty: '0.1',
					executedQty: '0',
					price: '60000.00',
				},
			});
			expect(result.order.secret).toBeUndefined();
		});

		it('cancels a resting order by origClientOrderId', async () => {
			const client = {
				cancelOrder: jest.fn().mockResolvedValue({
					symbol: 'BTCUSDT',
					orderId: 99,
					clientOrderId: 'cabros-574-2',
					status: 'CANCELED',
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.cancelOrder({
				symbol: 'BTCUSDT',
				origClientOrderId: 'cabros-574-2',
			});

			expect(client.cancelOrder).toHaveBeenCalledWith({
				symbol: 'BTCUSDT',
				origClientOrderId: 'cabros-574-2',
			});
			expect(result.order.clientOrderId).toBe('cabros-574-2');
			expect(result.cancelled).toBe(true);
		});

		it('maps the Binance -2011 already-terminal error to ORDER_NOT_FOUND (404)', async () => {
			const client = {
				cancelOrder: jest.fn().mockRejectedValue({
					code: -2011,
					message: 'Unknown order sent.',
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
			})).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', statusCode: 404 });
		});

		it('maps the Binance -2013 unknown order error to ORDER_NOT_FOUND (404)', async () => {
			const client = {
				cancelOrder: jest.fn().mockRejectedValue({
					code: -2013,
					message: 'Unknown order sent.',
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				origClientOrderId: 'cabros-574-3',
			})).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', statusCode: 404 });
		});

		it('maps a definitive Binance rejection to BINANCE_REQUEST_REJECTED (400)', async () => {
			const client = {
				cancelOrder: jest.fn().mockRejectedValue({
					code: -1015,
					message: 'Too many requests',
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
			})).rejects.toMatchObject({ code: 'BINANCE_REQUEST_REJECTED', statusCode: 400 });
		});

		it('maps a transient provider failure to BINANCE_QUERY_FAILED (502)', async () => {
			const client = {
				cancelOrder: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.cancelOrder({
				symbol: 'BTCUSDT',
				orderId: 42,
			})).rejects.toMatchObject({ code: 'BINANCE_QUERY_FAILED', statusCode: 502 });
		});
	});

	describe('previewOrder', () => {
		it('rejects preview when Binance trading is disabled', async () => {
			delete process.env.ENABLE_BINANCE_TRADING;
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.01',
			})).rejects.toMatchObject({ code: 'FEATURE_DISABLED', statusCode: 403 });

			expect(createClient).not.toHaveBeenCalled();
		});

		it('returns a MARKET preview with adjusted notional, fees, and slippage budget flags', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
				depth: jest.fn().mockResolvedValue({
					asks: [
						['100.10', '5'],
						['100.50', '10'],
					],
					limit: 20,
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.1',
				maxSlippageBps: 75,
			});

			expect(result.success).toBe(true);
			expect(result.preview).toBe(true);
			expect(result.environment).toBe('testnet');
			expect(result.order).toMatchObject({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
			});
			expect(result.adjustedQuantity).toBe('0.1');
			expect(result.adjustedNotional).toBe('10');
			expect(result.effectivePriceEstimate).toBe('100');
			expect(result.priceSource).toBe('avgPrice');
			expect(result.feeEstimate.appliedFeeBps).toBe(10);
			expect(result.feeEstimate.estimatedFeeQuote).toBe('0.01');
			expect(result.flags.minNotionalOk).toBe(true);
			expect(result.flags.maxNotionalOk).toBe(true);
			expect(result.depthSnapshot.available).toBe(true);
			expect(result.slippage).not.toBeNull();
			expect(result.slippage.slippageBudgetBps).toBe(75);
			expect(result.slippage.wouldExceedBudget).toBe(false);
			expect(result.expiresAt).toMatch(/T/);
			expect(typeof result.previewFingerprint).toBe('string');
			expect(result.previewFingerprint.length).toBeGreaterThan(16);
		});

		it('flags min-notional violations and rejects fee math when order is below floor', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '50' }),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.1',
			});

			expect(result.flags.minNotionalOk).toBe(false);
			expect(result.flags.minNotionalExceededReason).toBe('below Binance minimum');
			expect(result.adjustedNotional).toBe('5');
			expect(result.depthSnapshot.available).toBe(false);
		});

		it('rejects the preview when the order notional exceeds the configured maximum', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '5000' }),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.5',
			})).rejects.toMatchObject({ code: 'MAX_NOTIONAL_EXCEEDED', statusCode: 403 });
		});

		it('returns 400 LOT_SIZE rejection with the suggested adjustedQuantity when stepSize is violated', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.12345',
				price: '100',
				timeInForce: 'GTC',
			})).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				statusCode: 400,
				message: expect.stringContaining('0.1234'),
			});
		});

		it('reports wouldExceedBudget:true when the depth fill exceeds maxSlippageBps', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
				depth: jest.fn().mockResolvedValue({
					asks: [
						['120', '10'],
					],
					limit: 20,
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.1',
				maxSlippageBps: 50,
			});

			expect(result.slippage).not.toBeNull();
			expect(result.slippage.wouldExceedBudget).toBe(true);
			expect(result.slippage.slippageBudgetBps).toBe(50);
			expect(result.adjustedNotional).toBe('10');
		});

		it('keeps slippage=null and does not block when the depth probe fails', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
				depth: jest.fn().mockRejectedValue(new Error('depth timeout')),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.1',
				maxSlippageBps: 50,
			});

			expect(result.depthSnapshot.available).toBe(false);
			expect(result.depthSnapshot.error).toMatch(/depth/i);
			expect(result.slippage).toBeNull();
			expect(result.adjustedNotional).toBe('10');
		});

		it('rejects an invalid maxSlippageBps value', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.1',
				maxSlippageBps: 0,
			})).rejects.toMatchObject({ code: 'INVALID_ORDER_REQUEST', statusCode: 400 });
		});

		it('rejects contingent orders outside the preview contract before querying Binance', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo({
					orderTypes: ['MARKET', 'LIMIT', 'STOP_LOSS_LIMIT'],
				})),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
			};
			const service = createServiceWithDefaultControl({ createClient: () => client });

			await expect(service.previewOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'STOP_LOSS_LIMIT',
				quantity: '0.1',
				price: '89',
				stopPrice: '90',
				timeInForce: 'GTC',
			})).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				statusCode: 400,
				message: expect.stringContaining('MARKET and LIMIT'),
			});

			expect(client.getExchangeInfo).not.toHaveBeenCalled();
			expect(client.getAvgPrice).not.toHaveBeenCalled();
		});
	});

	describe('asset derivation', () => {
		it('derives unique sorted assets from comma-separated allowed symbols', () => {
			expect(deriveAllowedAssets('BTCUSDT,ETHBTC,SOLUSDC,BTCFDUSD')).toEqual([
				'BTC',
				'ETH',
				'FDUSD',
				'SOL',
				'USDC',
				'USDT',
			]);
		});

		it('handles whitespace, duplicates, and empty strings gracefully', () => {
			expect(deriveAllowedAssets(' BTCUSDT , ETHBTC , BTCUSDT ')).toEqual([
				'BTC',
				'ETH',
				'USDT',
			]);
			expect(deriveAllowedAssets('')).toEqual([]);
			expect(deriveAllowedAssets(null)).toEqual([]);
		});

		it('derives base and quote assets from symbol correctly', () => {
			expect(deriveSymbolAssets('BTCUSDT')).toEqual({ baseAsset: 'BTC', quoteAsset: 'USDT' });
			expect(deriveSymbolAssets('ETHBTC')).toEqual({ baseAsset: 'ETH', quoteAsset: 'BTC' });
			expect(deriveSymbolAssets('PEPEEUR')).toEqual({ baseAsset: 'PEPE', quoteAsset: 'EUR' });
			expect(deriveSymbolAssets('UNKNOWN')).toEqual({ baseAsset: 'UNKNOWN', quoteAsset: null });
			expect(deriveSymbolAssets('')).toEqual({ baseAsset: '', quoteAsset: null });
		});
	});

	describe('sellableQuantity', () => {
		it('floors requested quantity to the LOT_SIZE stepSize', () => {
			const res = sellableQuantity({
				symbol: 'BTCUSDT',
				requestedQuantity: '0.12349',
				freeBalance: '1.0',
				stepSize: '0.0001',
			});

			expect(res.quantity).toBe('0.1234');
			expect(String(res)).toBe('0.1234');
			expect(res.adjusted).toBe(true);
			expect(res.requestedQuantity).toBe('0.12349');
			expect(res.freeBalance).toBe('1.0');
		});

		it('clamps requested quantity to available free balance and excludes locked funds', () => {
			const res = sellableQuantity({
				symbol: 'BTCUSDT',
				requestedQuantity: '5.0',
				freeBalance: '2.54321',
				lockedBalance: '10.0',
				stepSize: '0.0001',
			});

			expect(res.quantity).toBe('2.5432');
			expect(res.freeBalance).toBe('2.54321');
			expect(res.lockedBalance).toBe('10.0');
			expect(res.clampedToBalance).toBe(true);
			expect(res.adjusted).toBe(true);
		});

		it('defaults to full sellable free balance when requested quantity is omitted', () => {
			const res = sellableQuantity({
				symbol: 'BTCUSDT',
				freeBalance: '3.14159',
				stepSize: '0.01',
			});

			expect(res.quantity).toBe('3.14');
			expect(res.clampedToBalance).toBe(false);
		});

		it('handles zero free balance', () => {
			const res = sellableQuantity({
				symbol: 'BTCUSDT',
				requestedQuantity: '1.0',
				freeBalance: '0',
				stepSize: '0.001',
				minQty: '0.001',
			});

			expect(res.quantity).toBe('0');
			expect(res.reason).toBe('ZERO_BALANCE');
			expect(res.belowMinQty).toBe(false);
			expect(res.belowMinNotional).toBe(false);
		});

		it('flags belowMinQty when quantity is below minQty', () => {
			const res = sellableQuantity({
				symbol: 'BTCUSDT',
				requestedQuantity: '0.0005',
				freeBalance: '1.0',
				stepSize: '0.0001',
				minQty: '0.001',
			});

			expect(res.quantity).toBe('0.0005');
			expect(res.belowMinQty).toBe(true);
		});

		it('flags belowMinNotional when notional value is below minNotional', () => {
			const res = sellableQuantity({
				symbol: 'BTCUSDT',
				requestedQuantity: '0.0001',
				freeBalance: '1.0',
				stepSize: '0.0001',
				minNotional: '10',
				price: '50000', // notional = 5 < 10
			});

			expect(res.quantity).toBe('0.0001');
			expect(res.estimatedNotional).toBe('5');
			expect(res.belowMinNotional).toBe(true);
		});

		it('flags exceedsMaxQty when floored quantity exceeds maxQty', () => {
			const res = sellableQuantity({
				symbol: 'BTCUSDT',
				requestedQuantity: '200',
				freeBalance: '500',
				stepSize: '1',
				maxQty: '100',
			});

			expect(res.quantity).toBe('100');
			expect(res.exceedsMaxQty).toBe(true);
		});

		it('supports 3-argument signature (symbol, requestedQuantity, options)', () => {
			const res = sellableQuantity('BTCUSDT', '0.5555', {
				freeBalance: '2.0',
				stepSize: '0.01',
			});

			expect(res.symbol).toBe('BTCUSDT');
			expect(res.quantity).toBe('0.55');
		});
	});

	describe('getBalances', () => {
		it('rejects disabled trading before constructing a Binance client', async () => {
			delete process.env.ENABLE_BINANCE_TRADING;
			const createClient = jest.fn();
			const service = createBinanceOrderService({ createClient });

			await expect(service.getBalances()).rejects.toMatchObject({
				code: 'FEATURE_DISABLED',
				statusCode: 403,
			});
			expect(createClient).not.toHaveBeenCalled();
		});

		it('rejects unconfigured trading when credentials or symbols are missing', async () => {
			delete process.env.BINANCE_API_KEY;
			const service = createBinanceOrderService();

			await expect(service.getBalances()).rejects.toMatchObject({
				code: 'BINANCE_TRADING_UNAVAILABLE',
				statusCode: 503,
			});
		});

		it('queries Binance account and returns exact decimal strings for allowed assets only', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT,ETHBTC';
			const client = {
				getAccountInformation: jest.fn().mockResolvedValue({
					accountType: 'SPOT',
					permissions: ['SPOT'],
					makerCommission: 10,
					balances: [
						{ asset: 'BTC', free: '1.234567890123456789', locked: '0.000000000000000000' },
						{ asset: 'ETH', free: '10.500000000000000000', locked: '1.200000000000000000' },
						{ asset: 'USDT', free: '5000.123456789012345678', locked: '250.000000000000000000' },
						{ asset: 'XRP', free: '9999.0', locked: '0.0' },
						{ asset: 'DOGE', free: '1000.0', locked: '0.0' },
					],
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.getBalances();

			expect(result.environment).toBe('testnet');
			expect(result.cached).toBe(false);
			expect(Array.isArray(result.balances)).toBe(true);
			expect(result.balances).toHaveLength(3);
			expect(result.balances.map((b) => b.asset)).toEqual(['BTC', 'ETH', 'USDT']);
			expect(result.balances[0]).toEqual({
				asset: 'BTC',
				free: '1.234567890123456789',
				locked: '0.000000000000000000',
			});
			expect(result.accountType).toBeUndefined();
			expect(result.permissions).toBeUndefined();
			expect(result.makerCommission).toBeUndefined();
		});

		it('filters balances by single asset query parameter', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT,ETHBTC';
			const client = {
				getAccountInformation: jest.fn().mockResolvedValue({
					balances: [
						{ asset: 'BTC', free: '1.5', locked: '0.0' },
						{ asset: 'ETH', free: '10.0', locked: '0.0' },
						{ asset: 'USDT', free: '500.0', locked: '0.0' },
					],
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.getBalances({ asset: 'btc' });

			expect(result.balances).toHaveLength(1);
			expect(result.balances[0].asset).toBe('BTC');
		});

		it('rejects asset filter with 400 when asset is not in allowed assets', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			const client = { getAccountInformation: jest.fn() };
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.getBalances({ asset: 'SOL' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				statusCode: 400,
			});
			expect(client.getAccountInformation).not.toHaveBeenCalled();
		});

		it('filters balances by symbol query parameter (returns base and quote assets)', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT,ETHBTC';
			const client = {
				getAccountInformation: jest.fn().mockResolvedValue({
					balances: [
						{ asset: 'BTC', free: '1.5', locked: '0.0' },
						{ asset: 'ETH', free: '10.0', locked: '0.0' },
						{ asset: 'USDT', free: '500.0', locked: '0.0' },
					],
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.getBalances({ symbol: 'btcusdt' });

			expect(result.balances).toHaveLength(2);
			expect(result.balances.map((b) => b.asset)).toEqual(['BTC', 'USDT']);
		});

		it('rejects symbol filter with 400 when symbol is not in allowed symbols', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			const client = { getAccountInformation: jest.fn() };
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.getBalances({ symbol: 'DOGEUSDT' })).rejects.toMatchObject({
				code: 'INVALID_ORDER_REQUEST',
				statusCode: 400,
			});
			expect(client.getAccountInformation).not.toHaveBeenCalled();
		});

		it('uses in-memory cache within TTL and bypasses cache when refresh=true', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			const client = {
				getAccountInformation: jest.fn().mockResolvedValue({
					balances: [
						{ asset: 'BTC', free: '2.0', locked: '0.1' },
						{ asset: 'USDT', free: '1000.0', locked: '50.0' },
					],
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const first = await service.getBalances();
			expect(first.cached).toBe(false);
			expect(client.getAccountInformation).toHaveBeenCalledTimes(1);

			const second = await service.getBalances();
			expect(second.cached).toBe(true);
			expect(client.getAccountInformation).toHaveBeenCalledTimes(1);
			expect(second.balances).toEqual(first.balances);

			const third = await service.getBalances({ refresh: true });
			expect(third.cached).toBe(false);
			expect(client.getAccountInformation).toHaveBeenCalledTimes(2);
		});

		it('maps provider errors or timeouts to 502 BINANCE_BALANCE_QUERY_FAILED', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			const client = {
				getAccountInformation: jest.fn().mockRejectedValue(new Error('Network timeout')),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			await expect(service.getBalances()).rejects.toMatchObject({
				code: 'BINANCE_BALANCE_QUERY_FAILED',
				statusCode: 502,
			});
		});

		it('honours the Remote Config BINANCE_BALANCE_CACHE_MS override for the cache TTL', async () => {
			process.env.BINANCE_TRADING_ALLOWED_SYMBOLS = 'BTCUSDT';
			delete process.env.BINANCE_BALANCE_CACHE_MS;
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';

			const client = {
				getAccountInformation: jest.fn().mockResolvedValue({
					balances: [
						{ asset: 'BTC', free: '2.0', locked: '0.1' },
						{ asset: 'USDT', free: '1000.0', locked: '50.0' },
					],
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const base = 1_800_000_000_000;
			const envDefaultTtlMs = 3000;
			const remoteOverrideTtlMs = 45000;
			const pastDefaultTtl = envDefaultTtlMs + 100;
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
			try {
				await service.getBalances();
				expect(client.getAccountInformation).toHaveBeenCalledTimes(1);

				nowSpy.mockReturnValue(base + pastDefaultTtl);
				expect((await service.getBalances()).cached).toBe(false);
				expect(client.getAccountInformation).toHaveBeenCalledTimes(2);

				const overrideLoadedAt = base + pastDefaultTtl;
				remoteConfigService._setRemoteOverridesForTesting(
					{ BINANCE_BALANCE_CACHE_MS: remoteOverrideTtlMs },
					overrideLoadedAt,
				);

				nowSpy.mockReturnValue(overrideLoadedAt + pastDefaultTtl);
				expect((await service.getBalances()).cached).toBe(true);
				expect(client.getAccountInformation).toHaveBeenCalledTimes(2);

				nowSpy.mockReturnValue(overrideLoadedAt + remoteOverrideTtlMs + 1);
				expect((await service.getBalances()).cached).toBe(false);
				expect(client.getAccountInformation).toHaveBeenCalledTimes(3);
			} finally {
				remoteConfigService._resetForTesting();
				nowSpy.mockRestore();
			}
		});
	});

	describe('getSellableQuantity', () => {
		it('computes sellable quantity for a symbol using balances and exchange info filters', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAccountInformation: jest.fn().mockResolvedValue({
					balances: [
						{ asset: 'BTC', free: '0.12349', locked: '0.05' },
						{ asset: 'USDT', free: '500.0', locked: '0.0' },
					],
				}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.getSellableQuantity('BTCUSDT', '0.12349');

			expect(result.symbol).toBe('BTCUSDT');
			expect(result.quantity).toBe('0.1234');
			expect(result.stepSize).toBe('0.0001');
			expect(result.freeBalance).toBe('0.12349');
			expect(result.lockedBalance).toBe('0.05');
		});
	});

	describe('provenance fields', () => {
		beforeEach(() => {
			jest.spyOn(AlertStorageService, 'isEnabled').mockReturnValue(true);
			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue({});
			jest.spyOn(AlertStorageService, 'getAlertById').mockResolvedValue({ id: 'alert-123', setupType: 'breakout' });
		});

		it('accepts origin, alertId, and setupType in dry-run order requests', async () => {
			const client = {
				getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
				getAvgPrice: jest.fn().mockResolvedValue({ price: '50000.00' }),
				testNewOrder: jest.fn().mockResolvedValue({}),
			};
			const service = createBinanceOrderService({ createClient: () => client });

			const result = await service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.001,
				price: 50000,
				dryRun: true,
				origin: 'alert',
				alertId: 'alert-123',
				setupType: 'breakout',
			});

			expect(result.success).toBe(true);
			expect(result.dryRun).toBe(true);
		});

		it('rejects invalid non-string origin, alertId, or setupType', async () => {
			const service = createBinanceOrderService();

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.001,
				price: 50000,
				dryRun: true,
				origin: 123,
			})).rejects.toMatchObject({ message: 'origin must be a non-empty string' });

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.001,
				price: 50000,
				dryRun: true,
				alertId: '   ',
			})).rejects.toMatchObject({ message: 'alertId must be a non-empty string' });

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.001,
				price: 50000,
				dryRun: true,
				setupType: '',
			})).rejects.toMatchObject({ message: 'setupType must be a non-empty string' });
		});

		it('rejects origin values not in the allowed enum', async () => {
			const service = createBinanceOrderService();

			await expect(service.placeOrder({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.001,
				price: 50000,
				dryRun: true,
				origin: 'invalid_origin',
			})).rejects.toMatchObject({ message: expect.stringContaining('origin must be one of:') });
		});

		describe('alertId linkage validation (issue #1276)', () => {
			let getAlertByIdSpy;
			let isEnabledSpy;
			let getFirestoreSpy;

			beforeEach(() => {
				isEnabledSpy = jest.spyOn(AlertStorageService, 'isEnabled').mockReturnValue(true);
				getFirestoreSpy = jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue({});
				getAlertByIdSpy = jest.spyOn(AlertStorageService, 'getAlertById').mockResolvedValue({
					id: 'valid-alert-123',
					symbol: 'BTCUSDT',
					price: 50000,
					setupType: 'breakout',
				});
			});

			afterEach(() => {
				isEnabledSpy?.mockRestore();
				getFirestoreSpy?.mockRestore();
				getAlertByIdSpy?.mockRestore();
			});

			it('rejects with 409 ALERT_LINK_UNAVAILABLE when alertId is provided but alert storage is disabled', async () => {
				isEnabledSpy.mockReturnValue(false);
				const service = createBinanceOrderService();

				await expect(service.placeOrder({
					symbol: 'BTCUSDT',
					side: 'BUY',
					type: 'LIMIT',
					quantity: 0.001,
					price: 50000,
					dryRun: true,
					alertId: 'valid-alert-123',
				})).rejects.toMatchObject({
					code: 'ALERT_LINK_UNAVAILABLE',
					statusCode: 409,
				});
			});

			it('rejects with 409 ALERT_LINK_UNAVAILABLE when alertId is provided but firestore is unavailable', async () => {
				getFirestoreSpy.mockReturnValue(null);
				const service = createBinanceOrderService();

				await expect(service.placeOrder({
					symbol: 'BTCUSDT',
					side: 'BUY',
					type: 'LIMIT',
					quantity: 0.001,
					price: 50000,
					dryRun: true,
					alertId: 'valid-alert-123',
				})).rejects.toMatchObject({
					code: 'ALERT_LINK_UNAVAILABLE',
					statusCode: 409,
				});
			});

			it('rejects with 409 ALERT_LINK_UNAVAILABLE when reading alert throws a storage error', async () => {
				getAlertByIdSpy.mockRejectedValue(new Error('Firestore read timeout'));
				const service = createBinanceOrderService();

				await expect(service.placeOrder({
					symbol: 'BTCUSDT',
					side: 'BUY',
					type: 'LIMIT',
					quantity: 0.001,
					price: 50000,
					dryRun: true,
					alertId: 'valid-alert-123',
				})).rejects.toMatchObject({
					code: 'ALERT_LINK_UNAVAILABLE',
					statusCode: 409,
				});
			});

			it('rejects with 404 ALERT_NOT_FOUND when alert does not exist in AlertStorageService', async () => {
				getAlertByIdSpy.mockResolvedValue(null);
				const service = createBinanceOrderService();

				await expect(service.placeOrder({
					symbol: 'BTCUSDT',
					side: 'BUY',
					type: 'LIMIT',
					quantity: 0.001,
					price: 50000,
					dryRun: true,
					alertId: 'nonexistent-alert-999',
				})).rejects.toMatchObject({
					code: 'ALERT_NOT_FOUND',
					statusCode: 404,
				});
			});

			it('rejects with 400 INVALID_REQUEST when alertId is whitespace or non-string', async () => {
				const service = createBinanceOrderService();

				await expect(service.placeOrder({
					symbol: 'BTCUSDT',
					side: 'BUY',
					type: 'LIMIT',
					quantity: 0.001,
					price: 50000,
					dryRun: true,
					alertId: '   ',
				})).rejects.toMatchObject({
					code: 'INVALID_REQUEST',
					statusCode: 400,
				});

				await expect(service.placeOrder({
					symbol: 'BTCUSDT',
					side: 'BUY',
					type: 'LIMIT',
					quantity: 0.001,
					price: 50000,
					dryRun: true,
					alertId: 12345,
				})).rejects.toMatchObject({
					code: 'INVALID_REQUEST',
					statusCode: 400,
				});
			});

			it('succeeds and adopts alert setupType when alert exists and setupType is omitted', async () => {
				const service = createBinanceOrderService();

				const result = await service.placeOrder({
					symbol: 'BTCUSDT',
					side: 'BUY',
					type: 'LIMIT',
					quantity: 0.001,
					price: 50000,
					dryRun: true,
					alertId: 'valid-alert-123',
					origin: 'admin_alert',
				});

				expect(result.success).toBe(true);
				expect(result.alertId).toBe('valid-alert-123');
				expect(result.origin).toBe('admin_alert');
				expect(result.setupType).toBe('breakout');
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
						unavailable: Boolean(overrides.unavailable),
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
				ready: false,
				status: 'paused',
				paused: true,
				blocked: true,
				unavailable: false,
				pausedBy: 'incident-commander',
				pausedAt: '2026-08-30T12:00:00Z',
				pausedReason: 'investigation',
				controlStorage: 'firestore',
				lastAction: 'pause',
			});
			expect(status).not.toHaveProperty('BINANCE_API_KEY');
			expect(status).not.toHaveProperty('apiSecret');
		});

		it('reports ready: false and status: unavailable when control state is unavailable', async () => {
			const controlService = buildControlService({
				unavailable: true,
				storage: 'memory',
			});
			const service = createBinanceOrderService({
				createClient: jest.fn(),
				controlService,
			});

			const status = await service.getStatus();
			expect(status).toMatchObject({
				ready: false,
				status: 'unavailable',
				paused: false,
				unavailable: true,
				blocked: true,
			});
		});
	});
});
