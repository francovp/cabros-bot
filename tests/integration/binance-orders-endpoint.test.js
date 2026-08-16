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
});
