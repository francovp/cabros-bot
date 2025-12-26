/* global jest, describe, it, expect, beforeEach */

// Mock config before requiring genaiClient
jest.mock('../../src/services/grounding/config', () => ({
    GEMINI_API_KEY: 'test-key',
    GROUNDING_MODEL_NAME: 'test-model',
    ENABLE_NEWS_MONITOR_TEST_MODE: false,
    BRAVE_SEARCH_API_KEY: 'test-brave-key',
    BRAVE_SEARCH_ENDPOINT: 'https://api.search.brave.com/res/v1/web/search',
    FORCE_BRAVE_SEARCH: false
}));

const genaiClient = require('../../src/services/grounding/genaiClient');
const config = require('../../src/services/grounding/config');

// Mock fetch globally
global.fetch = jest.fn();

describe('GenaiClient robustness', () => {
	beforeEach(() => {
		// Reset genAI to avoid using the real SDK in tests
		genaiClient.genAI = { models: { generateContent: jest.fn().mockResolvedValue({}) } };
		jest.resetAllMocks();
        // Reset config mock
        config.FORCE_BRAVE_SEARCH = false;
	});

	describe('Google Search (Default)', () => {
        it('uses Google Search when FORCE_BRAVE_SEARCH is false', async () => {
            // Mock successful Google Search response
            genaiClient.genAI.models.generateContent.mockResolvedValueOnce({
                response: {
                    text: 'Google Answer',
                    candidates: [{
                        groundingMetadata: {
                            groundingChunks: [{ web: { title: 'G1', uri: 'http://g1.com', domain: 'g1.com' } }]
                        }
                    }]
                }
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
                    web: { results: [{ title: 'Brave1', url: 'http://b1.com' }] }
                })
            });

            // Mock LLM call for grounding Brave results
            genaiClient.genAI.models.generateContent.mockResolvedValueOnce({
                response: { text: () => 'Brave Answer' }
            });

            const res = await genaiClient.search({ query: 'test' });

            expect(res.results).toHaveLength(1);
            expect(res.results[0].title).toBe('Brave1');
            expect(res.searchResultText).toBe('Brave Answer');
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('falls back to Brave when Google Search returns no results', async () => {
             // Mock empty Google Search response
             genaiClient.genAI.models.generateContent.mockResolvedValueOnce({
                response: {
                    candidates: [{
                        groundingMetadata: { groundingChunks: [] }
                    }]
                }
            });

            // Mock Brave Search success
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: { results: [{ title: 'Brave1', url: 'http://b1.com' }] }
                })
            });

            // Mock LLM call for grounding Brave results
            genaiClient.genAI.models.generateContent.mockResolvedValueOnce({
                response: { text: () => 'Brave Answer' }
            });

            const res = await genaiClient.search({ query: 'test' });

            expect(res.results).toHaveLength(1);
            expect(res.results[0].title).toBe('Brave1');
        });
    });

    describe('Forced Brave Search', () => {
        it('uses Brave Search directly when FORCE_BRAVE_SEARCH is true', async () => {
            config.FORCE_BRAVE_SEARCH = true;

             // Mock Brave Search success
             global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: { results: [{ title: 'BraveForce', url: 'http://bf.com' }] }
                })
            });

            // Mock LLM call for grounding
            genaiClient.genAI.models.generateContent.mockResolvedValueOnce({
                response: { text: () => 'Brave Force Answer' }
            });

            const res = await genaiClient.search({ query: 'test' });

            expect(res.results[0].title).toBe('BraveForce');

            // Should call fetch
            expect(global.fetch).toHaveBeenCalledTimes(1);

            // Should call LLM only once (for grounding), not twice (Google + Grounding)
            // But wait, checking usage of generateContent for Google vs LLM is tricky since it's the same method.
            // Google search call has tools in config. LLM call does not (or has empty tools/different config).
            // We can check arguments of the first call.

            const firstCallArgs = genaiClient.genAI.models.generateContent.mock.calls[0][0];
            expect(firstCallArgs.config.tools).toBeUndefined(); // LLM call doesn't have search tools
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
