const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callScanTool: jest.fn(),
		callMultiTimeframeAnalysis: jest.fn(),
	},
}));

describe('Market Scanner Alert endpoint', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;
	let mockFetch;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_MARKET_SCANNER: 'true',
		});

		jest.clearAllMocks();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'scan-msg-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ idMessage: 'wa-msg-456' }),
		});
		global.fetch = mockFetch;

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		delete global.fetch;
	});

	it('returns 401 when request lacks valid api key', async () => {
		await request(app)
			.post('/api/webhook/market-scanner-alert')
			.send({ scans: ['top_gainers'] })
			.expect(401);

		expect(tradingViewMcpService.callScanTool).not.toHaveBeenCalled();
	});

	it('triggers scans, builds Spanish report, sends telegram notifications, and returns 200', async () => {
		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:GMTUSDT',
				changePercent: 26.415,
				indicators: { close: 0.0134, RSI: 79.72 },
			},
		]);

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.send({ scans: ['top_gainers'], timeframe: '4h', exchange: 'BINANCE' })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.alertText).toContain('SCANNER DE MERCADO');
		expect(res.body.alertText).toContain('GMTUSDT');
		expect(res.body.summary).toEqual({
			totalScans: 1,
			success: 1,
			error: 0,
			timeout: 0,
			totalItems: 1,
			delivered: 1,
		});
		expect(res.body.deliveryResults).toEqual([
			expect.objectContaining({ success: true, channel: 'telegram', messageId: 'scan-msg-id' }),
		]);
		expect(tradingViewMcpService.callScanTool).toHaveBeenCalledWith(
			'top_gainers',
			{ exchange: 'BINANCE', timeframe: '4h', limit: 5 },
			expect.any(Object),
		);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		expect(mockTelegramSendMessage.mock.calls[0][1]).toContain('SCANNER DE MERCADO');
	});

	it('routes market scanner delivery to requested channels only', async () => {
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.greenapi.com/waInstance123/';
		process.env.WHATSAPP_API_KEY = 'test-whatsapp-key';
		process.env.WHATSAPP_CHAT_ID = '120363000000000000@g.us';

		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:GMTUSDT',
				changePercent: 26.415,
				indicators: { close: 0.0134, RSI: 79.72 },
			},
		]);

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.send({
				scans: ['top_gainers'],
				timeframe: '4h',
				exchange: 'BINANCE',
				channels: ['telegram'],
				telegramChatId: '-100999888777',
			})
			.expect(200);

		expect(res.body.requestedChannels).toEqual(['telegram']);
		expect(res.body.deliveredChannels).toEqual(['telegram']);
		expect(res.body.deliveryResults).toHaveLength(1);
		expect(mockTelegramSendMessage).toHaveBeenCalledWith(
			'-100999888777',
			expect.any(String),
			expect.any(Object),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('persists outcome side consistent with the rendered side for bollinger_scan items', async () => {
		const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
		jest.spyOn(signalOutcomeService, 'isEnabled').mockReturnValue(true);
		// Capture the params the controller passes without requiring Firestore persistence
		const recordedCalls = [];
		const recordSignalSpy = jest.spyOn(signalOutcomeService, 'recordSignal').mockImplementation(async (params) => {
			recordedCalls.push(params);
			return {};
		});

		tradingViewMcpService.callScanTool.mockImplementation(async (scanType) => {
			if (scanType === 'bollinger_scan') {
				return [
					{
						symbol: 'BINANCE:BTCUSDT',
						breakout_type: 'bajista',
						trading_recommendation: 'STRONG_BUY',
						indicators: { close: 60000, atr: 500, bb_lower: 58000, bb_upper: 62000 },
					},
				];
			}
			return [];
		});

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.send({ scans: ['bollinger_scan'], timeframe: '4h', exchange: 'BINANCE' })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(recordedCalls).toHaveLength(1);
		const recorded = recordedCalls[0];
		// Report renders SELL (breakout precedence) → persisted side must be SELL
		expect(recorded.side).toBe('SELL');
		expect(recorded.stop).toBe(60750); // price + atr*1.5
		expect(recorded.target).toBe(58000); // bb_lower

		recordSignalSpy.mockRestore();
		signalOutcomeService.isEnabled.mockRestore();
	});

	it('skips explicit null support and falls through to the valid item-level fallback', async () => {
		const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
		jest.spyOn(signalOutcomeService, 'isEnabled').mockReturnValue(true);
		const recordedCalls = [];
		const recordSignalSpy = jest.spyOn(signalOutcomeService, 'recordSignal').mockImplementation(async (params) => {
			recordedCalls.push(params);
			return {};
		});

		tradingViewMcpService.callScanTool.mockImplementation(async (scanType) => {
			if (scanType === 'bollinger_scan') {
				return [
					{
						symbol: 'BINANCE:BNBUSDT',
						breakout_type: 'bearish',
						indicators: { close: 3000, atr: 100, bb_lower: 2900, bb_upper: 3100, support: null },
						support: 2800,
					},
				];
			}
			return [];
		});

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.send({ scans: ['bollinger_scan'], timeframe: '4h', exchange: 'BINANCE' })
			.expect(200);

		expect(res.body.success).toBe(true);
		const recorded = recordedCalls[0];
		expect(recorded.side).toBe('SELL');
		// takeProfit must be the valid fallback (support=2800), not a fabricated 0
		expect(recorded.target).toBe(2800);

		recordSignalSpy.mockRestore();
		signalOutcomeService.isEnabled.mockRestore();
	});

	it('returns 502 when all scanner calls fail', async () => {
		tradingViewMcpService.callScanTool.mockRejectedValue(new Error('Connection failure'));

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.send({ scans: ['top_gainers'] })
			.expect(502);

		expect(res.body.success).toBe(false);
		expect(res.body.code).toBe('ALL_SCANS_FAILED');
		expect(res.body.scanResults).toEqual([
			{ scan: 'top_gainers', status: 'error', error: 'Connection failure' },
		]);
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('returns 504 when the scanner times out', async () => {
		process.env.MARKET_SCANNER_TIMEOUT_MS = '10';

		tradingViewMcpService.callScanTool.mockImplementation(
			(scanType, args, options) => new Promise((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					resolve([]);
				}, 100);
				if (options && options.signal) {
					options.signal.addEventListener('abort', () => {
						clearTimeout(timeoutId);
						reject(new Error('AbortError'));
					});
				}
			})
		);

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.send({ scans: ['top_gainers'] })
			.expect(504);

		expect(res.body.success).toBe(false);
		expect(res.body.code).toBe('MARKET_SCANNER_TIMEOUT');
		expect(res.body.timedOut).toBe(true);
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('dry-run ranked mode includes ranked flag, scores, and sorted items in alertText', async () => {
		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:BTCUSDT',
				changePercent: 3.5,
				indicators: { close: 65000, RSI: 62 },
				volume_ratio: 1.8,
				breakout_type: 'bullish',
			},
			{
				symbol: 'BINANCE:SOLUSDT',
				changePercent: 8.0,
				indicators: { close: 150, RSI: 82 },
				volume_ratio: 0.6,
			},
		]);

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.query({ dryRun: 'true' })
			.send({ scans: ['top_gainers'], ranked: true })
			.expect(200);

		expect(res.body.ranked).toBe(true);
		expect(res.body.dryRun).toBe(true);
		expect(res.body.payload.alertText).toContain('BTCUSDT');
		expect(res.body.payload.alertText).toContain('SOLUSDT');
		// Scores should be visible in alert text
		expect(res.body.payload.alertText).toContain('/100');
		// Scores array should be present in scan results
		expect(res.body.scanResults[0].scores).toBeDefined();
		expect(res.body.scanResults[0].scores).toHaveLength(2);
		for (const score of res.body.scanResults[0].scores) {
			expect(typeof score.score).toBe('number');
			expect(score.reason).toEqual(expect.any(String));
			expect(score.reason).not.toHaveLength(0);
		}
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('normal mode without ranked flag does not include scores', async () => {
		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:BTCUSDT',
				changePercent: 3.5,
				indicators: { close: 65000, RSI: 62 },
				volume_ratio: 1.8,
			},
		]);

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.query({ dryRun: 'true' })
			.send({ scans: ['top_gainers'] })
			.expect(200);

		expect(res.body.ranked).toBe(false);
		expect(res.body.scanResults[0].scores).toBeUndefined();
		expect(res.body.payload.alertText).not.toContain('/100');
	});

	it('includes opt-in higher-timeframe confluence in ranked output', async () => {
		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:BTCUSDT',
				changePercent: 3.5,
				indicators: { close: 65000, RSI: 62 },
				volume_ratio: 1.8,
				breakout_type: 'bullish',
			},
		]);
		tradingViewMcpService.callMultiTimeframeAnalysis.mockResolvedValueOnce({
			alignment: { status: 'bullish', confidence: 82 },
		});

		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.query({ dryRun: 'true' })
			.send({ scans: ['top_gainers'], ranked: true, includeMultiTimeframe: true })
			.expect(200);

		expect(res.body.includeMultiTimeframe).toBe(true);
		expect(res.body.payload.alertText).toContain('🔥 HTF ALIGNED 82%');
		expect(res.body.scanResults[0].scores[0]).toEqual(expect.objectContaining({
			trendConfluence: expect.objectContaining({ status: 'aligned', confidence: 82 }),
		}));
	});
});
