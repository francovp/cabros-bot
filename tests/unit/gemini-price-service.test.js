'use strict';

const geminiPriceService = require('../../src/services/grounding/geminiPriceService');
const genaiClient = require('../../src/services/grounding/genaiClient');
const config = require('../../src/services/grounding/config');
const { getPromptService, PromptKeys } = require('../../src/services/prompts');

jest.mock('../../src/services/grounding/genaiClient');

describe('GeminiPriceService', () => {
	const originalGroundingEnv = process.env.ENABLE_GEMINI_GROUNDING;

	beforeEach(() => {
		jest.clearAllMocks();
		config.ENABLE_NEWS_MONITOR_TEST_MODE = false;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
	});

	afterEach(() => {
		config.ENABLE_NEWS_MONITOR_TEST_MODE = false;
		if (originalGroundingEnv !== undefined) {
			process.env.ENABLE_GEMINI_GROUNDING = originalGroundingEnv;
		} else {
			delete process.env.ENABLE_GEMINI_GROUNDING;
		}
	});

	describe('extractPriceJson', () => {
		it('returns null for null, undefined, or empty strings', () => {
			expect(geminiPriceService.extractPriceJson(null)).toBeNull();
			expect(geminiPriceService.extractPriceJson(undefined)).toBeNull();
			expect(geminiPriceService.extractPriceJson('')).toBeNull();
		});

		it('extracts JSON object containing price', () => {
			const text = 'Here is the market price: {"price": 65432.10, "change_24h": 2.5, "context": "Bullish trend"} from source.';
			const extracted = geminiPriceService.extractPriceJson(text);
			expect(extracted).toEqual({
				price: 65432.10,
				change_24h: 2.5,
				context: 'Bullish trend',
			});
		});

		it('returns null when no valid JSON is present', () => {
			const text = 'No JSON here, just plain price: $65,000';
			expect(geminiPriceService.extractPriceJson(text)).toBeNull();
		});
	});

	describe('fetchGeminiPrice', () => {
		it('returns null when ENABLE_GEMINI_GROUNDING is false and requireGroundingFlag is true', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'false';
			process.env.ENABLE_NEWS_MONITOR = 'true';
			config.ENABLE_NEWS_MONITOR_TEST_MODE = false;
			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT', { requireGroundingFlag: true });
			expect(res).toBeNull();
			expect(genaiClient.search).not.toHaveBeenCalled();
		});

		it('allows price fetch when ENABLE_NEWS_MONITOR is true even if ENABLE_GEMINI_GROUNDING is false', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'false';
			process.env.ENABLE_NEWS_MONITOR = 'true';
			config.ENABLE_NEWS_MONITOR_TEST_MODE = false;
			genaiClient.search.mockResolvedValue({
				searchResultText: '{"price": 50000, "change_24h": 1.0}',
			});

			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT');
			expect(res).not.toBeNull();
			expect(res.price).toBe(50000);
		});

		it('returns null when both ENABLE_GEMINI_GROUNDING and ENABLE_NEWS_MONITOR are false', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'false';
			process.env.ENABLE_NEWS_MONITOR = 'false';
			config.ENABLE_NEWS_MONITOR_TEST_MODE = false;
			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT');
			expect(res).toBeNull();
			expect(genaiClient.search).not.toHaveBeenCalled();
		});

		it('returns null when prompt resolution hangs beyond timeoutMs', async () => {
			const promptService = getPromptService();
			let testTimer = null;
			const spy = jest.spyOn(promptService, 'getTextPrompt').mockImplementation(() => new Promise((resolve) => {
				testTimer = setTimeout(resolve, 500);
			}));

			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT', { timeoutMs: 10 });
			expect(res).toBeNull();
			expect(genaiClient.search).not.toHaveBeenCalled();
			if (testTimer) clearTimeout(testTimer);
			spy.mockRestore();
		});

		it('returns null for empty or UNKNOWN symbol', async () => {
			expect(await geminiPriceService.fetchGeminiPrice('')).toBeNull();
			expect(await geminiPriceService.fetchGeminiPrice(null)).toBeNull();
			expect(await geminiPriceService.fetchGeminiPrice('UNKNOWN')).toBeNull();
			expect(genaiClient.search).not.toHaveBeenCalled();
		});

		it('returns mock data when test mode is enabled regardless of grounding gate', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'false';
			config.ENABLE_NEWS_MONITOR_TEST_MODE = true;
			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT');
			expect(res).toEqual(expect.objectContaining({
				price: 123.45,
				change24h: 1.23,
				source: 'gemini-grounding-test-mode',
			}));
			expect(genaiClient.search).not.toHaveBeenCalled();
		});

		it('fetches and parses grounded price successfully', async () => {
			genaiClient.search.mockResolvedValue({
				searchResultText: '{"price": 68500.25, "change_24h": -1.5, "context": "Market consolidating", "sources": ["https://coingecko.com"]}',
				usage: { promptTokens: 50, completionTokens: 20 },
			});

			const tokenUsage = { addUsage: jest.fn() };
			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT', { tokenUsage, timeoutMs: 5000 });

			expect(res).not.toBeNull();
			expect(res.price).toBe(68500.25);
			expect(res.change24h).toBe(-1.5);
			expect(res.source).toBe('gemini-grounding');
			expect(res.context).toBe('Market consolidating');
			expect(res.sources).toEqual(['https://coingecko.com']);
			expect(tokenUsage.addUsage).toHaveBeenCalled();
		});

		it('handles string numeric price values', async () => {
			genaiClient.search.mockResolvedValue({
				searchResultText: 'Current price: {"price": "2450.75", "change_24h": "3.2"}',
			});

			const res = await geminiPriceService.fetchGeminiPrice('ETHUSDT');
			expect(res).not.toBeNull();
			expect(res.price).toBe(2450.75);
			expect(res.change24h).toBe(3.2);
			expect(res.source).toBe('gemini-grounding');
		});

		it('returns null when parsed price is zero, negative, or invalid', async () => {
			genaiClient.search.mockResolvedValue({
				searchResultText: '{"price": 0, "change_24h": 0}',
			});
			expect(await geminiPriceService.fetchGeminiPrice('BTCUSDT')).toBeNull();

			genaiClient.search.mockResolvedValue({
				searchResultText: '{"price": -100}',
			});
			expect(await geminiPriceService.fetchGeminiPrice('BTCUSDT')).toBeNull();

			genaiClient.search.mockResolvedValue({
				searchResultText: '{"price": "invalid-number"}',
			});
			expect(await geminiPriceService.fetchGeminiPrice('BTCUSDT')).toBeNull();
		});

		it('returns null on timeout without throwing', async () => {
			genaiClient.search.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));
			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT', { timeoutMs: 10 });
			expect(res).toBeNull();
		});

		it('returns null on general search errors when rethrowQuotaErrors is false', async () => {
			genaiClient.search.mockRejectedValue(new Error('Network error'));
			const res = await geminiPriceService.fetchGeminiPrice('BTCUSDT', { rethrowQuotaErrors: false });
			expect(res).toBeNull();
		});

		it('rethrows quota errors when rethrowQuotaErrors is true', async () => {
			const quotaError = new Error('429 RESOURCE_EXHAUSTED: Quota exceeded');
			genaiClient.search.mockRejectedValue(quotaError);

			await expect(geminiPriceService.fetchGeminiPrice('BTCUSDT', { rethrowQuotaErrors: true }))
				.rejects.toThrow('RESOURCE_EXHAUSTED');
		});
	});
});
