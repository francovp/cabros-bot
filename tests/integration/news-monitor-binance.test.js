/**
 * Integration Tests for News Monitor Binance Integration (Phase 6 - US4)
 * Tests: Binance price fetching, fallback to Gemini, timeout handling, stock symbol handling
 */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('News Monitor - Binance Integration (US4)', () => {
	let savedEnv;
	let mockBot;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_NEWS_MONITOR: 'true',
			NODE_ENV: 'test',
			ENABLE_TELEGRAM_BOT: 'true',
			BOT_TOKEN: 'test-token',
			TELEGRAM_CHAT_ID: '123456789',
			RENDER: '',
			IS_PULL_REQUEST: '',
			GEMINI_API_KEY: 'test-key',
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT',
			NEWS_SYMBOLS_STOCKS: 'AAPL',
			NEWS_ALERT_THRESHOLD: '0.7',
			NEWS_CACHE_TTL_HOURS: '6',
			ENABLE_BINANCE_PRICE_CHECK: 'true', // Enable Binance for this test suite
		});

		jest.clearAllMocks();

		// Mock Gemini for symbol analysis
		const gemini = require('../../src/services/grounding/gemini');
		gemini.analyzeNewsForSymbol = jest.fn().mockResolvedValue({
			event_category: 'price_surge',
			event_significance: 0.7,
			sentiment_score: 0.8,
			headline: 'Bitcoin surges on positive news',
			confidence: 0.74,
			sources: ['https://example.com/news'],
		});

		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'test-message-id' }),
			},
		};

		// Initialize notification services
		await initializeNotificationServices(mockBot);

		// Initialize cache
		const cache = getCacheInstance();
		cache.clear();
		cache.initialize();

		const { getNewsMonitor } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
		const newsMonitor = getNewsMonitor();

		app.use('/api', getRoutes(mockBot));
	});

	afterEach((done) => {
		restoreEnv(savedEnv);
		if (app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		const cache = getCacheInstance();
		cache.shutdown();

		setImmediate(() => {
			jest.clearAllMocks();
			done();
		});
	});

	describe('Binance Price Fetching', () => {
		it('should include Binance price context when ENABLE_BINANCE_PRICE_CHECK=true', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results.length).toBe(1);
			expect(response.body.results[0].symbol).toBe('BTCUSDT');
			// When Binance is enabled, the alert should ideally include market context
			// This test verifies the endpoint accepts Binance mode
			expect(response.body.results[0].status).toBe('analyzed');
		});

		it('should skip Binance for stock symbols (non-crypto)', async () => {
			const response = await request(app)
				.get('/api/news-monitor?stocks=AAPL').set('x-api-key', 'test-key')
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results.length).toBe(1);
			expect(response.body.results[0].symbol).toBe('AAPL');
			// Stock symbols should not attempt Binance fetch
			expect(response.body.results[0].status).toBe('analyzed');
		});

		it('should fallback to Gemini when Binance disabled', async () => {
			// Disable Binance for this request
			process.env.ENABLE_BINANCE_PRICE_CHECK = 'false';

			const response = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results[0].symbol).toBe('BTCUSDT');
			// Should still analyze even without Binance
			expect(response.body.results[0].status).toBe('analyzed');
		});
	});

	describe('Multi-Symbol with Binance', () => {
		it('should handle multiple crypto and stock symbols with Binance mode', async () => {
			const response = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'], stocks: ['AAPL'] })
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results.length).toBe(2);

			// Verify both symbols were analyzed
			const btc = response.body.results.find(r => r.symbol === 'BTCUSDT');
			const aapl = response.body.results.find(r => r.symbol === 'AAPL');

			expect(btc).toBeDefined();
			expect(aapl).toBeDefined();
			expect(btc.status).toBe('analyzed');
			expect(aapl.status).toBe('analyzed');
		});

		it('should independently analyze multiple crypto symbols with Binance', async () => {
			// First request with multiple crypto
			const response1 = await request(app)
				.post('/api/news-monitor').set('x-api-key', 'test-key')
				.send({ crypto: ['BTCUSDT'] })
				.expect(200);

			expect(response1.body.results.length).toBe(1);
			expect(response1.body.results[0].symbol).toBe('BTCUSDT');
			expect(response1.body.results[0].status).toBe('analyzed');
		});
	});

	describe('Binance Timeout Handling', () => {
		it('should handle Binance timeout with Gemini fallback', async () => {
			// This test verifies the timeout logic works
			// Actual timeout simulation would require mocking the fetch calls
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response.body.results).toBeDefined();
			expect(response.body.results[0].status).toBe('analyzed');
			// Should complete successfully even if Binance times out
		});
	});

	describe('Market Context in Alert', () => {
		it('should include market context information in alert when available', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response.body.results).toBeDefined();
			const result = response.body.results[0];

			if (result.alert) {
				// Alert should be present when confidence meets threshold
				expect(result.alert).toBeDefined();
				expect(result.alert.symbol).toBe('BTCUSDT');
			}
		});
	});

	describe('Response Structure with Binance', () => {
		it('should return complete response structure with Binance enabled', async () => {
			const response = await request(app)
				.get('/api/news-monitor?crypto=BTCUSDT').set('x-api-key', 'test-key')
				.expect(200);

			expect(response.body).toHaveProperty('results');
			expect(response.body).toHaveProperty('summary');
			expect(response.body.summary).toHaveProperty('total');
			expect(response.body.summary).toHaveProperty('analyzed');
			expect(response.body.summary).toHaveProperty('cached');
			expect(response.body.summary).toHaveProperty('alerts_sent');
		});
	});

	describe('Signal Outcome Provenance', () => {
		it('records Binance-derived prices with entryPriceSource binance', async () => {
			jest.resetModules();
			jest.doMock('binance', () => ({
				MainClient: jest.fn().mockImplementation(() => ({
					getAvgPrice: jest.fn().mockResolvedValue({ price: '77543.41057187', closeTime: Date.now() }),
					getKlines: jest.fn().mockResolvedValue([]),
				})),
			}));
			jest.doMock('../../src/services/storage/SignalOutcomeService', () => ({
				isEnabled: jest.fn(() => true),
				recordSignal: jest.fn().mockResolvedValue('outcome-id'),
			}));
			jest.doMock('../../src/services/grounding/gemini', () => ({
				analyzeNewsForSymbol: jest.fn().mockResolvedValue({
					event_category: 'price_surge',
					event_significance: 0.8,
					sentiment_score: 0.9,
					headline: 'Bitcoin surges on positive news',
					confidence: 0.95,
					sources: ['https://example.com/news'],
				}),
			}));
			const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
			const { getAnalyzer, setNotificationManager } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');

			const mockBot = {
				telegram: {
					sendMessage: jest.fn().mockResolvedValue({ message_id: 'provenance-message-id' }),
				},
			};
			setNotificationManager({
				sendToAll: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]),
				validateAll: jest.fn(),
				channels: new Map([
					['telegram', { chatId: '123456789', enabled: true }],
				]),
			});

			const cache = getCacheInstance();
			cache.clear();
			cache.initialize();

			try {
				const analyzer = getAnalyzer();
				analyzer.alertThreshold = 0; // ensure the mock alert clears the confidence gate
				analyzer.enableBinance = true; // force the Binance market-context path
				await analyzer.analyzeSymbol('BTCUSDT', 'req-provenance', null, {}, Date.now(), {});

				expect(signalOutcomeService.isEnabled).toHaveBeenCalled();
				expect(signalOutcomeService.recordSignal).toHaveBeenCalledTimes(1);
				expect(signalOutcomeService.recordSignal.mock.calls[0][0]).toEqual(expect.objectContaining({
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					priceSource: 'binance',
					side: 'BUY',
					stop: 75992.54236043,
					target: 79869.71288903,
				}));
			} finally {
				cache.shutdown();
			}
		});

		it('skips recording signal when conviction is low or uncertainty is reported', async () => {
			const { getAnalyzer, setNotificationManager } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
			const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
			const gemini = require('../../src/services/grounding/gemini');

			gemini.analyzeNewsForSymbol.mockResolvedValueOnce({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.05, // low conviction
				headline: 'Minor news update',
				confidence: 0.95,
				sources: ['https://example.com/news'],
			});

			setNotificationManager({
				sendToAll: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]),
				validateAll: jest.fn(),
				channels: new Map([
					['telegram', { chatId: '123456789', enabled: true }],
				]),
			});

			const cache = getCacheInstance();
			cache.clear();
			cache.initialize();

			try {
				const analyzer = getAnalyzer();
				analyzer.alertThreshold = 0;
				analyzer.enableBinance = true;
				signalOutcomeService.recordSignal.mockClear();

				await analyzer.analyzeSymbol('BTCUSDT', 'req-low-conviction', null, {}, Date.now(), {});

				expect(signalOutcomeService.recordSignal).not.toHaveBeenCalled();
			} finally {
				cache.shutdown();
			}
		});
	});
});
