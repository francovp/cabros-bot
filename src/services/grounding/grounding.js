const { 
	GROUNDING_MAX_SOURCES,
	GROUNDING_TIMEOUT_MS,
	SEARCH_QUERY_PROMPT,
	GROUNDING_MAX_LENGTH,
	GROUNDING_MODEL_NAME,
	ALERT_ENRICHMENT_SYSTEM_PROMPT,
	NEWS_ANALYSIS_SYSTEM_PROMPT,
	GEMINI_SYSTEM_PROMPT,
} = require('./config');
const gemini = require('./gemini');
const genaiClient = require('./genaiClient');

/**
 * Derives a search query from alert text using an LLM
 * @param {string} alertText - Raw alert text
 * @param {object} options - Optional parameters
 * @returns {Promise<string>} Optimized search query
 */
async function deriveSearchQuery(alertText, opts = {}) {

	try {
		const prompt = `${SEARCH_QUERY_PROMPT}\n\nAlert: ${alertText}`;
		console.debug('Deriving search query with prompt: ', prompt);
		const response = await genaiClient.llmCall({
			prompt: prompt,
			opts: { model: 'gemini-2.0-flash', temperature: opts.temperature },
		});

		if (!response || !response.text) {
			throw new Error('Invalid response from LLM');
		}

		return response.text;
	} catch (error) {
		console.warn('[Grounding] Query derivation failed:', error.message);
		// Fall back to truncated alert text
		return alertText;
	}
}

/**
 * Main grounding flow: derive query, collect evidence, generate summary
 * @param {string} text - Alert text to ground
 * @param {object} options - Optional parameters
 * @returns {Promise<GeminiResponse>} Summary with citations
 */
const metrics = require('./metrics');

async function groundAlert({ text, options = {} }) {
	const {
		maxSources = GROUNDING_MAX_SOURCES,
		timeoutMs = GROUNDING_TIMEOUT_MS,
		preserveLanguage = true,
		maxLength = GROUNDING_MAX_LENGTH,
		promptType = 'ALERT_ENRICHMENT', // Default to ALERT_ENRICHMENT for backward compatibility/current usage
	} = options;

	const startTime = Date.now();

	// Select system prompt based on promptType
	let systemPrompt = GEMINI_SYSTEM_PROMPT;
	if (promptType === 'ALERT_ENRICHMENT') {
		systemPrompt = ALERT_ENRICHMENT_SYSTEM_PROMPT;
	} else if (promptType === 'NEWS_ANALYSIS') {
		systemPrompt = NEWS_ANALYSIS_SYSTEM_PROMPT;
	}

	/**
	 * Create a timeout promise that rejects after a specified time
	 * @returns {[Promise, Function]} Promise and cleanup function
	 */
	function createTimeout() {
		let timeoutId;
		const promise = new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error('Grounding timeout'));
			}, timeoutMs);
		});
		const cleanup = () => clearTimeout(timeoutId);
		return [promise, cleanup];
	}

	try {
		// Start both tasks in parallel
		const [query, truncatedText] = await Promise.all([
			deriveSearchQuery(text, { temperature: 0.2 }),
			// Handle very long alerts by truncating
			text.length > 4000 ? text.slice(0, 4000) + '...' : text,
		]);

		console.debug('Derived search query:', query);

		// 1. Search for evidence
		const { results: searchResults, totalResults, searchResultText } = await genaiClient.search({
			query,
			model: GROUNDING_MODEL_NAME,
			maxResults: maxSources,
		});
		console.debug(`[Grounding] Retrieved ${searchResults.length}/${totalResults} search results`);

		// 2. Generate enriched alert with timeout
		const [timeoutPromise, cleanupTimeout] = createTimeout();
		const result = await Promise.race([
			gemini.generateEnrichedAlert({
				text: truncatedText,
				searchResults,
				searchResultText,
				options: { preserveLanguage, maxLength, systemPrompt },
			}),
			timeoutPromise,
		]).finally(cleanupTimeout);

		const response = {
			...result,
			sources: searchResults,
			truncated: text.length > 4000,
		};

		metrics.recordSuccess(Date.now() - startTime, promptType);
		return response;
	} catch (error) {
		if (error.message === 'Grounding timeout') {
			metrics.recordFailure('timeout', error, promptType);
			throw new Error('Grounding timeout');
		}
		metrics.recordFailure('error', error, promptType);
		throw new Error(`Grounding failed: ${error.message}`);
	}
}

module.exports = {
	groundAlert,
	deriveSearchQuery,
};