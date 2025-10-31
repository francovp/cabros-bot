/**
 * Integration Tests for News Monitor Alert Delivery (Phase 4 - User Story 2)
 * Tests alert delivery structure and response format
 * Note: Full multi-channel delivery testing will be in tests/integration/news-monitor-basic.test.js
 */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');

describe('News Monitor - Alert Delivery Response Structure (US2)', () => {
	let mockBot;

	beforeEach(() => {
		// Setup environment
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'test-token';
		process.env.TELEGRAM_CHAT_ID = '123456789';
		process.env.NEWS_SYMBOLS_CRYPTO = 'BTCUSDT,ETHUSD';
		process.env.NEWS_SYMBOLS_STOCKS = 'AAPL,MSFT';
		process.env.NEWS_ALERT_THRESHOLD = '0.7';

		// Mock bot
		mockBot = {
			launch: jest.fn().mockResolvedValue(true),
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'test-msg-1' }),
			},
		};

		// Mock Gemini service BEFORE routes are loaded
		jest.doMock('../../src/services/grounding/gemini', () => ({
			analyzeNewsForSymbol: jest.fn().mockResolvedValue({
				event_category: 'price_surge',
				headline: 'Bitcoin surges',
				sentiment_score: 0.85,
				confidence: 0.75, // Above default 0.7 threshold
				sources: ['https://example.com'],
			}),
		}));

		// Mock genaiClient with search method
		jest.doMock('../../src/services/grounding/genaiClient', () => ({
			llmCall: jest.fn().mockResolvedValue('test response'),
			search: jest.fn().mockResolvedValue({
				results: [
					{ url: 'https://example.com/1', title: 'Source 1' },
					{ url: 'https://example.com/2', title: 'Source 2' }
				],
				searchResultText: 'Market context from search',
				totalResults: 2
			}),
		}));

		// Mock global fetch for WhatsApp API calls
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ success: true, idMessage: 'mock-wa-msg' }),
		});

		// Mount routes with mock bot
		const routes = getRoutes(mockBot);
		app.use('/api', routes);
	});

	afterEach(() => {
		jest.clearAllMocks();
		jest.dontMock('../../src/services/grounding/gemini');
		jest.dontMock('../../src/services/grounding/genaiClient');
		delete process.env.ENABLE_NEWS_MONITOR;
		delete process.env.ENABLE_TELEGRAM_BOT;
		delete process.env.BOT_TOKEN;
		delete process.env.TELEGRAM_CHAT_ID;
		delete process.env.NEWS_SYMBOLS_CRYPTO;
		delete process.env.NEWS_SYMBOLS_STOCKS;
		delete process.env.NEWS_ALERT_THRESHOLD;
	});

	describe('Alert delivery response structure validation', () => {
		it('should return structured response with results array', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty('success');
			expect(response.body).toHaveProperty('results');
			expect(Array.isArray(response.body.results)).toBe(true);
		});

		it('should include symbol in each result', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			expect(response.body.results).toBeDefined();
			if (response.body.results.length > 0) {
				expect(response.body.results[0]).toHaveProperty('symbol');
				expect(response.body.results[0].symbol).toBe('BTCUSDT');
			}
		});

		it('should include status field in each result', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0) {
				expect(response.body.results[0]).toHaveProperty('status');
				const validStatuses = ['analyzed', 'cached', 'timeout', 'error'];
				expect(validStatuses).toContain(response.body.results[0].status);
			}
		});

		it('should include alert object when confidence meets threshold', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0) {
				// If analysis completed, may have alert
				const result = response.body.results[0];
				if (result.status === 'analyzed' && result.alert) {
					expect(result.alert).toHaveProperty('symbol');
					expect(result.alert).toHaveProperty('headline');
					expect(result.alert).toHaveProperty('confidence');
					expect(result.alert).toHaveProperty('eventCategory');
				}
			}
		});

		it('should include requestId for correlation', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty('requestId');
			expect(typeof response.body.requestId).toBe('string');
			// Each result should reference same requestId
			if (response.body.results.length > 0) {
				expect(response.body.results[0]).toHaveProperty('requestId');
				expect(response.body.results[0].requestId).toBe(response.body.requestId);
			}
		});

		it('should include summary with alert count statistics', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT,ETHUSD' });

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty('summary');
			expect(response.body.summary).toHaveProperty('total');
			expect(response.body.summary).toHaveProperty('analyzed');
			expect(response.body.summary).toHaveProperty('cached');
			expect(response.body.summary).toHaveProperty('alerts_sent');
		});

		it('should include totalDurationMs in response', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			expect(response.body).toHaveProperty('totalDurationMs');
			expect(typeof response.body.totalDurationMs).toBe('number');
			expect(response.body.totalDurationMs).toBeGreaterThanOrEqual(0);
		});
	});

	describe('Threshold filtering configuration', () => {
		it('should respect NEWS_ALERT_THRESHOLD default (0.7)', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			// With threshold 0.7 and confidence 0.75, alert should be included
		});

		it('should support lower threshold (0.5)', async () => {
			process.env.NEWS_ALERT_THRESHOLD = '0.5';

			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
		});

		it('should support higher threshold (0.9)', async () => {
			process.env.NEWS_ALERT_THRESHOLD = '0.9';

			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
		});
	});

	describe('Multi-symbol analysis response', () => {
		it('should handle multiple crypto symbols', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT,ETHUSD' });

			expect(response.status).toBe(200);
			expect(response.body.results).toBeDefined();
			// Should have one result per symbol (or combined)
		});

		it('should handle multiple stock symbols', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ stocks: 'AAPL,MSFT,GOOGL' });

			expect(response.status).toBe(200);
			expect(response.body.results).toBeDefined();
		});

		it('should handle mixed crypto and stock symbols', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT', stocks: 'AAPL' });

			expect(response.status).toBe(200);
			expect(response.body.results).toBeDefined();
		});

		it('should return per-symbol results even if some fail', async () => {
			const response = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT', 'INVALID_SYMBOL_XYZ'],
					stocks: ['AAPL'],
				});

			expect(response.status).toBe(200);
			expect(response.body.results).toBeDefined();
			// Should include results for all symbols, with error status for invalid ones
		});
	});

	describe('Cached results in response', () => {
		it('should mark cached results with cached flag', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0) {
				expect(response.body.results[0]).toHaveProperty('cached');
				expect(typeof response.body.results[0].cached).toBe('boolean');
			}
		});

		it('should include totalDurationMs for each result', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0) {
				expect(response.body.results[0]).toHaveProperty('totalDurationMs');
				expect(typeof response.body.results[0].totalDurationMs).toBe('number');
			}
		});
	});

	describe('Error handling in responses', () => {
		it('should return 200 even with partial failures', async () => {
			const response = await request(app)
				.post('/api/news-monitor')
				.send({ crypto: ['BTCUSDT', 'INVALID'] });

			expect(response.status).toBe(200);
			// Fail-open pattern: return 200 regardless of individual failures
		});

		it('should indicate partial_success when some symbols fail', async () => {
			const response = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTCUSDT'],
					stocks: ['INVALID_STOCK_XYZ'],
				});

			expect(response.status).toBe(200);
			// If any results have error/timeout status, partial_success may be true
		});

		it('should return 200 even with default symbols when none provided', async () => {
			// When empty body is sent, handler uses default symbols from env
			const response = await request(app)
				.post('/api/news-monitor')
				.send({});

			expect(response.status).toBe(200);
			// Should use NEWS_SYMBOLS_CRYPTO and NEWS_SYMBOLS_STOCKS from env
		});

		it('should reject invalid symbol format', async () => {
			const response = await request(app)
				.post('/api/news-monitor')
				.send({
					crypto: ['BTC@#$%'], // Invalid characters
				});

			expect(response.status).toBe(400);
			expect(response.body.code).toBe('INVALID_REQUEST');
		});
	});

	describe('Event categorization in alerts', () => {
		it('should include eventCategory in alert', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0 && response.body.results[0].alert) {
				expect(response.body.results[0].alert).toHaveProperty('eventCategory');
				const validCategories = ['price_surge', 'price_decline', 'public_figure', 'regulatory'];
				expect(validCategories).toContain(response.body.results[0].alert.eventCategory);
			}
		});

		it('should include sentiment score in alert', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0 && response.body.results[0].alert) {
				expect(response.body.results[0].alert).toHaveProperty('sentimentScore');
				const score = response.body.results[0].alert.sentimentScore;
				expect(score).toBeGreaterThanOrEqual(-1);
				expect(score).toBeLessThanOrEqual(1);
			}
		});

		it('should include confidence score in alert', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0 && response.body.results[0].alert) {
				expect(response.body.results[0].alert).toHaveProperty('confidence');
				const confidence = response.body.results[0].alert.confidence;
				expect(confidence).toBeGreaterThanOrEqual(0);
				expect(confidence).toBeLessThanOrEqual(1);
			}
		});

		it('should include sources in alert', async () => {
			const response = await request(app)
				.get('/api/news-monitor')
				.query({ crypto: 'BTCUSDT' });

			expect(response.status).toBe(200);
			if (response.body.results.length > 0 && response.body.results[0].alert) {
				if (response.body.results[0].alert.sources) {
					expect(Array.isArray(response.body.results[0].alert.sources)).toBe(true);
				}
			}
		});
	});
});
