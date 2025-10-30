/* global jest, describe, it, expect, beforeEach */

const genaiClient = require('../../src/services/grounding/genaiClient');

describe('GenaiClient robustness', () => {
    beforeEach(() => {
        // Reset genAI to avoid using the real SDK in tests
        genaiClient.genAI = { models: { generateContent: jest.fn().mockResolvedValue({}) } };
        jest.resetAllMocks();
    });

    describe('search edge cases', () => {
        it('returns empty results when generateContent returns unexpected shape', async () => {
            genaiClient.genAI.models.generateContent.mockResolvedValue({});

            const res = await genaiClient.search({ query: 'test', maxResults: 3 });
            expect(res).toHaveProperty('results');
            expect(Array.isArray(res.results)).toBe(true);
            expect(res.results.length).toBe(0);
            expect(res.totalResults).toBe(0);
        });

        it('handles grounding chunks with missing uri/domain without throwing', async () => {
            genaiClient.genAI.models.generateContent.mockResolvedValue({
                response: {
                    candidates: [
                        {
                            groundingMetadata: {
                                groundingChunks: [
                                    { web: { title: 'T', snippet: 'S' } },
                                ],
                            },
                        },
                    ],
                },
            });

            const { results, totalResults } = await genaiClient.search({ query: 'q', maxResults: 3 });
            expect(results).toHaveLength(1);
            expect(results[0].url).toBe('');
            expect(results[0].sourceDomain).toBe('');
            expect(totalResults).toBe(1);
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
                        { content: [{ text: 'candidate text' }] },
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
