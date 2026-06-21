const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callScanTool: jest.fn(),
	},
}));

describe('Market Scanner Alert endpoint', () => {
	const originalEnv = process.env;
	let mockTelegramSendMessage;
	let mockBot;
	let mockFetch;

	beforeEach(async () => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_MARKET_SCANNER: 'true',
		};

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
		process.env = originalEnv;
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
});
