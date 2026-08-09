const {
	GROUNDING_MAX_SOURCES,
	GROUNDING_TIMEOUT_MS,
	GROUNDING_MAX_LENGTH,
	GROUNDING_MODEL_NAME,
	NEWS_ANALYSIS_SYSTEM_PROMPT,
	GEMINI_MODEL_NAME,
} = require('./config');
const gemini = require('./gemini');
const genaiClient = require('./genaiClient');
const { getPromptService, PromptKeys } = require('../prompts');
const metrics = require('./metrics');
const sentryService = require('../monitoring/SentryService');
const { deriveAssetContext, deriveCleanSearchQuery } = require('../tradingview/parseTradingViewSignal');

const promptService = getPromptService();

/**
 * Derives a search query from alert text using an LLM
 * @param {string} alertText - Raw alert text
 * @param {object} options - Optional parameters
 * @returns {Promise<string>} Optimized search query
 */
async function deriveSearchQuery(alertText, opts = {}) {
	try {
		const { systemPrompt, userPrompt } = await promptService.getChatPrompt(
			PromptKeys.SEARCH_QUERY_DERIVATION,
			{ alertText },
		);
		console.debug('Deriving search query with prompt: ', userPrompt);
		const response = await genaiClient.llmCallv2({
			systemPrompt,
			userPrompt,
			opts: { temperature: opts.temperature, signal: opts.signal },
		});

		if (opts.tokenUsage && response.usage) {
			opts.tokenUsage.addUsage(response.usage, GEMINI_MODEL_NAME);
		}

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
async function groundAlert({ text, options = {} }) {
	const {
		maxSources = GROUNDING_MAX_SOURCES,
		timeoutMs = GROUNDING_TIMEOUT_MS,
		preserveLanguage = true,
		maxLength = GROUNDING_MAX_LENGTH,
		promptType = 'ALERT_ENRICHMENT',
		tokenUsage,
	} = options;

	const startTime = Date.now();
	const systemPromptOverride = promptType === 'NEWS_ANALYSIS'
		? NEWS_ANALYSIS_SYSTEM_PROMPT
		: undefined;

	let currentPhase = 'search';
	const controller = new AbortController();
	const signal = controller.signal;

	let timeoutId;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort(new Error('Grounding timeout'));
			reject(new Error('Grounding timeout'));
		}, timeoutMs);
	});

	try {
		const assetContext = deriveAssetContext(text);
		const searchQuery = deriveCleanSearchQuery(text) || text;

		// 1. Search for evidence using clean query with bounded timeout & signal
		const searchPromise = genaiClient.search({
			query: searchQuery,
			model: GROUNDING_MODEL_NAME,
			maxResults: maxSources,
			signal,
			timeoutMs,
		});

		const { results: searchResults, totalResults, searchResultText, usage: searchUsage } = await Promise.race([
			searchPromise,
			timeoutPromise,
		]);

		if (tokenUsage && searchUsage) {
			tokenUsage.addUsage(searchUsage, GROUNDING_MODEL_NAME);
		}
		console.debug(`[Grounding] Retrieved ${searchResults.length}/${totalResults} search results for query: ${searchQuery}`);

		// 2. Generate enriched alert with remaining timeout budget
		currentPhase = 'generation';
		const remainingMs = Math.max(0, timeoutMs - (Date.now() - startTime));

		const generationPromise = gemini.generateEnrichedAlert({
			text: text,
			searchResults,
			searchResultText,
			options: {
				preserveLanguage,
				maxLength,
				systemPrompt: systemPromptOverride,
				tokenUsage,
				assetContext,
				signal,
				timeoutMs: remainingMs,
			},
		});

		const result = await Promise.race([
			generationPromise,
			timeoutPromise,
		]);

		clearTimeout(timeoutId);

		const response = {
			...result,
			sources: searchResults,
			truncated: text.length > 4000,
			...(assetContext ? {
				symbol: assetContext.symbol,
				exchange: assetContext.exchange,
				assetClass: assetContext.assetClass,
			} : {}),
		};

		metrics.recordSuccess(Date.now() - startTime, promptType);
		return response;
	} catch (error) {
		clearTimeout(timeoutId);
		const isTimeout = error.message === 'Grounding timeout' ||
			error.name === 'AbortError' ||
			signal.aborted ||
			(typeof error.message === 'string' && error.message.includes('timeout'));

		if (isTimeout) {
			const phaseError = new Error(`Grounding ${currentPhase} timeout`);
			metrics.recordFailure('timeout', phaseError, promptType);
			sentryService.captureRuntimeError({
				channel: 'grounding',
				error: phaseError,
				feature: 'gemini-grounding',
				extra: { phase: currentPhase, promptType, timeoutMs },
			});
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