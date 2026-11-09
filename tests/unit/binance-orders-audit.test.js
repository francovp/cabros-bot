'use strict';

const { postBinanceOrder } = require('../../src/controllers/trading/binanceOrders');
const {
	binanceOrderService,
	BinanceOrderRequestError,
} = require('../../src/services/trading/BinanceOrderService');
const {
	_setAuditLogListenerForTest,
	_resetAuditLoggerForTest,
	AUDIT_CATEGORIES,
} = require('../../src/lib/auditLogger');

describe('Binance Orders Audit Logging (GH-740)', () => {
	let originalEnv;
	let auditEvents;
	let origPlaceOrder;

	beforeEach(() => {
		originalEnv = { ...process.env };
		auditEvents = [];
		_setAuditLogListenerForTest((evt) => auditEvents.push(evt));
		origPlaceOrder = binanceOrderService.placeOrder;
	});

	afterEach(() => {
		process.env = originalEnv;
		_resetAuditLoggerForTest();
		binanceOrderService.placeOrder = origPlaceOrder;
	});

	it('audits ORDER_SUBMITTED and ORDER_COMPLETED on successful order placement', async () => {
		binanceOrderService.placeOrder = jest.fn().mockResolvedValue({
			dryRun: false,
			environment: 'testnet',
			order: {
				orderId: 12345,
				clientOrderId: 'cb-test-12345',
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				status: 'FILLED',
			},
		});

		const req = {
			body: {
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quoteOrderQty: '100',
				dryRun: false,
			},
			requestId: 'req-order-1',
			ip: '127.0.0.1',
			headers: { 'x-api-key': 'valid-trading-key' },
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		await postBinanceOrder(req, res);

		expect(res.status).toHaveBeenCalledWith(201);
		expect(auditEvents).toHaveLength(2);

		const submitted = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ORDER_SUBMITTED);
		expect(submitted).toMatchObject({
			stream: 'audit',
			category: 'ORDER_SUBMITTED',
			action: 'binance_order',
			actor: 'api_key_shared',
			result: 'submitted',
			requestId: 'req-order-1',
			details: expect.objectContaining({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				dryRun: false,
			}),
		});

		const completed = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ORDER_COMPLETED);
		expect(completed).toMatchObject({
			stream: 'audit',
			category: 'ORDER_COMPLETED',
			action: 'binance_order',
			actor: 'api_key_shared',
			result: 'success',
			requestId: 'req-order-1',
			details: expect.objectContaining({
				symbol: 'BTCUSDT',
				status: 'FILLED',
				binanceOrderId: 12345,
				clientOrderId: 'cb-test-12345',
				dryRun: false,
			}),
		});
	});

	it('audits ORDER_SUBMITTED and ORDER_REJECTED on order rejection', async () => {
		binanceOrderService.placeOrder = jest.fn().mockRejectedValue(
			new BinanceOrderRequestError('Filter failure: LOT_SIZE', 'BINANCE_FILTER_LOT_SIZE', 400),
		);

		const req = {
			body: {
				symbol: 'ETHUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: '0.0000001',
				dryRun: false,
			},
			requestId: 'req-order-2',
			ip: '127.0.0.1',
			headers: { 'x-api-key': 'valid-trading-key' },
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		await postBinanceOrder(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(auditEvents).toHaveLength(2);

		const rejected = auditEvents.find((e) => e.category === AUDIT_CATEGORIES.ORDER_REJECTED);
		expect(rejected).toMatchObject({
			stream: 'audit',
			category: 'ORDER_REJECTED',
			action: 'binance_order',
			actor: 'api_key_shared',
			result: 'rejected',
			requestId: 'req-order-2',
			details: expect.objectContaining({
				symbol: 'ETHUSDT',
				errorCode: 'BINANCE_FILTER_LOT_SIZE',
				dryRun: false,
			}),
		});
	});

	it('resolves dryRun to true when omitted, and respects string "false"', async () => {
		binanceOrderService.placeOrder = jest.fn().mockResolvedValue({
			dryRun: true,
			environment: 'testnet',
			order: { symbol: 'BTCUSDT', status: 'FILLED' },
		});

		// 1. Omitted dryRun => should record dryRun: true
		const req1 = {
			body: { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET' },
			requestId: 'req-dry-1',
			headers: { 'x-api-key': 'valid-key' },
		};
		const res1 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
		await postBinanceOrder(req1, res1);

		const submitted1 = auditEvents.find((e) => e.requestId === 'req-dry-1' && e.category === AUDIT_CATEGORIES.ORDER_SUBMITTED);
		expect(submitted1.details.dryRun).toBe(true);

		// 2. dryRun: 'false' string => should record dryRun: false
		const req2 = {
			body: { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', dryRun: 'false' },
			requestId: 'req-dry-2',
			headers: { 'x-api-key': 'valid-key' },
		};
		const res2 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
		await postBinanceOrder(req2, res2);

		const submitted2 = auditEvents.find((e) => e.requestId === 'req-dry-2' && e.category === AUDIT_CATEGORIES.ORDER_SUBMITTED);
		expect(submitted2.details.dryRun).toBe(false);
	});

	it('records ORDER_AMBIGUOUS with result ambiguous when placeOrder throws BINANCE_ORDER_STATUS_UNKNOWN', async () => {
		const { BinanceOrderServiceError } = require('../../src/services/trading/BinanceOrderService');
		binanceOrderService.placeOrder = jest.fn().mockRejectedValue(
			new BinanceOrderServiceError('Binance timeout', 'BINANCE_ORDER_STATUS_UNKNOWN', 504),
		);

		const req = {
			body: {
				symbol: 'SOLUSDT',
				side: 'BUY',
				type: 'MARKET',
				quoteOrderQty: '50',
				dryRun: false,
			},
			requestId: 'req-order-ambiguous',
			headers: { 'x-api-key': 'valid-key' },
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		await postBinanceOrder(req, res);

		expect(res.status).toHaveBeenCalledWith(504);
		const ambiguousEvent = auditEvents.find(
			(e) => e.category === AUDIT_CATEGORIES.ORDER_AMBIGUOUS || e.result === 'ambiguous',
		);
		expect(ambiguousEvent).toBeDefined();
		expect(ambiguousEvent).toMatchObject({
			stream: 'audit',
			category: 'ORDER_AMBIGUOUS',
			action: 'binance_order',
			result: 'ambiguous',
			requestId: 'req-order-ambiguous',
			details: expect.objectContaining({
				symbol: 'SOLUSDT',
				errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
				dryRun: false,
			}),
		});
	});
});
