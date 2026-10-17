/* global jest, describe, it, beforeEach, afterEach, expect */

jest.mock('../../src/services/trading/BinanceOrderService', () => ({
	binanceOrderService: { placeOrder: (...args) => mockPlaceOrder(...args) },
	getConfig: () => mockBinanceConfig,
}));

const mockPlaceOrder = jest.fn();
const mockReserveAutoTrade = jest.fn();
const mockFinishAutoTrade = jest.fn();
jest.mock('../../src/services/trading/AutoTradeReservationService', () => ({
	reserveAutoTrade: (...args) => mockReserveAutoTrade(...args),
	finishAutoTrade: (...args) => mockFinishAutoTrade(...args),
}));
const mockBinanceConfig = {
	enabled: true,
	configured: true,
	environment: 'testnet',
	allowedSymbols: ['BTCUSDT'],
	maxNotional: 1000,
};

// The alert handler imports './grounding' from inside its own directory, so the
// mock must be registered under that exact specifier for the handler's local
// binding to be replaced.
jest.mock('../../src/controllers/webhooks/handlers/alert/grounding', () => ({
	enrichAlert: jest.fn(),
}));

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { enrichAlert } = require('../../src/controllers/webhooks/handlers/alert/grounding');
const { waitForBackgroundTasks } = require('../../src/lib/backgroundTaskTracker');

function saveEnv() {
	return { ...process.env };
}

function restoreEnv(saved) {
	for (const key of Object.keys(process.env)) {
		if (!(key in saved)) delete process.env[key];
	}
	Object.assign(process.env, saved);
}

const BULLISH_ENRICHMENT = {
	original_text: 'BINANCE:BTCUSDT(1h) COMPRA',
	sentiment: 'BULLISH',
	sentiment_score: 0.8,
	current_price: 50000,
	sources: [],
	truncated: false,
};

describe('Alert auto-trade endpoint wiring', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			ENABLE_DISCORD_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_GEMINI_GROUNDING: 'true',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_ALERT_MODERATION: 'false',
			// Auto-trade stays opt-in and dry-run by default in these tests.
			ENABLE_AUTO_TRADE: 'false',
			AUTO_TRADE_DRY_RUN: 'true',
		});

		// resetAllMocks would also drop the Binance client mock; clear the
		// enrichment mock's recorded *and* resolved values so a prior test's
		// override cannot leak into the next one.
		jest.clearAllMocks();
		enrichAlert.mockReset();
		mockPlaceOrder.mockReset();
		mockReserveAutoTrade.mockReset();
		mockFinishAutoTrade.mockReset();
		mockReserveAutoTrade.mockResolvedValue({ state: 'reserved' });
		mockFinishAutoTrade.mockResolvedValue(true);
		mockBinanceConfig.enabled = true;
		mockBinanceConfig.configured = true;
		mockBinanceConfig.allowedSymbols = ['BTCUSDT'];
		mockBinanceConfig.maxNotional = 1000;
		mockPlaceOrder.mockResolvedValue({
			success: true,
			dryRun: true,
			environment: 'testnet',
			order: { orderId: 4242, symbol: 'BTCUSDT', side: 'BUY' },
		});

		enrichAlert.mockResolvedValue({ ...BULLISH_ENRICHMENT });
		require('../../src/services/trading/AlertSignalRouter').__resetForTesting();

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
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('does not execute an order when ENABLE_AUTO_TRADE is false', async () => {
		const response = await request(app)
			.post('/api/webhook/alert?autoTrade=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.autoTrade).toBeUndefined();
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('does not execute an order when the request does not opt in', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.autoTrade).toBeUndefined();
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('executes a dry-run order when the request opts in and the flag is enabled', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';

		const response = await request(app)
			.post('/api/webhook/alert?autoTrade=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.autoTrade).toMatchObject({
			requested: true,
			executed: true,
			symbol: 'BTCUSDT',
			dryRun: true,
			orderId: 4242,
		});
		expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
		const [orderBody] = mockPlaceOrder.mock.calls[0];
		expect(orderBody).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', dryRun: true });
	});

	it('accepts the body-only autoTrade flag', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA', autoTrade: true })
			.expect(200);
		expect(response.body.autoTrade).toMatchObject({ requested: true, executed: true, dryRun: true });
		expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
	});

	it('rejects a malformed body autoTrade flag before delivery or trading', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA', autoTrade: 'yes' })
			.expect(400);
		expect(response.body.error).toBe('INVALID_AUTO_TRADE_FLAG');
		expect(response.body).toMatchObject({ code: 'INVALID_REQUEST', requestId: expect.any(String), retryable: false });
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it.each(['?autoTrade=tru', '?autoTrade', '?autoTrade=true&autoTrade=false'])(
		'rejects malformed query flag %s before delivery or trading', async (query) => {
			process.env.ENABLE_AUTO_TRADE = 'true';
			const response = await request(app)
				.post(`/api/webhook/alert${query}`)
				.set('x-api-key', 'test-key')
				.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA' })
				.expect(400);
			expect(response.body).toMatchObject({
				error: 'INVALID_AUTO_TRADE_FLAG', code: 'INVALID_REQUEST', requestId: expect.any(String), retryable: false,
			});
			expect(mockTelegramSendMessage).not.toHaveBeenCalled();
			expect(mockPlaceOrder).not.toHaveBeenCalled();
		},
	);

	it('passes the body signalId to the durable live reservation', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		process.env.AUTO_TRADE_DRY_RUN = 'false';
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
		mockPlaceOrder.mockResolvedValue({ success: true, dryRun: false, order: { orderId: 4242 } });
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA', autoTrade: true, signalId: 'bar-123' })
			.expect(200);
		expect(response.body.autoTrade).toMatchObject({ reason: 'ORDER_PENDING', executed: false });
		expect(mockReserveAutoTrade).toHaveBeenCalledWith('bar-123', expect.any(String), {
			cooldownKey: 'autotrade|BINANCE|BTCUSDT|1h|BUY', cooldownMs: 3600000,
		});
		await waitForBackgroundTasks();
	});

	it('still delivers the alert when the order bridge rejects the signal', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		enrichAlert.mockResolvedValue({ ...BULLISH_ENRICHMENT, sentiment_score: 0.05 });

		const response = await request(app)
			.post('/api/webhook/alert?autoTrade=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.autoTrade).toMatchObject({
			executed: false,
			reason: 'SENTIMENT_BELOW_THRESHOLD',
		});
		expect(response.body.results).toEqual(expect.arrayContaining([
			expect.objectContaining({ channel: 'telegram', success: true }),
		]));
		expect(mockPlaceOrder).not.toHaveBeenCalled();
	});

	it('still returns 200 when the Binance order call throws', async () => {
		process.env.ENABLE_AUTO_TRADE = 'true';
		mockPlaceOrder.mockRejectedValue(Object.assign(new Error('binance down'), { code: 'BINANCE_ORDER_FAILED' }));

		const response = await request(app)
			.post('/api/webhook/alert?autoTrade=true')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:BTCUSDT(1h) COMPRA' })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(response.body.autoTrade).toMatchObject({ executed: false, reason: 'ORDER_FAILED' });
		expect(response.body.results).toEqual(expect.arrayContaining([
			expect.objectContaining({ channel: 'telegram', success: true }),
		]));
	});
});
