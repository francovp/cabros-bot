/* global describe, it, expect, jest */

const { groundAlert } = require('../../src/services/grounding/grounding');
const { generateEnrichedAlert } = require('../../src/services/grounding/gemini');
const genaiClient = require('../../src/services/grounding/genaiClient');

jest.mock('../../src/services/grounding/metrics');
jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('Grounding Service', () => {
	describe('groundAlert', () => {
		it('should enrich alert with search results and summary', async () => {
			// Mock search results
			const searchResults = [
				{
					title: 'Test Article',
					snippet: 'Sample snippet',
					url: 'https://test.com',
					sourceDomain: 'test.com',
				},
			];

			// Mock search response
			genaiClient.search.mockResolvedValueOnce({
				results: searchResults,
				totalResults: 1,
			});

			// Mock summary generation
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				insights: ['Test summary'],
				technical_levels: { supports: [], resistances: [] },
				sources: searchResults,
			});

			const result = await groundAlert({
				text: 'Test alert',
			});

			expect(result.insights[0]).toBe('Test summary');
			expect(result.sources).toHaveLength(1);
			expect(result.sentiment_score).toBe(0.85);
			expect(result.truncated).toBe(false);

			// Verify search and LLM were called
			expect(genaiClient.search).toHaveBeenCalled();
			expect(generateEnrichedAlert).toHaveBeenCalled();
		});

		it('should handle long text by truncating', async () => {
			const longText = 'x'.repeat(5000);

			// Mock successful grounding
			genaiClient.search.mockResolvedValueOnce({
				results: [],
				totalResults: 0,
			});

			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: ['Summary of truncated text'],
				technical_levels: { supports: [], resistances: [] },
				sources: [],
			});

			const result = await groundAlert({
				text: longText,
			});

			expect(result.truncated).toBe(true);
		});

		it('should handle timeouts', async () => {
			// Mock slow responses for both search and LLM
			genaiClient.llmCall.mockImplementationOnce(() => new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Grounding timeout')), 2000);
			}));

			genaiClient.search.mockImplementationOnce(() => new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Grounding timeout')), 2000);
			}));

			await expect(groundAlert({
				text: 'Test',
				options: { timeoutMs: 100 },
			})).rejects.toThrow('Grounding timeout');
		});

		it('should handle API errors gracefully', async () => {
			genaiClient.search.mockRejectedValueOnce(new Error('API error'));

			await expect(groundAlert({
				text: 'Test',
			})).rejects.toThrow('Grounding failed: API error');
		});

		it('should use ALERT_ENRICHMENT prompt by default', async () => {
			genaiClient.search.mockResolvedValueOnce({ results: [], totalResults: 0 });
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: [],
				technical_levels: { supports: [], resistances: [] },
				sources: [],
			});

			await groundAlert({ text: 'Test alert text' });

			expect(generateEnrichedAlert).toHaveBeenCalledWith(expect.objectContaining({
				options: expect.objectContaining({
					systemPrompt: expect.stringContaining('structured insights, sentiment, and technical levels'),
				}),
			}));
		});

		it('should use NEWS_ANALYSIS prompt when requested', async () => {
			genaiClient.search.mockResolvedValueOnce({ results: [], totalResults: 0 });
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: [],
				technical_levels: { supports: [], resistances: [] },
				sources: [],
			});

			await groundAlert({
				text: 'Test alert text',
				options: { promptType: 'NEWS_ANALYSIS' },
			});

			expect(generateEnrichedAlert).toHaveBeenCalledWith(expect.objectContaining({
				options: expect.objectContaining({
					systemPrompt: expect.stringContaining('sentiment analyst specializing in crypto and stock news'),
				}),
			}));
		});
	});
});