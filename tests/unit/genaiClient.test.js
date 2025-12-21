/* global jest, describe, it, expect, beforeEach */

// Mock config before requiring genaiClient
jest.mock('../../src/services/grounding/config', () => ({
    GEMINI_API_KEY: 'test-key',
    GROUNDING_MODEL_NAME: 'test-model',
    ENABLE_NEWS_MONITOR_TEST_MODE: false,
    BRAVE_SEARCH_API_KEY: 'test-brave-key',
    BRAVE_SEARCH_ENDPOINT: 'https://api.search.brave.com/res/v1/web/search'
}));

const genaiClient = require('../../src/services/grounding/genaiClient');

// Mock fetch globally
global.fetch = jest.fn();

describe('GenaiClient robustness', () => {
	beforeEach(() => {
		// Reset genAI to avoid using the real SDK in tests
		genaiClient.genAI = { models: { generateContent: jest.fn().mockResolvedValue({}) } };
		jest.resetAllMocks();
	});

	describe('search edge cases', () => {
		it('returns empty results when Brave Search API returns unexpected shape or fails', async () => {
			// Mock fetch to return error or empty
			global.fetch.mockResolvedValue({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error'
			});

			const res = await genaiClient.search({ query: 'test', maxResults: 3 });
			expect(res).toHaveProperty('results');
			expect(Array.isArray(res.results)).toBe(true);
			expect(res.results.length).toBe(0);
			expect(res.totalResults).toBe(0);
			expect(res.searchResultText).toBe('No search results found.');
		});

		it('handles Brave Search results correctly', async () => {
			// Mock successful Brave response
			global.fetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					web: {
						results: [
							{
								title: 'Brave Result 1',
								url: 'https://brave.com/1',
								description: 'Snippet 1',
								profile: { name: 'Brave' }
							}
						]
					}
				})
			});

			// Mock LLM response
			genaiClient.genAI.models.generateContent.mockResolvedValue({
				response: {
					text: () => 'LLM Answer based on Brave',
				},
			});

			const { results, totalResults, searchResultText } = await genaiClient.search({ query: 'q', maxResults: 3 });

			expect(results).toHaveLength(1);
			expect(results[0].title).toBe('Brave Result 1');
			expect(results[0].url).toBe('https://brave.com/1');
			expect(results[0].sourceDomain).toBe('Brave');
			expect(totalResults).toBe(1);
			expect(searchResultText).toBe('LLM Answer based on Brave');

			// Verify fetch was called
			expect(global.fetch).toHaveBeenCalledTimes(1);
		});

		it('handles missing profile name by falling back to URL parsing', async () => {
			global.fetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					web: {
						results: [
							{
								title: 'Result 2',
								url: 'https://example.com/page',
								description: 'Snippet 2'
								// no profile
							}
						]
					}
				})
			});

			genaiClient.genAI.models.generateContent.mockResolvedValue({
				response: { text: () => 'Answer' }
			});

			const { results } = await genaiClient.search({ query: 'q' });
			expect(results[0].sourceDomain).toBe('example.com');
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
});
