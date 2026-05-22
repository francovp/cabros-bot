const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { analyzeSymbols } = require('../../src/controllers/webhooks/handlers/tradingViewAlert/tradingViewAlert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		analyzeSymbolIdentifier: jest.fn(),
	},
}));

describe('TradingView alert endpoint', () => {
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
			TRADINGVIEW_ALERT_SYMBOLS: '',
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '1D',
		};

		jest.clearAllMocks();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'tv-message-id' });
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

	it('generates a TradingView report, sends it, and returns delivery results', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			symbol: 'NASDAQ:NVDA',
			price_data: {
				current_price: 219.51,
				change_percent: -1.8,
				volume: 70213090,
			},
			technical_indicators: {
				rsi: 57.8,
				sma20: 214.1,
				macd: 6.1,
				macd_signal: 7.2,
				atr: 7.69,
			},
		});

		const res = await request(app)
			.post('/api/tradingview-alert')
			.set('x-api-key', 'test-key')
			.send({ symbols: ['NASDAQ:NVDA'], timeframe: '1D' })
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.alertText).toContain('*🟡 NEUTROS*');
		expect(res.body.summary).toEqual({
			total: 1,
			analyzed: 1,
			error: 0,
			delivered: 1,
		});
		expect(res.body.deliveryResults).toEqual([
			expect.objectContaining({ success: true, channel: 'telegram', messageId: 'tv-message-id' }),
		]);
		expect(tradingViewMcpService.analyzeSymbolIdentifier).toHaveBeenCalledWith({
			raw: 'NASDAQ:NVDA',
			exchange: 'NASDAQ',
			symbol: 'NVDA',
			timeframe: '1D',
		});
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
		expect(mockTelegramSendMessage.mock.calls[0][1]).toContain('ANÁLISIS AMPLIADO');
	});

	it('falls back to TRADINGVIEW_ALERT_SYMBOLS when body symbols are empty', async () => {
		process.env.TRADINGVIEW_ALERT_SYMBOLS = 'NASDAQ:AAPL';
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			price_data: { current_price: 304.99, change_percent: 0.9 },
			technical_indicators: { rsi: 76.2, sma20: 296.5, macd: 2.3, macd_signal: 1.1 },
		});

		const res = await request(app)
			.post('/api/tradingview-alert')
			.set('x-api-key', 'test-key')
			.send({ symbols: [] })
			.expect(200);

		expect(res.body.results[0]).toEqual(expect.objectContaining({
			symbol: 'NASDAQ:AAPL',
			status: 'analyzed',
		}));
	});

	it('returns 400 when neither body symbols nor TRADINGVIEW_ALERT_SYMBOLS are defined', async () => {
		const res = await request(app)
			.post('/api/tradingview-alert')
			.set('x-api-key', 'test-key')
			.send({})
			.expect(400);

		expect(res.body).toEqual(expect.objectContaining({
			code: 'NO_SYMBOLS',
			error: 'No TradingView symbols provided. Pass body.symbols or set TRADINGVIEW_ALERT_SYMBOLS.',
		}));
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('returns 400 for invalid symbol identifiers', async () => {
		const res = await request(app)
			.post('/api/tradingview-alert')
			.set('x-api-key', 'test-key')
			.send({ symbols: ['NVDA'] })
			.expect(400);

		expect(res.body.code).toBe('INVALID_REQUEST');
		expect(res.body.error).toContain('EXCHANGE:SYMBOL');
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('returns 502 and skips delivery when all symbols fail', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockRejectedValueOnce(new Error('No data found'));

		const res = await request(app)
			.post('/api/tradingview-alert')
			.set('x-api-key', 'test-key')
			.send({ symbols: ['NASDAQ:UNKNOWN'] })
			.expect(502);

		expect(res.body.success).toBe(false);
		expect(res.body.code).toBe('ALL_SYMBOLS_FAILED');
		expect(res.body.results).toEqual([
			expect.objectContaining({
				symbol: 'NASDAQ:UNKNOWN',
				status: 'error',
				error: 'No data found',
			}),
		]);
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('analyzes symbols sequentially to avoid concurrent MCP failures', async () => {
		let activeCalls = 0;
		let maxActiveCalls = 0;
		const callOrder = [];

		tradingViewMcpService.analyzeSymbolIdentifier.mockImplementation(async ({ raw }) => {
			activeCalls++;
			maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
			callOrder.push(`start:${raw}`);
			await Promise.resolve();
			activeCalls--;
			callOrder.push(`end:${raw}`);
			return {
				price_data: { current_price: 100 },
				technical_indicators: { rsi: 50 },
			};
		});

		await analyzeSymbols({
			symbols: [
				{ raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
				{ raw: 'NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL' },
			],
			timeframe: '1D',
		});

		expect(maxActiveCalls).toBe(1);
		expect(callOrder).toEqual([
			'start:NASDAQ:NVDA',
			'end:NASDAQ:NVDA',
			'start:NASDAQ:AAPL',
			'end:NASDAQ:AAPL',
		]);
	});
});
