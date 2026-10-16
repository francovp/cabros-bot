'use strict';

const request = require('supertest');
const express = require('express');

// Mock external services before importing controllers or routes
jest.mock('../../src/services/trading/BinanceOrderService', () => {
	const actual = jest.requireActual('../../src/services/trading/BinanceOrderService');
	return {
		...actual,
		deriveSymbolAssets: (symbol) => {
			if (symbol === 'BTCUSDT') return { baseAsset: 'BTC', quoteAsset: 'USDT' };
			if (symbol === 'ETHUSDT') return { baseAsset: 'ETH', quoteAsset: 'USDT' };
			return { baseAsset: symbol, quoteAsset: 'USDT' };
		},
	};
});

describe('Trade Ledger Endpoints (Integration)', () => {
	let app;
	let originalEnv;
	let mockFills;
	let mockMarkPrices;

	beforeAll(() => {
		originalEnv = { ...process.env };
	});

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.WEBHOOK_API_KEY = 'test-api-key';
		process.env.ENABLE_TRADE_LEDGER = 'true';
		process.env.BINANCE_TRADING_ENV = 'testnet';

		mockFills = [
			{
				environment: 'testnet',
				symbol: 'BTCUSDT',
				baseAsset: 'BTC',
				quoteAsset: 'USDT',
				side: 'BUY',
				price: '60000',
				qty: '1',
				quoteQty: '60000',
				commission: '60',
				commissionAsset: 'USDT',
				commissionQuote: '60',
				binanceOrderId: '101',
				clientOrderId: 'cid-buy',
				alertId: 'alert-1',
				origin: 'manual',
				tradeId: 1,
				filledAt: '2026-10-01T10:00:00.000Z',
			},
			{
				environment: 'testnet',
				symbol: 'BTCUSDT',
				baseAsset: 'BTC',
				quoteAsset: 'USDT',
				side: 'SELL',
				price: '65000',
				qty: '1',
				quoteQty: '65000',
				commission: '65',
				commissionAsset: 'USDT',
				commissionQuote: '65',
				binanceOrderId: '102',
				clientOrderId: 'cid-sell',
				alertId: null,
				origin: 'manual',
				tradeId: 2,
				filledAt: '2026-10-01T12:00:00.000Z',
			},
			{
				environment: 'testnet',
				symbol: 'ETHUSDT',
				baseAsset: 'ETH',
				quoteAsset: 'USDT',
				side: 'BUY',
				price: '3000',
				qty: '2',
				quoteQty: '6000',
				commission: '6',
				commissionAsset: 'USDT',
				commissionQuote: '6',
				binanceOrderId: '103',
				clientOrderId: 'cid-buy-eth',
				alertId: 'alert-2',
				origin: 'auto_trade',
				tradeId: 3,
				filledAt: '2026-10-02T10:00:00.000Z',
			},
		];

		const { tradeLedgerService } = require('../../src/services/trading/TradeLedgerService');
		tradeLedgerService.isConfigured = jest.fn(() => true);
		tradeLedgerService.listFills = jest.fn(async ({ environment }) => {
			const fills = mockFills.filter((f) => f.environment === environment);
			return { fills, scanTruncated: false, maxScan: 5000 };
		});
		tradeLedgerService.fetchMarkPrices = jest.fn(async (symbols) => {
			const prices = {};
			for (const s of symbols) {
				if (s === 'ETHUSDT') prices[s] = '3200';
			}
			return prices;
		});

		app = express();
		app.use(express.json());
		const { getRoutes } = require('../../src/routes');
		app.use('/api', getRoutes());
	});

	afterAll(() => {
		process.env = { ...originalEnv };
	});

	describe('Authentication and Gating', () => {
		it('returns 401 when x-api-key is missing', async () => {
			const res = await request(app).get('/api/trading/positions');
			expect(res.status).toBe(401);
		});

		it('returns 403 when ENABLE_TRADE_LEDGER is false', async () => {
			process.env.ENABLE_TRADE_LEDGER = 'false';
			const res = await request(app)
				.get('/api/trading/positions')
				.set('x-api-key', 'test-api-key');
			expect(res.status).toBe(403);
			expect(res.body.code).toBe('FEATURE_DISABLED');
		});

		it('returns 400 on invalid environment parameter', async () => {
			const res = await request(app)
				.get('/api/trading/positions?environment=invalid')
				.set('x-api-key', 'test-api-key');
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('accepts ADMIN_API_KEY even when BINANCE_TRADING_API_KEY is configured', async () => {
			process.env.ADMIN_API_KEY = 'admin-key';
			process.env.BINANCE_TRADING_API_KEY = 'binance-key';
			const res = await request(app)
				.get('/api/trading/positions?environment=testnet')
				.set('x-api-key', 'admin-key');
			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
		});
	});

	describe('GET /api/trading/positions', () => {
		it('returns open positions calculated from open lots with mark prices', async () => {
			const res = await request(app)
				.get('/api/trading/positions?environment=testnet')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.environment).toBe('testnet');
			expect(res.body.positions).toHaveLength(1);
			const eth = res.body.positions[0];
			expect(eth.symbol).toBe('ETHUSDT');
			expect(eth.qty).toBe('2');
			expect(eth.costBasis).toBe('6006');
			expect(eth.markPrice).toBe('3200');
			// unrealized = 3200 * 2 - 6006 = 394
			expect(eth.unrealizedPnl).toBe('394');
			expect(eth.alertIds).toEqual(['alert-2']);
		});
	});

	describe('GET /api/trading/pnl/summary', () => {
		it('returns realized P&L, ROI %, win rate, drawdown and equity series', async () => {
			const res = await request(app)
				.get('/api/trading/pnl/summary?environment=testnet')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.environment).toBe('testnet');
			expect(res.body.tradeCount).toBe(1);
			// BTC roundtrip: cost = 60060, proceeds = 64935, realized = 4875
			expect(res.body.realizedPnl).toBe('4875');
			expect(res.body.costBasisClosed).toBe('60060');
			expect(res.body.winRate).toBe(1);
			expect(res.body.unrealizedPnl).toBe('394');
			expect(res.body.equitySeries).toHaveLength(1);
		});

		it('supports groupBy query parameter', async () => {
			const res = await request(app)
				.get('/api/trading/pnl/summary?environment=testnet&groupBy=origin')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(200);
			expect(res.body.summary.groupBy).toBe('origin');
			expect(res.body.summary.groups).toEqual(expect.arrayContaining([
				expect.objectContaining({ key: 'manual', tradeCount: 1 }),
			]));
		});

		it('returns 400 for invalid groupBy', async () => {
			const res = await request(app)
				.get('/api/trading/pnl/summary?environment=testnet&groupBy=badKey')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 for invalid date format', async () => {
			const res = await request(app)
				.get('/api/trading/pnl/summary?environment=testnet&from=not-a-date')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});
	});

	describe('GET /api/trading/trades', () => {
		it('returns closed round trips with pagination', async () => {
			const res = await request(app)
				.get('/api/trading/trades?environment=testnet&limit=10')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.environment).toBe('testnet');
			expect(res.body.trades).toHaveLength(1);
			const trade = res.body.trades[0];
			expect(trade.symbol).toBe('BTCUSDT');
			expect(trade.realizedPnl).toBe('4875');
			expect(trade.fees).toBe('125');
			expect(trade.alertIds).toEqual(['alert-1']);
			expect(res.body.pagination.hasMore).toBe(false);
		});

		it('filters trades by symbol', async () => {
			const res = await request(app)
				.get('/api/trading/trades?environment=testnet&symbol=ETHUSDT')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(200);
			expect(res.body.trades).toHaveLength(0);
		});

		it('returns 400 for invalid limit', async () => {
			const res = await request(app)
				.get('/api/trading/trades?environment=testnet&limit=500')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});
	});
});
