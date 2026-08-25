/* global jest, describe, it, expect, beforeEach, afterEach */

const {
	generateGroundedSummary,
	generateEnrichedAlert,
	parseEnrichedAlertResponse,
} = require('../../src/services/grounding/gemini');

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
			expect(result.prompt_provenance).toEqual({
				name: 'alert-enrichment',
				source: 'local',
				label: null,
				version: null,
				schemaDriftDetected: false,
			});
			expect(result).not.toHaveProperty('technical_levels');
			expect(result.promptProvenance).toEqual({
				name: 'alert-enrichment',
				source: 'local',
				label: null,
				version: null,
				schemaDriftDetected: false,
			});
			// sources are not returned by generateEnrichedAlert
		});

		it('should preserve valid optional risk metadata from the model response', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					...mockEnrichedResponse,
					invalidation_level: '$80,000',
					target_level: 90000,
					setup_type: 'breakout',
					risk_reward_ratio: '2.5:1',
				}),
			});

			const result = await generateEnrichedAlert({
				text: 'Bitcoin breaks 83k after a volatile session',
				searchResults: [],
			});

			expect(result).toEqual(expect.objectContaining({
				invalidation_level: '$80,000',
				target_level: 90000,
				setup_type: 'breakout',
				risk_reward_ratio: '2.5:1',
			}));
		});

		it('should omit invalid optional risk metadata without degrading the enrichment', () => {
			const result = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				invalidation_level: { price: 80000 },
				target_level: '   ',
				setup_type: 'scalp',
				risk_reward_ratio: Number.NaN,
			}));

			expect(result.sentiment).toBe('BULLISH');
			expect(result).not.toHaveProperty('invalidation_level');
			expect(result).not.toHaveProperty('target_level');
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('risk_reward_ratio');
		});

		it('parses valid technical_levels arrays from the model response', () => {
			const result = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: {
					supports: ['79,500', '78k', 77500],
					resistances: ['$82,300', '83,000'],
				},
			}));

			expect(result.technical_levels).toEqual({
				supports: ['79,500', '78k', '77500'],
				resistances: ['$82,300', '83,000'],
			});
		});

		it('omits technical_levels when both level arrays are empty or missing', () => {
			const emptyLevels = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: { supports: [], resistances: [] },
			}));
			expect(emptyLevels).not.toHaveProperty('technical_levels');

			const missingLevels = parseEnrichedAlertResponse(JSON.stringify({ ...mockEnrichedResponse }));
			expect(missingLevels).not.toHaveProperty('technical_levels');
		});

		it('drops malformed technical_levels entries and omits the field when nothing survives validation', () => {
			const result = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: {
					supports: [{ price: 1 }, '   ', null, '80,000', true],
					resistances: [Number.NaN, [], 85000],
				},
			}));

			expect(result.technical_levels).toEqual({
				supports: ['80,000'],
				resistances: ['85000'],
			});

			const allInvalid = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: {
					supports: [{ price: 1 }, '   '],
					resistances: [null],
				},
			}));
			expect(allInvalid).not.toHaveProperty('technical_levels');
		});

		it('caps parsed technical level arrays at six entries per side', () => {
			const result = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: {
					supports: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
					resistances: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'],
				},
			}));

			expect(result.technical_levels.supports).toHaveLength(6);
			expect(result.technical_levels.resistances).toHaveLength(6);
		});

		it('does not let malformed early entries consume the per-side quota', () => {
			const result = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: {
					supports: [{ bad: 1 }, '', null, true, Number.NaN, [], 's-valid-1', 's-valid-2'],
					resistances: ['r-valid'],
				},
			}));

			expect(result.technical_levels.supports).toEqual(['s-valid-1', 's-valid-2']);
			expect(result.technical_levels.resistances).toEqual(['r-valid']);
		});

		it('ignores non-object technical_levels payloads entirely', () => {
			const stringPayload = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: 'supports at 80k',
			}));
			expect(stringPayload).not.toHaveProperty('technical_levels');

			const arrayPayload = parseEnrichedAlertResponse(JSON.stringify({
				...mockEnrichedResponse,
				technical_levels: [80000],
			}));
			expect(arrayPayload).not.toHaveProperty('technical_levels');
		});

		describe('sentiment_score signed range and sign-coherence guard', () => {
			it('preserves negative sentiment_score in [-1, 1] for BEARISH sentiment', () => {
				const result = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BEARISH',
					sentiment_score: -0.75,
					insights: ['Bearish trend continuing'],
				}));

				expect(result.sentiment).toBe('BEARISH');
				expect(result.sentiment_score).toBe(-0.75);
			});

			it('clamps negative values beyond -1.0 to -1.0', () => {
				const result = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BEARISH',
					sentiment_score: -1.8,
					insights: [],
				}));

				expect(result.sentiment).toBe('BEARISH');
				expect(result.sentiment_score).toBe(-1.0);
			});

			it('clamps positive values beyond 1.0 to 1.0', () => {
				const result = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BULLISH',
					sentiment_score: 1.8,
					insights: [],
				}));

				expect(result.sentiment).toBe('BULLISH');
				expect(result.sentiment_score).toBe(1.0);
			});

			it('enforces sign-coherence: converts positive score to negative for BEARISH sentiment', () => {
				const result = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BEARISH',
					sentiment_score: 0.85,
					insights: ['Downtrend detected'],
				}));

				expect(result.sentiment).toBe('BEARISH');
				expect(result.sentiment_score).toBe(-0.85);
			});

			it('enforces sign-coherence: converts negative score to positive for BULLISH sentiment', () => {
				const result = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BULLISH',
					sentiment_score: -0.85,
					insights: ['Uptrend detected'],
				}));

				expect(result.sentiment).toBe('BULLISH');
				expect(result.sentiment_score).toBe(0.85);
			});

			it('forces sentiment_score to 0 for NEUTRAL sentiment regardless of input', () => {
				const resultWithScore = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'NEUTRAL',
					sentiment_score: 0.6,
					insights: ['Consolidation phase'],
				}));
				expect(resultWithScore.sentiment).toBe('NEUTRAL');
				expect(resultWithScore.sentiment_score).toBe(0);

				const resultWithoutScore = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'NEUTRAL',
					insights: [],
				}));
				expect(resultWithoutScore.sentiment).toBe('NEUTRAL');
				expect(resultWithoutScore.sentiment_score).toBe(0);
			});

			it('falls back to directional defaults when score is missing or invalid', () => {
				const bullishNoScore = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BULLISH',
					insights: [],
				}));
				expect(bullishNoScore.sentiment).toBe('BULLISH');
				expect(bullishNoScore.sentiment_score).toBe(0.5);

				const bearishNoScore = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BEARISH',
					insights: [],
				}));
				expect(bearishNoScore.sentiment).toBe('BEARISH');
				expect(bearishNoScore.sentiment_score).toBe(-0.5);

				const bearishZeroScore = parseEnrichedAlertResponse(JSON.stringify({
					sentiment: 'BEARISH',
					sentiment_score: 0,
					insights: [],
				}));
				expect(bearishZeroScore.sentiment).toBe('BEARISH');
				expect(bearishZeroScore.sentiment_score).toBe(-0.5);

				const malformed = parseEnrichedAlertResponse('not valid json');
				expect(malformed.sentiment).toBe('NEUTRAL');
				expect(malformed.sentiment_score).toBe(0);
			});
		});

		it('adds provider usage returned by llmCallv2 to the token tracker', async () => {
			const tokenUsage = { addUsage: jest.fn() };
			const usage = { inputTokens: 11, outputTokens: 22, totalTokens: 33 };
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify(mockEnrichedResponse),
				usage,
				modelUsed: 'gpt-4o-mini',
			});

			await generateEnrichedAlert({
				text: 'Bitcoin breaks 83k after a volatile session',
				searchResults: mockSearchResults,
				options: { tokenUsage },
			});

			expect(tokenUsage.addUsage).toHaveBeenCalledWith(usage, 'gpt-4o-mini');
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
			expect(result.sentiment_score).toBe(0);
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
			expect(result.sentiment_score).toBe(0);
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
