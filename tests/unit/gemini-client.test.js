/* global jest, describe, it, expect, beforeEach, afterEach */

const { generateGroundedSummary, generateEnrichedAlert } = require('../../src/services/grounding/gemini');

// Use jest.requireActual to preserve NonRetryableProviderError class,
// but mock the key methods (llmCallv2, search) so tests control responses.
const actualGenaiClient = jest.requireActual('../../src/services/grounding/genaiClient');
jest.mock('../../src/services/grounding/genaiClient', () => {
	const actual = jest.requireActual('../../src/services/grounding/genaiClient');
	return {
		NonRetryableProviderError: actual.NonRetryableProviderError,
		GenaiClient: actual.GenaiClient,
		llmCallv2: jest.fn(),
		search: jest.fn(),
	};
});
const genaiClient = require('../../src/services/grounding/genaiClient');
jest.mock('../../src/services/inference/azureAiClient', () => ({
	getAzureAIClient: jest.fn().mockReturnValue({
		chatCompletion: jest.fn(),
		validate: jest.fn().mockReturnValue(true),
	}),
}));

jest.mock('../../src/services/grounding/config', () => ({
	GEMINI_SYSTEM_PROMPT: 'Test system prompt',
	GROUNDING_MODEL_NAME: 'gemini-2.0-flash',
	GEMINI_MODEL_NAME: 'gemini-2.0-flash',
	GEMINI_MODEL_NAME_FALLBACK: 'gemini-2.5-flash-lite',
}));

describe('Gemini Service', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.resetAllMocks();
		process.env = { ...originalEnv, GEMINI_MODEL_NAME: 'gemini-2.0-flash' };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('generateEnrichedAlert', () => {
		const mockSearchResults = [{
			title: 'Test Source',
			snippet: 'Test snippet',
			url: 'https://test.com',
			sourceDomain: 'test.com',
		}];

		const mockEnrichedResponse = {
			sentiment: 'BULLISH',
			sentiment_score: 0.9,
			insights: ['Insight 1', 'Insight 2'],
		};

		it('should generate enriched alert with valid structure', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify(mockEnrichedResponse),
				citations: mockSearchResults,
			});

			const result = await generateEnrichedAlert({
				text: 'Bitcoin breaks 83k',
				searchResults: mockSearchResults,
			});

			expect(result.sentiment).toBe('BULLISH');
			expect(result.sentiment_score).toBe(0.9);
			expect(result.insights).toHaveLength(2);
			expect(result).not.toHaveProperty('technical_levels');
			// sources are not returned by generateEnrichedAlert
		});

		it('retries with the fallback Gemini model on transient 500 INTERNAL errors', async () => {
			genaiClient.llmCallv2
				.mockRejectedValueOnce(Object.assign(
					new Error('LLM call failed: ApiError: {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}'),
					{ status: 500 },
				))
				.mockResolvedValueOnce({
					text: JSON.stringify(mockEnrichedResponse),
					citations: mockSearchResults,
					modelUsed: 'gemini-2.5-flash-lite',
				});

			const result = await generateEnrichedAlert({
				text: 'Bitcoin breaks 83k after a volatile session',
				searchResults: mockSearchResults,
			});

			expect(result.sentiment).toBe('BULLISH');
			expect(result.modelUsed).toBe('gemini-2.5-flash-lite');
			expect(genaiClient.llmCallv2).toHaveBeenCalledTimes(2);
			expect(genaiClient.llmCallv2).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					opts: expect.objectContaining({
						temperature: 0.2,
					}),
				}),
			);
			expect(genaiClient.llmCallv2).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					opts: expect.objectContaining({
						model: 'gemini-2.5-flash-lite',
						temperature: 0.2,
					}),
				}),
			);
		});

		it('should handle non-English text with preserved language', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					...mockEnrichedResponse,
					insights: ['Insight en español'],
				}),
				citations: [],
			});

			await generateEnrichedAlert({
				text: 'Bitcoin rompe 83k ahora mismo', // Longer text to bypass short alert check
				searchResults: [],
				options: { preserveLanguage: true },
			});

			expect(genaiClient.llmCallv2).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining('Respond in the same language as the Alert text.'),
				}),
			);
		});

		it('should handle short alerts with default neutral sentiment', async () => {
			// Short alert < 15 chars
			const result = await generateEnrichedAlert({
				text: 'Hi',
				searchResults: [],
			});

			expect(result.sentiment).toBe('NEUTRAL');
			expect(result.sentiment_score).toBe(0.5);
			expect(result.insights).toHaveLength(0);
			expect(genaiClient.llmCallv2).not.toHaveBeenCalled();
		});

		it('should parse valid JSON response correctly', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: '```json\n' + JSON.stringify(mockEnrichedResponse) + '\n```',
				citations: [],
			});

			const result = await generateEnrichedAlert({
				text: 'Valid alert text that is long enough',
				searchResults: [],
			});

			expect(result.sentiment).toBe('BULLISH');
		});

		it('should return defaults on malformed JSON', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: 'Invalid JSON',
				citations: [],
			});

			const result = await generateEnrichedAlert({
				text: 'Valid alert text that is long enough',
				searchResults: [],
			});

			expect(result.sentiment).toBe('NEUTRAL');
			expect(result.insights).toHaveLength(0);
		});

		it('returns neutral enrichment on NonRetryableProviderError instead of throwing', async () => {
			const { NonRetryableProviderError } = require('../../src/services/grounding/genaiClient');
			genaiClient.llmCallv2.mockRejectedValue(
				new NonRetryableProviderError(
					'LLM provider configuration error: User location is not supported for the API use.',
					{ status: 400, provider: 'gemini' },
				),
			);

			const result = await generateEnrichedAlert({
				text: 'Valid alert text that is long enough for enrichment',
				searchResults: [],
			});

			expect(result.sentiment).toBe('NEUTRAL');
			expect(result.sentiment_score).toBe(0.5);
			expect(result.insights).toEqual([]);
			// Fallback model should NOT be called
			expect(genaiClient.llmCallv2).toHaveBeenCalledTimes(1);
		});

		it('should use provided system prompt', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify(mockEnrichedResponse),
				citations: [],
			});

			const customPrompt = 'Custom system prompt';
			await generateEnrichedAlert({
				text: 'Valid alert text',
				searchResults: [],
				options: { systemPrompt: customPrompt },
			});

			expect(genaiClient.llmCallv2).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining(customPrompt),
				}),
			);
		});
	});

	describe('generateGroundedSummary', () => {
		const mockSearchResults = [{
			title: 'Test Source',
			snippet: 'Test snippet',
			url: 'https://test.com',
			sourceDomain: 'test.com',
		}];

		it('should generate summary with citations', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
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

			expect(genaiClient.llmCallv2).toHaveBeenCalledWith(expect.objectContaining({
				userPrompt: expect.stringContaining('Test alert'),
				context: { citations: mockSearchResults },
				opts: expect.objectContaining({
					temperature: 0.2,
				}),
			}));
		});

		it('should respect maxLength option', async () => {
			const longText = 'x'.repeat(300);
			genaiClient.llmCallv2.mockResolvedValue({
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
			genaiClient.llmCallv2.mockResolvedValue({
				text: 'Test summary',
				citations: [],
			});

			await generateGroundedSummary({
				text: nonEnglishText,
				searchResults: [],
				options: { preserveLanguage: true },
			});

			expect(genaiClient.llmCallv2).toHaveBeenCalledWith(
				expect.objectContaining({
					systemPrompt: expect.stringContaining('Respond in the same language as the Alert text.'),
				}),
			);
		});

		it('should handle empty search results', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
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
			genaiClient.llmCallv2.mockRejectedValue(new Error('API error'));

			await expect(generateGroundedSummary({
				text: 'Test alert',
				searchResults: [],
			})).rejects.toThrow('Summary generation failed: API error');
		});
	});
});
