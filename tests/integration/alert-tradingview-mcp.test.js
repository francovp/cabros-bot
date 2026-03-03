const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		isEnabled: jest.fn(() => true),
		enrichFromAlertText: jest.fn(),
	},
}));

describe('Alert TradingView MCP Integration', () => {
	let mockTelegramSendMessage;
	const originalEnv = process.env;

	beforeEach(async () => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'true',
			ENABLE_GEMINI_GROUNDING: 'false',
			TELEGRAM_CHAT_ID: '123456789',
			BOT_TOKEN: 'test-bot-token',
			ENABLE_TELEGRAM_BOT: 'true',
		};

		jest.clearAllMocks();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-message-id' });
		const bot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ success: true }),
		});

		await initializeNotificationServices(bot);
		app.use('/api', getRoutes());
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('enriches TradingView signal alerts using MCP output', async () => {
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de VENTA',
			sentiment: 'BEARISH',
			sentiment_score: -0.7,
			insights: ['Señal detectada: VENTA para BTCUSDT en 4h (BINANCE)'],
			technical_levels: { supports: ['65,664.12'], resistances: ['69,468.88'] },
			sources: [],
			truncated: false,
			extraText: '*Model used*: `tradingview-mcp`',
		});

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BTCUSDT(240) pasó a señal de VENTA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.enriched).toBe(true);
		expect(tradingViewMcpService.enrichFromAlertText).toHaveBeenCalledWith('BTCUSDT(240) pasó a señal de VENTA');
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);

		const telegramPayload = mockTelegramSendMessage.mock.calls[0][1];
		expect(telegramPayload).toContain('*Key Insights*');
		expect(telegramPayload).toContain('Sentiment: BEARISH');
	});

	it('keeps webhook fail-open when MCP does not match signal pattern', async () => {
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(null);

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'Mensaje genérico sin patrón' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.enriched).toBe(false);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
	});
});
