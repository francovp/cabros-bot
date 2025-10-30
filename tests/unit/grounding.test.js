/* global describe, it, expect, jest */

const { groundAlert } = require('../../src/services/grounding/grounding');
const { generateGroundedSummary } = require('../../src/services/grounding/gemini');
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
			generateGroundedSummary.mockResolvedValueOnce({
				summary: 'Test summary',
				citations: searchResults,
				confidence: 0.85,
			});

			const result = await groundAlert({
				text: 'Test alert',
			});

			expect(result.summary).toBe('Test summary');
			expect(result.citations).toHaveLength(1);
			expect(result.confidence).toBe(0.85);
			expect(result.truncated).toBe(false);

			// Verify search and LLM were called
			expect(genaiClient.search).toHaveBeenCalled();
			expect(generateGroundedSummary).toHaveBeenCalled();
		});

		it('should handle long text by truncating', async () => {
			const longText = 'x'.repeat(5000);

			// Mock successful grounding
			genaiClient.search.mockResolvedValueOnce({
				results: [],
				totalResults: 0,
			});

			generateGroundedSummary.mockResolvedValueOnce({
				summary: 'Summary of truncated text',
				citations: [],
				confidence: 0.5,
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
	});
});