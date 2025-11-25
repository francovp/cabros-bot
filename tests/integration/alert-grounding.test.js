/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const genaiClient = require('../../src/services/grounding/genaiClient');
const gemini = require('../../src/services/grounding/gemini');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');

// Define mock search results
const mockSearchResults = [
	{
		title: 'Test Result 1',
		snippet: 'Test snippet 1',
		url: 'https://test1.com',
		sourceDomain: 'test1.com',
	},
	{
		title: 'Test Result 2',
		snippet: 'Test snippet 2',
		url: 'https://test2.com',
		sourceDomain: 'test2.com',
	},
];

// Mock the Gemini API client
jest.mock('../../src/services/grounding/genaiClient');

describe('Alert Grounding Integration', () => {
	let mockTelegramSendMessage;
	let mockFetch;
	const originalEnv = process.env;

	beforeEach(async () => {
		// Mock environment variables
		process.env = {
			...originalEnv,
			ENABLE_GEMINI_GROUNDING: 'true',
			GEMINI_API_KEY: 'test-gemini-key',
			TELEGRAM_CHAT_ID: '123456789',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: '987654321',
			BOT_TOKEN: 'test-bot-token',
			ENABLE_TELEGRAM_BOT: 'true',
			GROUNDING_MAX_SOURCES: '3',
			GROUNDING_TIMEOUT_MS: '8000',
		};

		// Reset all mocks
		jest.clearAllMocks();

		// Mock Gemini client responses
		genaiClient.search.mockResolvedValue({
			results: mockSearchResults,
		});

		genaiClient.llmCall.mockResolvedValue({
			text: JSON.stringify({
				sentiment: 'BULLISH',
				sentiment_score: 0.9,
				insights: ['Insight 1', 'Insight 2'],
				technical_levels: {
					supports: ['80000'],
					resistances: ['85000'],
				},
			}),
			citations: mockSearchResults,
		});

		// Mock Telegram bot
		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-message-id' });
		const bot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		// Mock fetch for WhatsApp (will be disabled anyway)
		mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ success: true }),
		});
		global.fetch = mockFetch;

		// Initialize notification services
		await initializeNotificationServices(bot);

		// Mount routes
		app.use('/api', getRoutes());
	});

	afterEach(() => {
		process.env = originalEnv;
		// Remove mounted routes
		if (app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		jest.resetModules();
	});

	describe('POST /api/webhook/alert', () => {
		it('should enrich alert with grounded context', async () => {
			const alertText = 'Bitcoin breaks $50,000 mark';

			const response = await request(app)
				.post('/api/webhook/alert')
				.send({ text: alertText })
				.expect(200);

			console.log('Response body:', JSON.stringify(response.body, null, 2));
			console.log('Mock Telegram calls:', mockTelegramSendMessage.mock.calls.length);

			expect(response.body.success).toBe(true);
			expect(response.body.enriched).toBe(true);
			expect(Array.isArray(response.body.results)).toBe(true);

			// Verify at least telegram is in results
			const telegramResult = response.body.results.find(r => r.channel === 'telegram');
			expect(telegramResult).toBeDefined();
			expect(telegramResult.success).toBe(true);

			// Verify Telegram message content
			if (mockTelegramSendMessage.mock.calls.length > 0) {
				const telegramCall = mockTelegramSendMessage.mock.calls[0];
				const messageText = telegramCall[1];
				// Assertions for new enriched format
				expect(messageText).toContain('Sentiment: BULLISH');
				expect(messageText).toContain('*Key Insights*');
				expect(messageText).toContain('Insight 1');
				expect(messageText).toContain('*Technical Levels*');
				expect(messageText).toContain('Supports: 80000');
				expect(messageText).toContain('*Sources*');
				expect(messageText).toContain('[Test Result 1](https://test1.com)');
			}
		}, 10000);

		it('should handle invalid Gemini JSON by degrading to safe alert', async () => {
			// Mock invalid JSON response
			genaiClient.llmCall.mockResolvedValue({
				text: 'Invalid JSON',
				citations: mockSearchResults,
			});

			const alertText = 'Test alert';

			const response = await request(app)
				.post('/api/webhook/alert')
				.send({ text: alertText })
				.expect(200);

			expect(response.body.success).toBe(true);
			// Should be true because we degrade to a safe enriched alert
			expect(response.body.enriched).toBe(true);
			expect(Array.isArray(response.body.results)).toBe(true);

			// Verify telegram result
			const telegramResult = response.body.results.find(r => r.channel === 'telegram');
			expect(telegramResult).toBeDefined();
			expect(telegramResult.success).toBe(true);

			// Verify message content indicates degradation
			if (mockTelegramSendMessage.mock.calls.length > 0) {
				const telegramCall = mockTelegramSendMessage.mock.calls[0];
				const messageText = telegramCall[1];
				expect(messageText).toContain('NEUTRAL');
				// The degraded alert might have specific insights or empty ones
				// Depending on implementation of _createDegradedAlert
			}
		});

		it('should handle grounding failure gracefully', async () => {
			// Mock search failure
			genaiClient.search.mockRejectedValueOnce(new Error('Search API error'));

			const alertText = 'Test alert';

			const response = await request(app)
				.post('/api/webhook/alert')
				.send({ text: alertText })
				.expect(200);

			expect(response.body.success).toBe(true);
			expect(response.body.enriched).toBe(false);
			expect(Array.isArray(response.body.results)).toBe(true);

			// Verify telegram result in results array
			const telegramResult = response.body.results.find(r => r.channel === 'telegram');
			expect(telegramResult).toBeDefined();
			expect(telegramResult.success).toBe(true);
		});

		it('should respect grounding timeout', async () => {
			// Simulate grounded summary taking too long by never resolving the
			// generateEnrichedAlert function (groundAlert times out around it)
			jest.spyOn(gemini, 'generateEnrichedAlert').mockImplementationOnce(() => new Promise(() => {
				// never resolve to trigger grounding timeout
			}));

			const alertText = 'Test alert';

			const response = await request(app)
				.post('/api/webhook/alert')
				.send({ text: alertText })
				.expect(200);

			expect(response.body.success).toBe(true);
			expect(response.body.enriched).toBe(false);
			expect(Array.isArray(response.body.results)).toBe(true);

			// Verify telegram result
			const telegramResult = response.body.results.find(r => r.channel === 'telegram');
			expect(telegramResult).toBeDefined();
			expect(telegramResult.success).toBe(true);
		}, 15000);

		it('should handle disabled grounding gracefully', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'false';

			const alertText = 'Test alert';

			const response = await request(app)
				.post('/api/webhook/alert')
				.send({ text: alertText })
				.expect(200);

			expect(response.body.success).toBe(true);
			expect(response.body.enriched).toBe(false);
			expect(Array.isArray(response.body.results)).toBe(true);

			// Verify no API calls were made
			expect(genaiClient.search).not.toHaveBeenCalled();
			expect(genaiClient.llmCall).not.toHaveBeenCalled();

			// Verify telegram result
			const telegramResult = response.body.results.find(r => r.channel === 'telegram');
			expect(telegramResult).toBeDefined();
			expect(telegramResult.success).toBe(true);
		});
	});
});