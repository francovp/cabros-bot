const express = require('express');
const request = require('supertest');

describe('TradingView dependency outage drill', () => {
	let app;
	let sendMessage;
	let savedEnv;
	let unhandledRejections;
	let onUnhandledRejection;

	beforeEach(async () => {
		savedEnv = { ...process.env };
		Object.assign(process.env, {
			BOT_TOKEN: 'performance-test-token',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'true',
			TRADINGVIEW_MCP_URL: 'http://127.0.0.1:1/mcp',
			TRADINGVIEW_MCP_TIMEOUT_MS: '100',
			TRADINGVIEW_MCP_MAX_RETRIES: '0',
			TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS: '200',
			TELEGRAM_CHAT_ID: '123456789',
			WEBHOOK_API_KEY: 'performance-test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
		});
		jest.resetModules();

		const { TradingViewMcpService } = require('../../../src/services/tradingview/TradingViewMcpService');
		const mcp = new TradingViewMcpService({
			url: process.env.TRADINGVIEW_MCP_URL,
			timeoutMs: 100,
			maxRetries: 0,
			enrichmentBudgetMs: 200,
		});
		jest.doMock('../../../src/services/tradingview/TradingViewMcpService', () => ({ tradingViewMcpService: mcp }));

		const { initializeNotificationServices } = require('../../../src/controllers/webhooks/handlers/alert/alert');
		const { getRoutes } = require('../../../src/routes');
		sendMessage = jest.fn().mockResolvedValue({ message_id: 'performance-test-message' });
		await initializeNotificationServices({
			telegram: {
				sendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 1, username: 'performance-test-bot' }),
			},
		});

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes());
		unhandledRejections = [];
		onUnhandledRejection = (error) => unhandledRejections.push(error);
		process.on('unhandledRejection', onUnhandledRejection);
	});

	afterEach(() => {
		process.off('unhandledRejection', onUnhandledRejection);
		process.env = savedEnv;
		jest.dontMock('../../../src/services/tradingview/TradingViewMcpService');
	});

	it('delivers all five alerts when MCP is unreachable', async () => {
		const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => request(app)
			.post('/api/webhook/alert?useTradingViewData=true')
			.set('x-api-key', 'performance-test-key')
			.send({ text: `BTCUSDT(240) señal de COMPRA ${index}` })));

		expect(responses.every((response) => response.status === 200 && response.body.success === true)).toBe(true);
		expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(5);
		expect(unhandledRejections).toEqual([]);
	});
});
