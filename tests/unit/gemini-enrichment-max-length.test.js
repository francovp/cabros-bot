/* global describe, it, expect, jest, beforeEach, afterEach */

const genaiClient = require('../../src/services/grounding/genaiClient');
const { getPromptService, PromptKeys } = require('../../src/services/prompts');
const { generateEnrichedAlert } = require('../../src/services/grounding/gemini');
const config = require('../../src/services/grounding/config');

jest.mock('../../src/services/grounding/genaiClient');

describe('Gemini Enriched Alert - GROUNDING_MAX_LENGTH enforcement', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		jest.clearAllMocks();
		genaiClient.llmCallv2.mockResolvedValue({
			text: JSON.stringify({
				sentiment: 'BULLISH',
				sentiment_score: 0.88,
				insights: ['Positive momentum'],
			}),
			usage: { promptTokens: 100, candidateTokens: 50, totalTokens: 150 },
			modelUsed: 'gemini-2.5-flash',
		});
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('exports GROUNDING_MAX_LENGTH from config with default 2000', () => {
		expect(config.GROUNDING_MAX_LENGTH).toBeDefined();
		expect(typeof config.GROUNDING_MAX_LENGTH).toBe('number');
		expect(config.GROUNDING_MAX_LENGTH).toBe(2000);
	});

	it('bounds the alert text in alertContext to options.maxLength before LLM call', async () => {
		const promptService = getPromptService();
		const getChatPromptSpy = jest.spyOn(promptService, 'getChatPrompt');

		const fullAlertText = 'A'.repeat(500) + ' ' + 'B'.repeat(500); // 1001 chars
		const maxLength = 100;

		const result = await generateEnrichedAlert({
			text: fullAlertText,
			searchResults: [],
			options: { maxLength },
		});

		expect(result.sentiment).toBe('BULLISH');
		expect(getChatPromptSpy).toHaveBeenCalledWith(
			PromptKeys.ALERT_ENRICHMENT,
			expect.objectContaining({
				alertContext: expect.stringMatching(/^A{100}$/),
			}),
			expect.any(Object),
		);

		const passedAlertContext = getChatPromptSpy.mock.calls[0][1].alertContext;
		expect(passedAlertContext.length).toBe(100);
		expect(passedAlertContext).toBe('A'.repeat(100));

		getChatPromptSpy.mockRestore();
	});

	it('preserves full alert text in alertContext when alert text is within maxLength', async () => {
		const promptService = getPromptService();
		const getChatPromptSpy = jest.spyOn(promptService, 'getChatPrompt');

		const alertText = 'BTC breakout above resistance level at 65000';
		const maxLength = 2000;

		await generateEnrichedAlert({
			text: alertText,
			searchResults: [],
			options: { maxLength },
		});

		const passedAlertContext = getChatPromptSpy.mock.calls[0][1].alertContext;
		expect(passedAlertContext).toContain(alertText);

		getChatPromptSpy.mockRestore();
	});

	it('honors process.env.GROUNDING_MAX_LENGTH when options.maxLength is not explicitly passed', async () => {
		process.env.GROUNDING_MAX_LENGTH = '50';

		const promptService = getPromptService();
		const getChatPromptSpy = jest.spyOn(promptService, 'getChatPrompt');

		const longText = 'Alert: Bitcoin surged past 90k with huge volume across all exchanges!';

		await generateEnrichedAlert({
			text: longText,
			searchResults: [],
		});

		const passedAlertContext = getChatPromptSpy.mock.calls[0][1].alertContext;
		expect(passedAlertContext).toBe(longText.slice(0, 50));
		expect(passedAlertContext.length).toBe(50);

		getChatPromptSpy.mockRestore();
	});

	it('appends search context after the bounded alert text', async () => {
		const promptService = getPromptService();
		const getChatPromptSpy = jest.spyOn(promptService, 'getChatPrompt');

		const fullAlertText = 'Alert signal word '.repeat(30);
		const searchResults = [
			{ title: 'Source 1', snippet: 'Snippet 1', url: 'https://example.com' },
		];
		const maxLength = 50;

		await generateEnrichedAlert({
			text: fullAlertText,
			searchResults,
			options: { maxLength },
		});

		expect(getChatPromptSpy).toHaveBeenCalled();
		const passedAlertContext = getChatPromptSpy.mock.calls[0][1].alertContext;
		expect(passedAlertContext.startsWith(fullAlertText.slice(0, 50))).toBe(true);
		expect(passedAlertContext).toContain('Context from verified sources:');
		expect(passedAlertContext).toContain('Source 1');

		getChatPromptSpy.mockRestore();
	});
});
