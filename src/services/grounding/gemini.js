const genaiClient = require('./genaiClient');
const { validateGeminiResponse } = require('../../lib/validation');
const { GEMINI_SYSTEM_PROMPT } = require('./config');

/**
 * Generates a summary with citations given an alert text and optional context
 * @param {string} text - Alert text to summarize
 * @param {Array<SearchResult>} searchResults - Optional search results to use as grounding context
 * @param {object} options - Additional options like maxLength, language preservation
 * @returns {Promise<GeminiResponse>} Generated summary with citations
 */
async function generateGroundedSummary({ text, searchResults = [], searchResultText = '', options = {} }) {
	const {
		maxLength = 250,
		preserveLanguage = true,
		systemPrompt = GEMINI_SYSTEM_PROMPT,
	} = options;

	// Prepare prompt with language preservation if needed
	const detectedLanguage = await detectLanguage(text);
	const langDirective = preserveLanguage && detectedLanguage !== 'en'
		? `Respond in ${detectedLanguage} language. `
		: '';

	const contextPrompt = searchResults.length > 0
		? `\n\nContext from verified sources:\n${searchResults
			.map(result => `- ${result.title}\n  ${result.snippet}`)
			.join('\n')}`
		: '';

	const contextSnippet = searchResultText
		? `\n\nAdditional context for the sources:\n${searchResultText}`
		: '';

	const prompt = `${systemPrompt}\n\n${langDirective}
Please analyze this alert and provide a concise summary (max ${maxLength} chars) with citations based in the context:

Alert: ${text}${contextPrompt}${contextSnippet}`;

	try {
		const { text: summary } = await genaiClient.llmCall({
			prompt,
			context: { citations: searchResults },
			opts: { model: 'gemini-2.0-flash', temperature: 0.2 },
		});

		const response = {
			summary: summary.slice(0, maxLength),
			citations: searchResults,
			confidence: searchResults.length > 0 ? 0.85 : 0.5,
		};

		return validateGeminiResponse(response);
	} catch (error) {
		throw new Error(`Summary generation failed: ${error.message}`);
	}
}

/**
 * Basic language detection - can be enhanced with a proper language detection library
 * @param {string} text Text to detect language for
 * @returns {Promise<string>} ISO language code
 */
async function detectLanguage(text) {
	// TODO: Implement proper language detection
	// For now, just check if text has non-ASCII characters
	return /[^a-zA-Z0-9\s.,!?]/.test(text) ? 'unknown' : 'es';
}

module.exports = {
	generateGroundedSummary,
};