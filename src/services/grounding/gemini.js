const genaiClient = require('./genaiClient');
const { NonRetryableProviderError } = genaiClient;
const { validateGeminiResponse } = require('../../lib/validation');
const { GROUNDING_MODEL_NAME, GEMINI_MODEL_NAME, GEMINI_MODEL_NAME_FALLBACK, ENABLE_NEWS_MONITOR_TEST_MODE } = require('./config');
const { EventCategory } = require('../../controllers/webhooks/handlers/newsMonitor/constants');
const { getPromptService, PromptKeys } = require('../prompts');

const promptService = getPromptService();

function getLanguageDirective(preserveLanguage) {
	return preserveLanguage
		? 'Respond in the same language as the Alert text.'
		: '';
}

function buildContextPrompt(searchResults = []) {
	return searchResults.length > 0
		? `\n\nContext from verified sources:\n${searchResults
			.map(result => `- ${result.title}\n  ${result.snippet}`)
			.join('\n')}`
		: '';
}

function buildContextSnippet(searchResultText = '') {
	return searchResultText
		? `\n\nAdditional context for the sources:\n${searchResultText}`
		: '';
}

function shouldRetryGeminiWithFallback(error) {
	if (!error) {
		return false;
	}

	const status = Number(error.status);
	if ([500, 503, 504].includes(status)) {
		return true;
	}

	const errorMessage = String(error.message || '').toUpperCase();
	return (
		errorMessage.includes('500')
		|| errorMessage.includes('503')
		|| errorMessage.includes('504')
		|| errorMessage.includes('INTERNAL')
		|| errorMessage.includes('UNAVAILABLE')
		|| errorMessage.includes('DEADLINE_EXCEEDED')
		|| errorMessage.includes('OVERLOADED')
	);
}

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
		systemPrompt: systemPromptOverride,
		tokenUsage,
	} = options;

	if (ENABLE_NEWS_MONITOR_TEST_MODE) {
		console.debug('[Gemini][generateGroundedSummary] Test mode enabled, returning fixed summary.');
		// In test mode, return a fixed summary for consistent testing
		return {
			summary: 'This is a test summary for news monitoring.',
			citations: searchResults,
			confidence: 0.9,
		};
	}

	const languageDirective = getLanguageDirective(preserveLanguage);
	const contextPrompt = buildContextPrompt(searchResults);
	const contextSnippet = buildContextSnippet(searchResultText);
	const { systemPrompt, userPrompt } = await promptService.getChatPrompt(
		PromptKeys.GROUNDED_SUMMARY,
		{
			alertText: text,
			maxLength,
			languageDirective,
			contextPrompt,
			contextSnippet,
		},
		{ systemPromptOverride },
	);

	try {
		const { text: summary, usage } = await genaiClient.llmCallv2({
			systemPrompt,
			userPrompt,
			context: { citations: searchResults },
			opts: { temperature: 0.2 },
		});

		if (tokenUsage && usage) {
			tokenUsage.addUsage(usage, GEMINI_MODEL_NAME);
		}

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
 * Analyze news/context for a symbol and detect market events using Gemini GoogleSearch
 * 003-news-monitor: User Story 5 (event detection)
 * @param {string} symbol - Financial symbol
 * @param {string} context - News/context text to analyze
 * @returns {Promise<Object>} Analysis result with event_category, sentiment, confidence
 */
async function analyzeNewsForSymbol(symbol, context, options = {}) {
	const tokenUsage = options.tokenUsage;
	if (ENABLE_NEWS_MONITOR_TEST_MODE) {
		console.debug('[Gemini][analyzeNewsForSymbol] Test mode enabled, returning fixed analysis.');
		// In test mode, return a fixed analysis for consistent testing
		return {
			event_category: EventCategory.PRICE_SURGE,
			event_significance: 0.8,
			sentiment_score: 0.7,
			headline: 'Test Event: Positive Market Movement',
			description: 'This is a test event analysis for news monitoring.',
			confidence: 0.9,
			sources: [
				{ title: 'Test Source 1', snippet: 'This is a test snippet.', url: 'https://example.com/test1', sourceDomain: 'example.com' },
				{ title: 'Test Source 2', snippet: 'This is another test snippet.', url: 'https://example.com/test2', sourceDomain: 'example.com' },
			],
		};
	}

	try {
		const { text: searchQuery } = await promptService.getTextPrompt(
			PromptKeys.NEWS_ANALYSIS_SEARCH_QUERY,
			{ symbol },
		);

		// Use Gemini GoogleSearch to fetch market news and sentiment
		// Note: We still rely on genaiClient for search. If Gemini is not configured, this might fail or return empty
		// depending on how genaiClient handles missing config, but here we focus on switching the LLM call.
		const searchResult = await genaiClient.search({
			query: searchQuery,
			maxResults: 3,
			rethrowQuotaErrors: true,
		});
		if (tokenUsage && searchResult.usage) {
			tokenUsage.addUsage(searchResult.usage, GROUNDING_MODEL_NAME);
		}
		console.debug('[Gemini][analyzeNewsForSymbol] Grounding market news and sentiment search results:', searchResult);

		// Build enriched context from grounding results
		const groundingContext = searchResult.searchResultText || '';
		// Store full SearchResult objects with title, snippet, url, and sourceDomain for formatting
		/** @type {SearchResult[]} */
		const sourcesList = searchResult.results
			.map(r => r.title || null)
			.filter(Boolean);

		const enrichedContext = `${context}\n\nGrounded Context from Search:\n${groundingContext}\n\nSources: ${sourcesList.join(', ')}`;
		console.debug('[Gemini][analyzeNewsForSymbol] Enriched context for analysis:', enrichedContext);

		const prompt = await promptService.getChatPrompt(
			PromptKeys.NEWS_ANALYSIS,
			{ symbol, enrichedContext },
		);

		let response;
		try {
			const result = await genaiClient.llmCallv2({
				systemPrompt: prompt.systemPrompt,
				userPrompt: prompt.userPrompt,
				opts: { model: GEMINI_MODEL_NAME, temperature: 0.3 },
			});
			if (tokenUsage && result.usage) {
				tokenUsage.addUsage(result.usage, GEMINI_MODEL_NAME);
			}
			response = result.text;
		} catch (primaryError) {
			// Check if error is due to model overload (503 UNAVAILABLE)
			// Note: This logic is specific to Gemini errors, but keeping it for safety if we are in Gemini path.
			// Azure client might throw different errors.
			const errorMessage = primaryError.message || '';
			if (process.env.GEMINI_MODEL_NAME && (errorMessage.includes('503') || errorMessage.includes('UNAVAILABLE') || errorMessage.includes('overloaded'))) {
				console.warn('[Gemini] Primary model overloaded, attempting fallback model:', GEMINI_MODEL_NAME_FALLBACK);
				try {
					const fallbackResult = await genaiClient.llmCallv2({
						systemPrompt: prompt.systemPrompt,
						userPrompt: prompt.userPrompt,
						opts: { model: GEMINI_MODEL_NAME_FALLBACK, temperature: 0.3 },
					});
					if (tokenUsage && fallbackResult.usage) {
						tokenUsage.addUsage(fallbackResult.usage, GEMINI_MODEL_NAME_FALLBACK);
					}
					response = fallbackResult.text;
				} catch (fallbackError) {
					console.error('[Gemini] Fallback model also failed:', fallbackError.message);
					throw fallbackError;
				}
			} else {
				throw primaryError;
			}
		}

		// Parse and validate JSON response
		const analysisResult = parseNewsAnalysisResponse(response);

		// Use grounded sources if available (store full SearchResult objects, not just URLs)
		analysisResult.sources = searchResult.results || [];

		// Calculate confidence using formula: (0.6 × event_significance + 0.4 × |sentiment|)
		const confidence = 0.6 * analysisResult.event_significance + 0.4 * Math.abs(analysisResult.sentiment_score);
		analysisResult.confidence = Math.max(0, Math.min(1, confidence)); // Clamp to [0, 1]

		console.info('[Gemini] News analysis complete with grounding', {
			symbol,
			category: analysisResult.event_category,
			confidence: analysisResult.confidence,
			groundedSources: analysisResult.sources.length,
		});

		return analysisResult;
	} catch (error) {
		console.error('[Gemini] News analysis failed:', error.message);
		throw error;
	}
}

/**
 * Parse and validate Gemini news analysis response
 * @param {string} response - Raw Gemini response
 * @returns {Object} Validated analysis result
 */
function parseNewsAnalysisResponse(response) {
	try {
		// Extract JSON from response
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error('No JSON found in response');
		}

		const parsed = JSON.parse(jsonMatch[0]);

		// Validate required fields
		if (!parsed.event_category || !Object.values(EventCategory).includes(parsed.event_category)) {
			throw new Error(`Invalid event_category: ${parsed.event_category}`);
		}

		// Clamp numeric values
		return {
			event_category: parsed.event_category,
			event_significance: Math.max(0, Math.min(1, parsed.event_significance || 0)),
			sentiment_score: Math.max(-1, Math.min(1, parsed.sentiment_score || 0)),
			headline: (parsed.headline || 'Market event detected').substring(0, 250),
			description: parsed.description || '',
		};
	} catch (error) {
		console.error('[Gemini] Response parsing failed:', error.message);
		// Return neutral/none event on parsing failure
		return {
			event_category: EventCategory.NONE,
			event_significance: 0,
			sentiment_score: 0,
			headline: 'Could not detect market event',
			description: '',
		};
	}
}

/**
 * Generates a structured enriched alert with sentiment and key insights
 * @param {object} params
 * @param {string} params.text - Alert text
 * @param {Array<import('./types').SearchResult>} params.searchResults - Grounding context
 * @param {string} params.searchResultText - Additional context text
 * @param {object} params.options - Options (maxLength, preserveLanguage)
 * @returns {Promise<Omit<import('./types').EnrichedAlert, 'original_text' | 'sources'>>} Enriched alert data
 */
async function generateEnrichedAlert({ text, searchResults = [], searchResultText = '', options = {} }) {
	const {
		preserveLanguage = true,
		systemPrompt: systemPromptOverride,
		tokenUsage,
	} = options;

	// Short alert check (< 15 chars or < 2 words)
	if (text.length < 15 || text.split(/\s+/).length < 2) {
		return {
			sentiment: 'NEUTRAL',
			sentiment_score: 0.5,
			insights: [],
		};
	}

	const languageDirective = getLanguageDirective(preserveLanguage);
	const contextPrompt = buildContextPrompt(searchResults);
	const contextSnippet = buildContextSnippet(searchResultText);
	const alertContext = `${text}${contextPrompt}${contextSnippet}`;
	console.debug('[Gemini] Generating enriched alert with context:', alertContext);
	const { systemPrompt, userPrompt } = await promptService.getChatPrompt(
		PromptKeys.ALERT_ENRICHMENT,
		{
			alertContext,
			languageDirective,
		},
		{ systemPromptOverride },
	);

	try {
		const llmParams = {
			systemPrompt,
			userPrompt,
			context: { citations: searchResults },
			opts: { temperature: 0.2 },
		};
		let llmResult;

		try {
			llmResult = await genaiClient.llmCallv2(llmParams);
	} catch (error) {
		if (error instanceof NonRetryableProviderError) {
			console.warn('[Gemini] Non-retryable provider error, returning neutral enrichment:', error.message);
			return {
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: [],
				modelUsed: GEMINI_MODEL_NAME || 'unknown',
			};
		}

		if (!GEMINI_MODEL_NAME_FALLBACK || !shouldRetryGeminiWithFallback(error)) {
			throw error;
		}

		console.warn('[Gemini] Primary enrichment model failed, attempting fallback model:', GEMINI_MODEL_NAME_FALLBACK);
		llmResult = await genaiClient.llmCallv2({
			...llmParams,
			opts: {
				...llmParams.opts,
				model: GEMINI_MODEL_NAME_FALLBACK,
			},
		});
		}

		const { text: responseText, usage, modelUsed } = llmResult;

		if (tokenUsage && usage) {
			const modelName = modelUsed || GEMINI_MODEL_NAME;
			tokenUsage.addUsage(usage, modelName);
		}

		return {
			...parseEnrichedAlertResponse(responseText),
			modelUsed: modelUsed || GEMINI_MODEL_NAME,
		};
	} catch (error) {
		throw new Error(`Enriched alert generation failed: ${error.message}`);
	}
}

/**
 * Parse and validate Gemini enriched alert response
 * @param {string} response - Raw Gemini response
 * @returns {object} Validated enriched alert data
 */
function parseEnrichedAlertResponse(response) {
	try {
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error('No JSON found in response');
		}

		const parsed = JSON.parse(jsonMatch[0]);

		// Validate required fields
		if (!['BULLISH', 'BEARISH', 'NEUTRAL'].includes(parsed.sentiment)) {
			parsed.sentiment = 'NEUTRAL';
		}

		return {
			sentiment: parsed.sentiment,
			sentiment_score: Math.max(0, Math.min(1, parsed.sentiment_score || 0.5)),
			insights: Array.isArray(parsed.insights) ? parsed.insights : [],
		};
	} catch (error) {
		console.warn(`[Gemini] Response parsing failed, using safe defaults: ${error.message}`);
		return {
			sentiment: 'NEUTRAL',
			sentiment_score: 0.5,
			insights: [],
		};
	}
}

module.exports = {
	generateGroundedSummary,
	generateEnrichedAlert,
	parseEnrichedAlertResponse,
	analyzeNewsForSymbol,
	parseNewsAnalysisResponse,
};
