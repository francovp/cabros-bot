/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		analyzeSymbolIdentifier: jest.fn(),
		callScanTool: jest.fn(),
		callMultiTimeframeAnalysis: jest.fn(),
	},
}));

describe('Dry-run mode for webhook alert endpoints', () => {
	const originalEnv = process.env;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_MARKET_SCANNER: 'true',
		};

		jest.clearAllMocks();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-msg-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	// ---------------------------------------------------------------------------
	// POST /api/webhook/alert
	// ---------------------------------------------------------------------------
	describe('POST /api/webhook/alert', () => {
		it('returns dryRun:true via query string and skips delivery', async () => {
			const res = await request(app)
				.post('/api/webhook/alert?dryRun=true')
				.set('x-api-key', 'test-key')
				.send({ text: 'Bitcoin breaks $50,000 mark' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBe(true);
			expect(res.body.payload).toBeDefined();
			expect(res.body.payload.text).toBe('Bitcoin breaks $50,000 mark');
			expect(res.body.results).toBeUndefined();
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('returns dryRun:true via request body and skips delivery', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: 'ETH consolidates above $3,000', dryRun: true })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBe(true);
			expect(res.body.payload).toBeDefined();
			expect(res.body.payload.text).toBe('ETH consolidates above $3,000');
			expect(res.body.results).toBeUndefined();
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('delivers normally when dryRun is absent', async () => {
			const res = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: 'Live alert text' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBeUndefined();
			expect(res.body.results).toBeDefined();
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		});

		it('returns tokenUsage in dry-run response', async () => {
			const res = await request(app)
				.post('/api/webhook/alert?dryRun=true')
				.set('x-api-key', 'test-key')
				.send({ text: 'Price alert for BTC' })
				.expect(200);

			expect(res.body.tokenUsage).toBeDefined();
		});
	});

	// ---------------------------------------------------------------------------
	// POST /api/webhook/expanded-analysis-alert
	// ---------------------------------------------------------------------------
	describe('POST /api/webhook/expanded-analysis-alert', () => {
		const mockAnalysis = {
			technical: {
				price_data: { current_price: 50000 },
				technical_indicators: { rsi: 58 },
				trend: { direction: 'bullish' },
				macd: { histogram: 1.5, signal: 'buy' },
				support_resistance: { support: [48000], resistance: [52000] },
			},
		};

		beforeEach(() => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValue(mockAnalysis);
		});

		it('returns dryRun:true via query string and skips delivery', async () => {
			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert?dryRun=true')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'], timeframe: '1D' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBe(true);
			expect(res.body.payload).toBeDefined();
			expect(typeof res.body.payload.alertText).toBe('string');
			expect(res.body.payload.alertText.length).toBeGreaterThan(0);
			expect(res.body.deliveryResults).toBeUndefined();
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('returns dryRun:true via request body and skips delivery', async () => {
			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'], timeframe: '4h', dryRun: true })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBe(true);
			expect(res.body.payload).toBeDefined();
			expect(res.body.deliveryResults).toBeUndefined();
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('delivers normally when dryRun is absent', async () => {
			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'], timeframe: '1D' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBeUndefined();
			expect(res.body.deliveryResults).toBeDefined();
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		});
	});

	// ---------------------------------------------------------------------------
	// POST /api/webhook/market-scanner-alert
	// ---------------------------------------------------------------------------
	describe('POST /api/webhook/market-scanner-alert', () => {
		const mockScanResult = [
			{
				symbol: 'BINANCE:BTCUSDT',
				changePercent: 5.1,
				indicators: { close: 50000, RSI: 62 },
			},
		];

		beforeEach(() => {
			tradingViewMcpService.callScanTool.mockResolvedValue(mockScanResult);
		});

		it('returns dryRun:true via query string and skips delivery', async () => {
			const res = await request(app)
				.post('/api/webhook/market-scanner-alert?dryRun=true')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'], exchange: 'BINANCE', timeframe: '4h' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBe(true);
			expect(res.body.payload).toBeDefined();
			expect(typeof res.body.payload.alertText).toBe('string');
			expect(res.body.payload.alertText.length).toBeGreaterThan(0);
			expect(res.body.deliveryResults).toBeUndefined();
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('returns dryRun:true via request body and skips delivery', async () => {
			const res = await request(app)
				.post('/api/webhook/market-scanner-alert')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'], dryRun: true })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBe(true);
			expect(res.body.payload).toBeDefined();
			expect(res.body.deliveryResults).toBeUndefined();
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		});

		it('delivers normally when dryRun is absent', async () => {
			const res = await request(app)
				.post('/api/webhook/market-scanner-alert')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'] })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBeUndefined();
			expect(res.body.deliveryResults).toBeDefined();
			expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		});

		it('includes scanResults and summary in dry-run response', async () => {
			const res = await request(app)
				.post('/api/webhook/market-scanner-alert?dryRun=true')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'] })
				.expect(200);

			expect(res.body.scanResults).toBeDefined();
			expect(res.body.summary).toBeDefined();
		});
	});
});
