'use strict';

jest.mock('binance', () => ({
	MainClient: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { MainClient } = require('binance');
const { getRoutes } = require('../../src/routes');
const { idempotencyService } = require('../../src/services/storage/IdempotencyService');

function exchangeInfo() {
	return {
		symbols: [{
			symbol: 'BTCUSDT',
			status: 'TRADING',
			isSpotTradingAllowed: true,
			quoteOrderQtyMarketAllowed: true,
			orderTypes: ['MARKET', 'LIMIT'],
			filters: [
				{ filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '1000000', tickSize: '0.01' },
				{ filterType: 'LOT_SIZE', minQty: '0.0001', maxQty: '100', stepSize: '0.0001' },
				{ filterType: 'MIN_NOTIONAL', minNotional: '10' },
			],
		}],
	};
}

function configureTrading() {
	Object.assign(process.env, {
		WEBHOOK_API_KEY: 'test-key',
		ENABLE_BINANCE_TRADING: 'true',
		BINANCE_API_KEY: 'fake-key',
		BINANCE_API_SECRET: 'fake-secret',
		BINANCE_TRADING_ENV: 'testnet',
		BINANCE_TRADING_ALLOWED_SYMBOLS: 'BTCUSDT',
		BINANCE_TRADING_MAX_NOTIONAL: '1000',
	});
}

function saveEnv() {
	return { ...process.env };
}

function restoreEnv(saved) {
	for (const key of Object.keys(process.env)) {
		if (!(key in saved)) delete process.env[key];
	}
	Object.assign(process.env, saved);
}

describe('Binance orders API', () => {
	let app;
	let savedEnv;
	let client;

	beforeEach(() => {
		savedEnv = saveEnv();
		configureTrading();
		idempotencyService.clear();
		client = {
			getExchangeInfo: jest.fn().mockResolvedValue(exchangeInfo()),
			getAvgPrice: jest.fn().mockResolvedValue({ price: '100' }),
			getOrder: jest.fn().mockRejectedValue({ code: -2013, message: 'Unknown order sent.' }),
			submitNewOrder: jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 42,
				clientOrderId: 'client-1',
				status: 'FILLED',
				type: 'MARKET',
				side: 'BUY',
				secret: 'must-not-leak',
			}),
		};
		MainClient.mockImplementation(() => client);
		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		jest.clearAllMocks();
	});

	it('requires operator authentication before touching Binance', async () => {
		const response = await request(app)
			.post('/api/trading/binance/orders')
			.send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1, dryRun: true })
			.expect(401);

		expect(response.body.error).toContain('Missing API key');
		expect(MainClient).not.toHaveBeenCalled();
	});

	it('fails closed when no operator authentication mechanism is configured', async () => {
		delete process.env.WEBHOOK_API_KEY;
		delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;

		const response = await request(app)
			.post('/api/trading/binance/orders')
			.send({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.1, price: 100, dryRun: true })
			.expect(503);

		expect(response.body.code).toBe('ADMIN_AUTH_UNAVAILABLE');
		expect(MainClient).not.toHaveBeenCalled();
	});

	it('fails closed when the feature is disabled', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'false';

		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.1, dryRun: true })
			.expect(403);

		expect(response.body.code).toBe('FEATURE_DISABLED');
		expect(MainClient).not.toHaveBeenCalled();
	});

	it('validates and returns dry-run orders without submitting', async () => {
		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.1,
				price: 100,
				dryRun: true,
			})
			.expect(200);

		expect(response.body).toMatchObject({ success: true, dryRun: true, environment: 'testnet' });
		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('validates and executes quantity-based MARKET orders using average price notional check', async () => {
		client.getAvgPrice = jest.fn().mockResolvedValue({ price: '50000.00' });
		client.submitNewOrder = jest.fn().mockResolvedValue({
			symbol: 'BTCUSDT',
			orderId: 1002,
			clientOrderId: 'custom-sell-1',
			transactTime: 1700000000000,
			price: '0.00000000',
			origQty: '0.00100000',
			executedQty: '0.00100000',
			cummulativeQuoteQty: '50.00000000',
			status: 'FILLED',
			timeInForce: 'GTC',
			type: 'MARKET',
			side: 'SELL',
			fills: [],
		});

		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BTCUSDT',
				side: 'SELL',
				type: 'MARKET',
				quantity: 0.001,
				clientOrderId: 'custom-sell-1',
				dryRun: false,
			})
			.expect(201);

		expect(client.getAvgPrice).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
		expect(response.body).toMatchObject({
			success: true,
			dryRun: false,
			environment: 'testnet',
			order: {
				symbol: 'BTCUSDT',
				orderId: 1002,
				side: 'SELL',
				type: 'MARKET',
			},
		});
		expect(client.submitNewOrder).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'MARKET',
			quantity: 0.001,
		}));
		expect(client.submitNewOrder.mock.calls[0][0].quoteOrderQty).toBeUndefined();
	});

	it('bounds live quantity-based MARKET BUYs with exchange-enforced quoteOrderQty', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '1000';
		client.getAvgPrice = jest.fn().mockResolvedValue({ price: '50000.00' });
		client.submitNewOrder = jest.fn().mockResolvedValue({
			symbol: 'BTCUSDT',
			orderId: 1003,
			clientOrderId: 'cb_267ef7d4f4c1a898bffebf85a138d98b',
			transactTime: 1700000000000,
			origQuoteOrderQty: '50.00000000',
			executedQty: '0.00100000',
			cummulativeQuoteQty: '50.00000000',
			status: 'FILLED',
			type: 'MARKET',
			side: 'BUY',
			fills: [],
		});

		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: 0.001, // 0.001 * 50000 = 50 <= 1000
				idempotencyKey: 'bounded-buy-1',
				dryRun: false,
			})
			.expect(201);

		expect(client.getAvgPrice).toHaveBeenCalledWith({ symbol: 'BTCUSDT' });
		expect(client.submitNewOrder).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: '50',
		}));
		expect(client.submitNewOrder.mock.calls[0][0].quantity).toBeUndefined();
		expect(response.body).toMatchObject({
			success: true,
			dryRun: false,
			order: { orderId: 1003, side: 'BUY', type: 'MARKET' },
		});
	});

	it('rejects quantity-based MARKET BUYs above the configured ceiling before submission', async () => {
		process.env.BINANCE_TRADING_MAX_NOTIONAL = '10';
		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: 1, // 1 * 50000 = 50000 > 10
				dryRun: true,
			})
			.expect(400);

		expect(response.body.error).toContain('configured maximum');
		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('submits once and replays the cached result for an idempotency key', async () => {
		const payload = {
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quoteOrderQty: 50,
			dryRun: false,
		};

		const first = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-1')
			.send(payload)
			.expect(201);
		const second = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-1')
			.send(payload)
			.expect(201);

		expect(first.body).toMatchObject({ success: true, dryRun: false, order: { orderId: 42 } });
		expect(second.body).toMatchObject({ success: true, idempotencyReplayed: true });
		expect(second.body.order.secret).toBeUndefined();
		expect(client.submitNewOrder).toHaveBeenCalledTimes(1);
	});

	it('replays an indeterminate submission result instead of resubmitting an order', async () => {
		client.submitNewOrder.mockRejectedValue(new Error('provider timeout'));
		const payload = {
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		};

		const first = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-timeout')
			.send(payload)
			.expect(503);
		const second = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-timeout')
			.send(payload)
			.expect(503);

		expect(first.body).toMatchObject({ success: false, code: 'BINANCE_ORDER_STATUS_UNKNOWN' });
		expect(second.body).toMatchObject({ success: false, code: 'BINANCE_ORDER_STATUS_UNKNOWN', idempotencyReplayed: true });
		expect(client.submitNewOrder).toHaveBeenCalledTimes(1);
	});

	it('requires a stable identifier before live submission', async () => {
		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: 0.1,
				price: 100,
				dryRun: false,
			})
			.expect(400);

		expect(response.body.code).toBe('LIVE_ORDER_ID_REQUIRED');
		expect(client.submitNewOrder).not.toHaveBeenCalled();
	});

	it('reconciles an ambiguous order after the idempotency cache is lost', async () => {
		client.submitNewOrder.mockRejectedValueOnce(new Error('provider timeout'));
		client.getOrder
			.mockRejectedValueOnce({ code: -2013, message: 'Unknown order sent.' })
			.mockImplementationOnce(async (params) => ({
				symbol: 'BTCUSDT',
				orderId: 43,
				clientOrderId: params.origClientOrderId,
				status: 'FILLED',
				side: 'SELL',
				type: 'LIMIT',
				timeInForce: 'GTC',
				origQty: '0.1',
				price: '100',
			}));
		const payload = {
			symbol: 'BTCUSDT',
			side: 'SELL',
			type: 'LIMIT',
			quantity: 0.1,
			price: 100,
			dryRun: false,
		};

		await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-reconcile')
			.send(payload)
			.expect(503);
		idempotencyService.clear();

		const reconciled = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-reconcile')
			.send(payload)
			.expect(201);

		expect(reconciled.body).toMatchObject({ success: true, dryRun: false, order: { orderId: 43 } });
		expect(client.getOrder).toHaveBeenNthCalledWith(2, {
			symbol: 'BTCUSDT',
			origClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
		});
		expect(client.submitNewOrder).toHaveBeenCalledTimes(1);
		expect(client.submitNewOrder.mock.calls[0][0].newClientOrderId).toMatch(/^cb_[a-f0-9]{32}$/);
	});

	it('reconciles an ambiguous bounded MARKET BUY after the idempotency cache is lost', async () => {
		client.submitNewOrder.mockRejectedValueOnce(new Error('provider timeout'));
		client.getOrder
			.mockRejectedValueOnce({ code: -2013, message: 'Unknown order sent.' })
			.mockImplementationOnce(async (params) => ({
				symbol: 'BTCUSDT',
				orderId: 44,
				clientOrderId: params.origClientOrderId,
				status: 'FILLED',
				side: 'BUY',
				type: 'MARKET',
				origQty: '0.00000000',
				origQuoteOrderQty: '50.00',
				cummulativeQuoteQty: '50.00',
				executedQty: '0.50000000',
			}));
		const payload = {
			symbol: 'BTCUSDT',
			side: 'BUY',
			type: 'MARKET',
			quantity: 0.5,
			dryRun: false,
		};

		await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-reconcile')
			.send(payload)
			.expect(503);
		idempotencyService.clear();

		const reconciled = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-reconcile')
			.send(payload)
			.expect(201);

		expect(reconciled.body).toMatchObject({ success: true, dryRun: false, order: { orderId: 44 } });
		expect(client.getOrder).toHaveBeenNthCalledWith(2, {
			symbol: 'BTCUSDT',
			origClientOrderId: expect.stringMatching(/^cb_[a-f0-9]{32}$/),
		});
		expect(client.submitNewOrder).toHaveBeenCalledTimes(1);
	});

	it('rejects changed quantity during quote-sized MARKET BUY reconciliation with 409 conflict', async () => {
		client.getOrder.mockResolvedValueOnce({
			symbol: 'BTCUSDT',
			orderId: 45,
			clientOrderId: 'cb_267ef7d4f4c1a898bffebf85a138d98b',
			status: 'FILLED',
			side: 'BUY',
			type: 'MARKET',
			origQty: '0.00000000',
			origQuoteOrderQty: '50.00',
			cummulativeQuoteQty: '50.00',
			executedQty: '0.50000000',
		});
		idempotencyService.clear();

		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'order-375-reconcile')
			.send({
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'MARKET',
				quantity: 0.1,
				dryRun: false,
			})
			.expect(409);

		expect(response.body).toMatchObject({
			success: false,
			code: 'BINANCE_ORDER_CONFLICT',
			error: expect.stringContaining('Reconciled Binance order does not match the request'),
		});
	});

	it('exposes Binance trading readiness in status and capabilities', async () => {
		const status = await request(app)
			.get('/api/status')
			.set('x-api-key', 'test-key')
			.expect(200);
		const capabilities = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(status.body.featureFlags.binanceTrading).toBe(true);
		expect(status.body.dependencies.binanceTrading).toMatchObject({
			enabled: true,
			configured: true,
			ready: true,
			environment: 'testnet',
		});
		expect(capabilities.body.dependencies.binanceTrading).toEqual(status.body.dependencies.binanceTrading);
	});

	describe('GET /api/trading/binance/orders', () => {
		it('requires authentication before querying Binance', async () => {
			const response = await request(app)
				.get('/api/trading/binance/orders?symbol=BTCUSDT')
				.expect(401);

			expect(response.body.error).toContain('Missing API key');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('fails closed when no authentication mechanism is configured', async () => {
			delete process.env.WEBHOOK_API_KEY;
			delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;

			const response = await request(app)
				.get('/api/trading/binance/orders?symbol=BTCUSDT')
				.expect(503);

			expect(response.body.code).toBe('ADMIN_AUTH_UNAVAILABLE');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('fails closed when the feature is disabled', async () => {
			process.env.ENABLE_BINANCE_TRADING = 'false';

			const response = await request(app)
				.get('/api/trading/binance/orders?symbol=BTCUSDT')
				.set('x-api-key', 'test-key')
				.expect(403);

			expect(response.body.code).toBe('FEATURE_DISABLED');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('rejects missing or disallowed symbols with 400', async () => {
			const missing = await request(app)
				.get('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(missing.body.code).toBe('INVALID_ORDER_REQUEST');

			const disallowed = await request(app)
				.get('/api/trading/binance/orders?symbol=DOGEUSDT')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(disallowed.body.code).toBe('INVALID_ORDER_REQUEST');
		});

		it('returns recent order history for allowed symbol', async () => {
			client.allOrders = jest.fn().mockResolvedValue([
				{
					symbol: 'BTCUSDT',
					orderId: 101,
					clientOrderId: 'client-1',
					status: 'FILLED',
					type: 'MARKET',
					side: 'BUY',
					price: '0.00000000',
					origQty: '0.00100000',
					executedQty: '0.00100000',
					cummulativeQuoteQty: '50.00000000',
					time: 1700000000000,
				},
			]);

			const response = await request(app)
				.get('/api/trading/binance/orders?symbol=BTCUSDT&limit=10')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(client.allOrders).toHaveBeenCalledWith({ symbol: 'BTCUSDT', limit: 10 });
			expect(response.body).toEqual({
				success: true,
				environment: 'testnet',
				orders: [
					{
						symbol: 'BTCUSDT',
						orderId: 101,
						clientOrderId: 'client-1',
						status: 'FILLED',
						type: 'MARKET',
						side: 'BUY',
						price: '0.00000000',
						origQty: '0.00100000',
						executedQty: '0.00100000',
						cummulativeQuoteQty: '50.00000000',
						time: 1700000000000,
					},
				],
				count: 1,
			});
		});

		it('returns single order status when orderId is provided', async () => {
			client.getOrder = jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 42,
				clientOrderId: 'client-1',
				status: 'FILLED',
				type: 'LIMIT',
				side: 'BUY',
				price: '60000.00000000',
				origQty: '0.00100000',
				executedQty: '0.00100000',
				cummulativeQuoteQty: '60.00000000',
				time: 1700000000000,
				updateTime: 1700000005000,
				isWorking: true,
			});

			const response = await request(app)
				.get('/api/trading/binance/orders?symbol=BTCUSDT&orderId=42')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(client.getOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', orderId: 42 });
			expect(response.body).toMatchObject({
				success: true,
				environment: 'testnet',
				order: {
					symbol: 'BTCUSDT',
					orderId: 42,
					status: 'FILLED',
					side: 'BUY',
				},
			});
		});

		it('returns 404 when order is not found on Binance', async () => {
			client.getOrder = jest.fn().mockRejectedValue({ code: -2013, message: 'Unknown order sent.' });

			const response = await request(app)
				.get('/api/trading/binance/orders?symbol=BTCUSDT&orderId=999')
				.set('x-api-key', 'test-key')
				.expect(404);

			expect(response.body).toMatchObject({
				success: false,
				code: 'ORDER_NOT_FOUND',
				error: 'Binance order not found',
			});
		});
	});

	describe('DELETE /api/trading/binance/orders', () => {
		it('requires operator authentication before touching Binance', async () => {
			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.send({ symbol: 'BTCUSDT', orderId: 42 })
				.expect(401);

			expect(response.body.error).toContain('Missing API key');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('fails closed when no operator authentication mechanism is configured', async () => {
			delete process.env.WEBHOOK_API_KEY;
			delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;

			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.send({ symbol: 'BTCUSDT', orderId: 42 })
				.expect(503);

			expect(response.body.code).toBe('ADMIN_AUTH_UNAVAILABLE');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('fails closed when the feature is disabled', async () => {
			process.env.ENABLE_BINANCE_TRADING = 'false';

			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BTCUSDT', orderId: 42 })
				.expect(403);

			expect(response.body.code).toBe('FEATURE_DISABLED');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('cancels a resting order via orderId and returns a sanitized response', async () => {
			client.cancelOrder = jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 42,
				clientOrderId: 'cabros-574-1',
				status: 'CANCELED',
				type: 'LIMIT',
				side: 'SELL',
				price: '60000.00000000',
				origQty: '0.00100000',
				executedQty: '0.00000000',
				secret: 'must-not-leak',
			});

			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BTCUSDT', orderId: 42 })
				.expect(200);

			expect(client.cancelOrder).toHaveBeenCalledWith({ symbol: 'BTCUSDT', orderId: 42 });
			expect(response.body).toMatchObject({
				success: true,
				cancelled: true,
				environment: 'testnet',
				order: {
					symbol: 'BTCUSDT',
					orderId: 42,
					clientOrderId: 'cabros-574-1',
					status: 'CANCELED',
				},
			});
			expect(response.body.order.secret).toBeUndefined();
		});

		it('cancels a resting order via origClientOrderId', async () => {
			client.cancelOrder = jest.fn().mockResolvedValue({
				symbol: 'BTCUSDT',
				orderId: 99,
				clientOrderId: 'cabros-574-2',
				status: 'CANCELED',
			});

			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BTCUSDT', origClientOrderId: 'cabros-574-2' })
				.expect(200);

			expect(client.cancelOrder).toHaveBeenCalledWith({
				symbol: 'BTCUSDT',
				origClientOrderId: 'cabros-574-2',
			});
			expect(response.body.order.clientOrderId).toBe('cabros-574-2');
		});

		it('returns 404 when the order is already terminal on Binance', async () => {
			client.cancelOrder = jest.fn().mockRejectedValue({
				code: -2011,
				message: 'Unknown order sent.',
			});

			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BTCUSDT', orderId: 42 })
				.expect(404);

			expect(response.body).toMatchObject({
				success: false,
				code: 'ORDER_NOT_FOUND',
				error: 'Binance order not found',
			});
		});

		it('returns 400 when the request supplies neither orderId nor origClientOrderId', async () => {
			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BTCUSDT' })
				.expect(400);

			expect(response.body.code).toBe('INVALID_ORDER_REQUEST');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('returns 400 when the request supplies both orderId and origClientOrderId', async () => {
			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BTCUSDT', orderId: 42, origClientOrderId: 'cabros-574-both' })
				.expect(400);

			expect(response.body.code).toBe('INVALID_ORDER_REQUEST');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('returns 400 when the symbol is not in the configured allow-list', async () => {
			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'ETHUSDT', orderId: 42 })
				.expect(400);

			expect(response.body.error).toContain('not allowed for Binance trading');
			expect(MainClient).not.toHaveBeenCalled();
		});

		it('returns 502 when the Binance provider fails transiently', async () => {
			client.cancelOrder = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));

			const response = await request(app)
				.delete('/api/trading/binance/orders')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BTCUSDT', orderId: 42 })
				.expect(502);

			expect(response.body.code).toBe('BINANCE_QUERY_FAILED');
		});
	});
});
