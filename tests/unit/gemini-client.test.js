/* global jest, describe, it, expect, beforeEach */

const { generateGroundedSummary } = require('../../src/services/grounding/gemini');
const genaiClient = require('../../src/services/grounding/genaiClient');

jest.mock('../../src/services/grounding/genaiClient');
jest.mock('../../src/services/grounding/config', () => ({
	GEMINI_SYSTEM_PROMPT: 'Test system prompt',
}));

describe('Gemini Service', () => {
	beforeEach(() => {
		jest.resetAllMocks();
	});

	describe('generateGroundedSummary', () => {
		const mockSearchResults = [{
			title: 'Test Source',
			snippet: 'Test snippet',
			url: 'https://test.com',
			sourceDomain: 'test.com',
		}];

		it('should generate summary with citations', async () => {
			genaiClient.llmCall.mockResolvedValue({
				text: 'Test summary',
				citations: mockSearchResults,
			});

			const result = await generateGroundedSummary({
				text: 'Test alert',
				searchResults: mockSearchResults,
			});

			expect(result.summary).toBe('Test summary');
			expect(result.citations).toEqual(mockSearchResults);
			expect(result.confidence).toBe(0.85);

			expect(genaiClient.llmCall).toHaveBeenCalledWith({
				prompt: expect.stringContaining('Test alert'),
				context: { citations: mockSearchResults },
				opts: expect.objectContaining({
					model: 'gemini-2.0-flash',
					temperature: 0.2,
				}),
			});
		});

		it('should respect maxLength option', async () => {
			const longText = 'x'.repeat(300);
			genaiClient.llmCall.mockResolvedValue({
				text: longText,
				citations: [],
			});

			const result = await generateGroundedSummary({
				text: 'Test alert',
				searchResults: [],
				options: { maxLength: 250 },
			});

			expect(result.summary.length).toBeLessThanOrEqual(250);
		});

		it('should preserve language when specified', async () => {
			const nonEnglishText = '¡Hola mundo!';
			genaiClient.llmCall.mockResolvedValue({
				text: 'Test summary',
				citations: [],
			});

			await generateGroundedSummary({
				text: nonEnglishText,
				searchResults: [],
				options: { preserveLanguage: true },
			});

			expect(genaiClient.llmCall).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('Respond in unknown language'),
				}),
			);
		});

		it('should handle empty search results', async () => {
			genaiClient.llmCall.mockResolvedValue({
				text: 'Test summary',
				citations: [],
			});

			const result = await generateGroundedSummary({
				text: 'Test alert',
				searchResults: [],
			});

			expect(result.citations).toHaveLength(0);
			// Lower confidence when no grounding is available
			expect(result.confidence).toBe(0.5);
		});

		it('should handle API errors gracefully', async () => {
			genaiClient.llmCall.mockRejectedValue(new Error('API error'));

			await expect(generateGroundedSummary({
				text: 'Test alert',
				searchResults: [],
			})).rejects.toThrow('Summary generation failed: API error');
		});
	});
});