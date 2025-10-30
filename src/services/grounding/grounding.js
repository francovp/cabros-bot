const { 
	GROUNDING_MAX_SOURCES,
	GROUNDING_TIMEOUT_MS,
	SEARCH_QUERY_PROMPT,
	GROUNDING_MAX_LENGTH,
	GROUNDING_MODEL_NAME,
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
		console.error('Query derivation failed:', error);
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
	} = options;

	const startTime = Date.now();

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
		console.debug('Using truncated text:', truncatedText);

		// 1. Search for evidence
		const { results: searchResults, totalResults, searchResultText } = await genaiClient.search({
			query,
			model: GROUNDING_MODEL_NAME,
			maxResults: maxSources,
		});
		console.debug('Search results:', searchResults);
		console.debug(`Retrieved ${searchResults.length} grounding search results`);
		console.debug(`Total available results: ${totalResults}`);
		console.debug(`Search result text: ${searchResultText}`);

		// 2. Generate grounded summary with timeout
		const [timeoutPromise, cleanupTimeout] = createTimeout();
		const result = await Promise.race([
			gemini.generateGroundedSummary({
				text: truncatedText,
				searchResults,
				searchResultText,
				options: { preserveLanguage, maxLength },
			}),
			timeoutPromise,
		]).finally(cleanupTimeout);

		const response = {
			...result,
			truncated: text.length > 4000,
		};

		metrics.recordSuccess(Date.now() - startTime);
		return response;
	} catch (error) {
		if (error.message === 'Grounding timeout') {
			metrics.recordFailure('timeout', error);
			throw new Error('Grounding timeout');
		}
		metrics.recordFailure('error', error);
		throw new Error(`Grounding failed: ${error.message}`);
	}
}

module.exports = {
	groundAlert,
	deriveSearchQuery,
};