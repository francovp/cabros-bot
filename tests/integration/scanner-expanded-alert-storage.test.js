'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callScanTool: jest.fn(),
		analyzeSymbolIdentifier: jest.fn(),
		callMultiTimeframeAnalysis: jest.fn(),
	},
}));

function saveEnv() {
	return { ...process.env };
}

function restoreEnv(saved) {
	if (!saved) return;
	for (const key of Object.keys(saved)) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
}

describe('Scanner & Expanded Analysis alert storage integration', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;
	let saveAlertSpy;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_MARKET_SCANNER: 'true',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
		});

		jest.clearAllMocks();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'tg-success' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));

		saveAlertSpy = jest.spyOn(alertStorageService, 'saveAlert').mockResolvedValue('mock-doc-id');
	});

	afterEach(() => {
		if (saveAlertSpy) saveAlertSpy.mockRestore();
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('Market Scanner', () => {
		it('persists delivered market-scanner alert with source: market-scanner', async () => {
			tradingViewMcpService.callScanTool.mockResolvedValueOnce([
				{ symbol: 'BINANCE:GMTUSDT', changePercent: 26.4, indicators: { close: 0.0134, RSI: 79.7 } },
			]);

			const res = await request(app)
				.post('/api/webhook/market-scanner-alert')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'], timeframe: '4h', exchange: 'BINANCE' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(saveAlertSpy).toHaveBeenCalledTimes(1);
			expect(saveAlertSpy).toHaveBeenCalledWith(expect.objectContaining({
				source: 'market-scanner',
				exchange: 'BINANCE',
				channels: expect.arrayContaining(['telegram']),
				deliveryResults: expect.arrayContaining([
					expect.objectContaining({ channel: 'telegram', success: true }),
				]),
			}));
		});

		it('skips persistence when dryRun is true', async () => {
			tradingViewMcpService.callScanTool.mockResolvedValueOnce([
				{ symbol: 'BINANCE:GMTUSDT', changePercent: 26.4 },
			]);

			const res = await request(app)
				.post('/api/webhook/market-scanner-alert?dryRun=true')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'], exchange: 'BINANCE' })
				.expect(200);

			expect(res.body.dryRun).toBe(true);
			expect(saveAlertSpy).not.toHaveBeenCalled();
		});

		it('fails open when alert storage persistence throws', async () => {
			tradingViewMcpService.callScanTool.mockResolvedValueOnce([
				{ symbol: 'BINANCE:GMTUSDT', changePercent: 26.4 },
			]);
			saveAlertSpy.mockRejectedValueOnce(new Error('Firestore write failed'));

			const res = await request(app)
				.post('/api/webhook/market-scanner-alert')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'], exchange: 'BINANCE' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(saveAlertSpy).toHaveBeenCalledTimes(1);
		});

		it('skips persistence when delivery fails on every channel', async () => {
			tradingViewMcpService.callScanTool.mockResolvedValueOnce([
				{ symbol: 'BINANCE:GMTUSDT', changePercent: 26.4 },
			]);
			mockTelegramSendMessage.mockRejectedValueOnce(new Error('Telegram offline'));

			const res = await request(app)
				.post('/api/webhook/market-scanner-alert')
				.set('x-api-key', 'test-key')
				.send({ scans: ['top_gainers'], exchange: 'BINANCE' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(saveAlertSpy).not.toHaveBeenCalled();
		});
	});

	describe('Expanded Analysis', () => {
		const baseAnalysis = {
			technical: {
				price_data: { current_price: 65000 },
				technical_indicators: { rsi: 55 },
				market_sentiment: { overall_sentiment: 'BULLISH', overall_rating: 0.8 },
			},
		};

		it('persists delivered expanded-analysis alert with source: expanded-analysis', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce(baseAnalysis);

			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'], timeframe: '1h' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(saveAlertSpy).toHaveBeenCalledTimes(1);
			expect(saveAlertSpy).toHaveBeenCalledWith(expect.objectContaining({
				source: 'expanded-analysis',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				channels: expect.arrayContaining(['telegram']),
			}));
		});

		it('skips persistence when dryRun is true', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce(baseAnalysis);

			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert?dryRun=true')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'] })
				.expect(200);

			expect(res.body.dryRun).toBe(true);
			expect(saveAlertSpy).not.toHaveBeenCalled();
		});

		it('fails open when alert storage persistence throws', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce(baseAnalysis);
			saveAlertSpy.mockRejectedValueOnce(new Error('Firestore write failed'));

			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'] })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(saveAlertSpy).toHaveBeenCalledTimes(1);
		});

		it('skips persistence when delivery fails on every channel', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce(baseAnalysis);
			mockTelegramSendMessage.mockRejectedValueOnce(new Error('Telegram offline'));

			const res = await request(app)
				.post('/api/webhook/expanded-analysis-alert')
				.set('x-api-key', 'test-key')
				.send({ symbols: ['BINANCE:BTCUSDT'] })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(saveAlertSpy).not.toHaveBeenCalled();
		});
	});
});
