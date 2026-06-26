// Mock config before requiring genaiClient
jest.mock('../../src/services/grounding/config', () => ({
	GEMINI_API_KEY: 'test-key',
	GROUNDING_MODEL_NAME: 'test-model',
	ENABLE_NEWS_MONITOR_TEST_MODE: false,
	GEMINI_MODEL_NAME: 'test-gemini-model',
	MODEL_PROVIDER: 'gemini',
	BRAVE_SEARCH_API_KEY: 'test-brave-key',
	BRAVE_SEARCH_ENDPOINT: 'https://api.search.brave.com/res/v1/web/search',
	FORCE_BRAVE_SEARCH: false,
	AZURE_LLM_MODEL: null,
	OPENROUTER_MODEL: null,
	GEMINI_MODEL_NAME_FALLBACK: 'gemini-2.5-flash-lite',
}));

const genaiClient = require('../../src/services/grounding/genaiClient');
const sentryService = require('../../src/services/monitoring/SentryService');

// Mock fetch globally
global.fetch = jest.fn();

describe('GenaiClient robustness', () => {
	beforeEach(() => {
		// Reset genAI to avoid using the real SDK in tests
		genaiClient.genAI = { models: { generateContent: jest.fn().mockResolvedValue({}) } };
		jest.resetAllMocks();
	});

	describe('Google Search (Default)', () => {
		it('uses Google Search when FORCE_BRAVE_SEARCH is false', async () => {
			// Mock successful Google Search response
			genaiClient.genAI.models.generateContent.mockResolvedValueOnce({
				response: {
					text: 'Google Answer',
					candidates: [{
						groundingMetadata: {
							groundingChunks: [{ web: { title: 'G1', uri: 'http://g1.com', domain: 'g1.com' } }],
						},
					}],
				},
			});

			const res = await genaiClient.search({ query: 'test' });

			expect(res.results).toHaveLength(1);
			expect(res.results[0].title).toBe('G1');
			expect(res.searchResultText).toBe('Google Answer');

			// Should not call Brave (fetch)
			expect(global.fetch).not.toHaveBeenCalled();
		});
	});

	describe('Fallback to Brave', () => {
		it('falls back to Brave when Google Search fails', async () => {
			// Mock Google Search failure
			genaiClient.genAI.models.generateContent.mockRejectedValueOnce(new Error('Google API Error'));

			// Mock Brave Search success (fetch)
			global.fetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					web: { results: [{ title: 'Brave1', url: 'http://b1.com' }] },
				}),
			});

			const res = await genaiClient.search({ query: 'test' });

			expect(res.results).toHaveLength(1);
			expect(res.results[0].title).toBe('Brave1');
			expect(res.searchResultText).toContain('[1] Title: Brave1');
			expect(res.searchResultText).toContain('URL: http://b1.com');
			expect(global.fetch).toHaveBeenCalledTimes(1);
		});

		it('falls back to Brave for Gemini quota exhaustion by default', async () => {
			const quotaError = Object.assign(
				new Error('429 RESOURCE_EXHAUSTED: {"error":{"details":[{"retryDelay":"30s"}]}}'),
				{ status: 429 },
			);
			genaiClient.genAI.models.generateContent.mockRejectedValueOnce(quotaError);
			global.fetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					web: { results: [{ title: 'BraveQuotaFallback', url: 'http://quota-fallback.com' }] },
				}),
			});

			const res = await genaiClient.search({ query: 'test' });

			expect(res.results).toHaveLength(1);
			expect(res.results[0].title).toBe('BraveQuotaFallback');
			expect(global.fetch).toHaveBeenCalledTimes(1);
		});

		it('rethrows Gemini quota exhaustion when requested by caller', async () => {
			const quotaError = Object.assign(
				new Error('429 RESOURCE_EXHAUSTED: {"error":{"details":[{"retryDelay":"30s"}]}}'),
				{ status: 429 },
			);
			genaiClient.genAI.models.generateContent.mockRejectedValueOnce(quotaError);

			await expect(genaiClient.search({ query: 'test', rethrowQuotaErrors: true }))
				.rejects
				.toThrow('RESOURCE_EXHAUSTED');
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it('falls back to Brave when Google Search returns no results', async () => {
			// Mock empty Google Search response
			genaiClient.genAI.models.generateContent.mockResolvedValueOnce({
				response: {
					candidates: [{
						groundingMetadata: { groundingChunks: [] },
					}],
				},
			});

			// Mock Brave Search success
			global.fetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					web: { results: [{ title: 'Brave1', url: 'http://b1.com' }] },
				}),
			});

			const res = await genaiClient.search({ query: 'test' });

			expect(res.results).toHaveLength(1);
			expect(res.results[0].title).toBe('Brave1');
			expect(res.searchResultText).toContain('[1] Title: Brave1');
		});
	});

	describe('Forced Brave Search', () => {
		it('uses Brave Search directly when FORCE_BRAVE_SEARCH is true', async () => {
			jest.resetModules();
			jest.doMock('../../src/services/grounding/config', () => ({
				GEMINI_API_KEY: 'test-key',
				GROUNDING_MODEL_NAME: 'test-model',
				ENABLE_NEWS_MONITOR_TEST_MODE: false,
				GEMINI_MODEL_NAME: 'test-gemini-model',
				MODEL_PROVIDER: 'gemini',
				BRAVE_SEARCH_API_KEY: 'test-brave-key',
				BRAVE_SEARCH_ENDPOINT: 'https://api.search.brave.com/res/v1/web/search',
				FORCE_BRAVE_SEARCH: true,
				AZURE_LLM_MODEL: null,
				OPENROUTER_MODEL: null,
				GEMINI_MODEL_NAME_FALLBACK: 'gemini-2.5-flash-lite',
			}));

			const forcedGenaiClient = require('../../src/services/grounding/genaiClient');
			forcedGenaiClient.genAI = { models: { generateContent: jest.fn() } };

			const googleSpy = jest.spyOn(forcedGenaiClient, '_executeGoogleSearch');
			const braveSpy = jest.spyOn(forcedGenaiClient, '_executeBraveSearch');

			// Mock Brave Search success
			global.fetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					web: { results: [{ title: 'BraveForce', url: 'http://bf.com' }] },
				}),
			});

			const res = await forcedGenaiClient.search({ query: 'test' });

			expect(res.results[0].title).toBe('BraveForce');
			expect(res.searchResultText).toContain('[1] Title: BraveForce');
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(braveSpy).toHaveBeenCalledTimes(1);
			expect(googleSpy).not.toHaveBeenCalled();
			expect(forcedGenaiClient.genAI.models.generateContent).not.toHaveBeenCalled();
		});
	});

	describe('llmCall parsing', () => {
		it('parses text() response when available', async () => {
			genaiClient.genAI.models.generateContent.mockResolvedValue({
				response: { text: () => 'hello from text()' },
			});

			const out = await genaiClient.llmCall({ prompt: 'p', context: { citations: ['a'] } });
			expect(out.text).toBe('hello from text()');
			expect(out.citations).toEqual(['a']);
		});

		it('parses from candidate content structure', async () => {
			genaiClient.genAI.models.generateContent.mockResolvedValue({
				response: {
					candidates: [
						{ content: { parts: [{ text: 'candidate text' }] } },
					],
				},
			});

			const out = await genaiClient.llmCall({ prompt: 'p' });
			expect(out.text).toBe('candidate text');
		});

		it('parses from candidate.output when available', async () => {
			genaiClient.genAI.models.generateContent.mockResolvedValue({
				response: {
					candidates: [
						{ output: [{ text: 'from output' }] },
					],
				},
			});

			const out = await genaiClient.llmCall({ prompt: 'p' });
			expect(out.text).toBe('from output');
		});

		it('returns empty string for unexpected response shape', async () => {
			genaiClient.genAI.models.generateContent.mockResolvedValue({});

			const out = await genaiClient.llmCall({ prompt: 'p' });
			expect(out.text).toBe('');
			expect(out.citations).toEqual([]);
		});
	});

	describe('_isNonRetryableGeminiError', () => {
		it('returns true for 400 FAILED_PRECONDITION errors from Gemini SDK', () => {
			const error = Object.assign(
				new Error('User location is not supported for the API use.'),
				{ status: 400, code: 'FAILED_PRECONDITION' },
			);
			expect(genaiClient._isNonRetryableGeminiError(error)).toBe(true);
		});

		it('returns true for 403 PERMISSION_DENIED errors', () => {
			const error = Object.assign(
				new Error('Permission denied.'),
				{ status: 403, code: 'PERMISSION_DENIED' },
			);
			expect(genaiClient._isNonRetryableGeminiError(error)).toBe(true);
		});

		it('returns false for 500 INTERNAL errors (retryable)', () => {
			const error = Object.assign(
				new Error('Internal error encountered.'),
				{ status: 500, code: 'INTERNAL' },
			);
			expect(genaiClient._isNonRetryableGeminiError(error)).toBe(false);
		});

		it('returns false for 503 UNAVAILABLE errors (retryable)', () => {
			const error = Object.assign(
				new Error('Service unavailable.'),
				{ status: 503, code: 'UNAVAILABLE' },
			);
			expect(genaiClient._isNonRetryableGeminiError(error)).toBe(false);
		});

		it('returns false for 429 RATE_LIMITED errors (retryable)', () => {
			const error = Object.assign(
				new Error('Rate limited.'),
				{ status: 429, code: 'RATE_LIMITED' },
			);
			expect(genaiClient._isNonRetryableGeminiError(error)).toBe(false);
		});

		it('returns false for null/undefined errors', () => {
			expect(genaiClient._isNonRetryableGeminiError(null)).toBe(false);
			expect(genaiClient._isNonRetryableGeminiError(undefined)).toBe(false);
		});
	});

	describe('llmCall non-retryable error classification', () => {
		it('throws NonRetryableProviderError when Gemini returns 400 FAILED_PRECONDITION', async () => {
			const apiError = Object.assign(
				new Error('User location is not supported for the API use.'),
				{ status: 400, code: 'FAILED_PRECONDITION' },
			);
			genaiClient.genAI.models.generateContent.mockRejectedValueOnce(apiError);

			await expect(genaiClient.llmCall({ prompt: 'test' }))
				.rejects
				.toThrow('LLM provider configuration error');
		});

		it('throws regular Error for 500 INTERNAL errors (retryable)', async () => {
			const apiError = Object.assign(
				new Error('Internal server error'),
				{ status: 500 },
			);
			genaiClient.genAI.models.generateContent.mockRejectedValueOnce(apiError);

			await expect(genaiClient.llmCall({ prompt: 'test' }))
				.rejects
				.toThrow('LLM call failed');
		});
	});

	describe('llmCallv2 skips failover for NonRetryableProviderError', () => {
		it('throws NonRetryableProviderError directly without attempting failover', async () => {
			const apiError = Object.assign(
				new Error('User location is not supported for the API use.'),
				{ status: 400, code: 'FAILED_PRECONDITION' },
			);
			genaiClient.genAI.models.generateContent.mockRejectedValue(apiError);

			const azureClient = require('../../src/services/inference/azureAiClient');
			const openRouterClient = require('../../src/services/inference/openRouterClient');
			const azureSpy = jest.spyOn(azureClient, 'getAzureAIClient');
			const openRouterSpy = jest.spyOn(openRouterClient, 'getOpenRouterClient');

			await expect(genaiClient.llmCallv2({
				systemPrompt: 'system',
				userPrompt: 'user',
			})).rejects.toThrow('LLM provider configuration error');

			// Azure and OpenRouter should NOT be called
			expect(azureSpy).not.toHaveBeenCalled();
			expect(openRouterSpy).not.toHaveBeenCalled();
		});
	});

	describe('llmCallv2 metrics', () => {
		it('captures Gemini metrics with the resolved model name', async () => {
			const captureSpy = jest.spyOn(sentryService, 'captureLlmMetric').mockImplementation(() => {});
			genaiClient.llmCall = jest.fn().mockResolvedValue({
				text: 'llm response',
				citations: [],
				usage: {
					inputTokens: 12,
					outputTokens: 34,
				},
			});

			const out = await genaiClient.llmCallv2({
				systemPrompt: 'system',
				userPrompt: 'user',
			});

			expect(out.modelUsed).toBe('test-gemini-model');
			expect(captureSpy).toHaveBeenCalledWith(expect.objectContaining({
				model: 'test-gemini-model',
				inputTokens: 12,
				outputTokens: 34,
				durationMs: expect.any(Number),
			}));
			captureSpy.mockRestore();
		});
	});
});
