'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		isEnabled: jest.fn(() => true),
		enrichFromAlertText: jest.fn(),
	},
}));

jest.mock('../../src/services/storage/AlertStorageService', () => {
	const actual = jest.requireActual('../../src/services/storage/AlertStorageService');
	return {
		...actual,
		isEnabled: jest.fn(() => false),
		extractSymbolAndExchange: jest.fn((input) => actual.extractSymbolAndExchange(input)),
		saveAlert: jest.fn().mockResolvedValue(undefined),
	};
});

jest.mock('../../src/services/storage/IdempotencyService', () => {
	const actual = jest.requireActual('../../src/services/storage/IdempotencyService');
	return {
		...actual,
		idempotencyService: {
			...actual.idempotencyService,
			clear: jest.fn(),
			reserveEntry: jest.fn().mockResolvedValue({ fresh: true }),
			setEntry: jest.fn().mockResolvedValue(undefined),
			releaseEntry: jest.fn().mockResolvedValue(undefined),
			getEntry: jest.fn().mockResolvedValue(null),
		},
	};
});

jest.mock('../../src/services/tradingview/fallbackTradePlan', () => ({
	deriveFallbackTradePlan: jest.fn(),
	calculateFallbackRiskLevels: jest.fn((price, timeframe, side) => {
		if (side === 'SELL') {
			return {
				invalidation_level: price * 1.025,
				target_level: price * 0.95,
			};
		}
		return {
			invalidation_level: price * 0.975,
			target_level: price * 1.05,
		};
	}),
}));

const { deriveFallbackTradePlan } = require('../../src/services/tradingview/fallbackTradePlan');

describe('Alert Min Context Integration (GH-581 / CB-269)', () => {
	let mockTelegramSendMessage;
	let savedEnv;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'true',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_MIN_ALERT_CONTEXT: 'true',
			TELEGRAM_CHAT_ID: '123456789',
			BOT_TOKEN: 'test-bot-token',
			ENABLE_TELEGRAM_BOT: 'true',
		});

		jest.clearAllMocks();
		deriveFallbackTradePlan.mockReset();
		alertStorageService.isEnabled.mockReturnValue(false);

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
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('synthesizes a provisional package with Binance price when MCP fails', async () => {
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(null);
		deriveFallbackTradePlan.mockResolvedValue({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
			side: 'BUY',
			current_price: 100,
			price_data: { current_price: 100, source: 'binance' },
			invalidation_level: 97.5,
			target_level: 105,
			risk_reward_ratio: 2,
			setup_type: 'trend_continuation',
			levelsSource: 'derived-quote',
		});

		const response = await request(app)
			.post('/api/webhook/alert?useTradingViewData=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(240) pasó a señal de COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.enriched).toBe(true);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);

		const telegramPayload = mockTelegramSendMessage.mock.calls[0][1];
		// Should contain the provisional levels and provenance
		expect(telegramPayload).toContain('Entry');
		expect(telegramPayload).toContain('100');
		expect(telegramPayload).toContain('Invalidation');
		expect(telegramPayload).toContain('Target');
		expect(telegramPayload).toContain('Levels provisional');
		expect(telegramPayload).toContain('fuente_precio: binance');
	});

	it('emits sin datos tecnicos annotation when no price source is reachable', async () => {
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(null);
		deriveFallbackTradePlan.mockResolvedValue(null);

		const response = await request(app)
			.post('/api/webhook/alert?useTradingViewData=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(240) pasó a señal de COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.enriched).toBe(true);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);

		const telegramPayload = mockTelegramSendMessage.mock.calls[0][1];
		expect(telegramPayload).toContain('sin datos tecnicos');
		expect(telegramPayload).toContain('fuente_precio: ninguno');
	});

	it('does not annotate when MCP enrichment already produced complete risk + price', async () => {
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BINANCE:BTCUSDT(240) pasó a señal de COMPRA',
			sentiment: 'BULLISH',
			sentiment_score: 0.7,
			insights: ['MCP-derived signal'],
			current_price: 110,
			invalidation_level: 105,
			target_level: 120,
			risk_reward_ratio: 1.5,
			setup_type: 'breakout',
			sources: [],
			truncated: false,
			tradingViewEnrichmentApplied: true,
			tradingViewEnrichmentStatus: 'full',
			extraText: '*Model used*: `tradingview-mcp`',
		});
		deriveFallbackTradePlan.mockResolvedValue(null);

		const response = await request(app)
			.post('/api/webhook/alert?useTradingViewData=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(240) pasó a señal de COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);

		const telegramPayload = mockTelegramSendMessage.mock.calls[0][1];
		// Should contain the MCP-derived levels, NOT the provisional annotation
		expect(telegramPayload).not.toContain('Levels provisional');
		expect(telegramPayload).not.toContain('fuente_precio:');
	});

	it('does not run when ENABLE_MIN_ALERT_CONTEXT=false (default)', async () => {
		delete process.env.ENABLE_MIN_ALERT_CONTEXT;
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(null);
		deriveFallbackTradePlan.mockResolvedValue(null);

		const response = await request(app)
			.post('/api/webhook/alert?useTradingViewData=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(240) pasó a señal de COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(deriveFallbackTradePlan).not.toHaveBeenCalled();

		const telegramPayload = mockTelegramSendMessage.mock.calls[0][1];
		expect(telegramPayload).not.toContain('sin datos tecnicos');
		expect(telegramPayload).not.toContain('Levels provisional');
	});
});
