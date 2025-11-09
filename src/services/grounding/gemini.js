const genaiClient = require('./genaiClient');
const { validateGeminiResponse } = require('../../lib/validation');
const { GEMINI_SYSTEM_PROMPT, GROUNDING_MODEL_NAME, ENABLE_NEWS_MONITOR_TEST_MODE } = require('./config');
const { EventCategory } = require('../../controllers/webhooks/handlers/newsMonitor/constants');

// News analysis system prompt for Gemini
const NEWS_ANALYSIS_SYSTEM_PROMPT = `You are a financial market sentiment analyst specializing in crypto and stock news analysis.
Analyze the provided news/context and detect market-moving events.`;

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

	if (ENABLE_NEWS_MONITOR_TEST_MODE) {
		console.debug('[Gemini][generateGroundedSummary] Test mode enabled, returning fixed summary.');
		// In test mode, return a fixed summary for consistent testing
		return {
			summary: 'This is a test summary for news monitoring.',
			citations: searchResults,
			confidence: 0.9,
		};
	}

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
			opts: { model: GROUNDING_MODEL_NAME, temperature: 0.2 },
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
	analyzeNewsForSymbol,
	parseNewsAnalysisResponse,
};

/**
 * Analyze news/context for a symbol and detect market events using Gemini GoogleSearch
 * 003-news-monitor: User Story 5 (event detection)
 * @param {string} symbol - Financial symbol
 * @param {string} context - News/context text to analyze
 * @returns {Promise<Object>} Analysis result with event_category, sentiment, confidence
 */
async function analyzeNewsForSymbol(symbol, context) {
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
		// Use Gemini GoogleSearch to fetch market news and sentiment
		const searchResult = await genaiClient.search({
			query: `${symbol} news market sentiment events today`,
			maxResults: 3,
		});
		console.debug('[Gemini][analyzeNewsForSymbol] Grounding market news and sentiment search results:', searchResult);

		// Build enriched context from grounding results
		const groundingContext = searchResult.searchResultText || '';
		// Store full SearchResult objects with title, snippet, url, and sourceDomain for formatting
		/** @type {SearchResult[]} */
		const sourcesList = searchResult.results
			.map(r => r.title || null)
			.filter(Boolean)

		const enrichedContext = `${context}\n\nGrounded Context from Search:\n${groundingContext}\n\nSources: ${sourcesList.join(', ')}`;
		console.debug('[Gemini][analyzeNewsForSymbol] Enriched context for analysis:', enrichedContext);

		const prompt = `Analyze this news/market context for symbol ${symbol}:

${enrichedContext}

Detect any market-moving events and respond ONLY with valid JSON in this exact format:
{
  "event_category": "price_surge|price_decline|public_figure|regulatory|none",
  "event_significance": 0.0-1.0,
  "sentiment_score": -1.0-1.0,
  "headline": "one-line event description",
  "description": "detailed event description up to 2000 chars"
}

Categories:
- price_surge: Bullish events (positive news, price increases, upgrades)
- price_decline: Bearish events (negative news, price declines, downgrades)
- public_figure: Mentions of influential figures (Elon, Trump, etc.)
- regulatory: Official announcements, policy changes, regulations
- none: No significant event detected

Be conservative with scores: 0.7+ only for high-credibility, well-sourced events.`;

		// Create a proper system instruction that will be passed to genaiClient
		const fullPrompt = `${NEWS_ANALYSIS_SYSTEM_PROMPT}\n\n${prompt}`;
		
		const { text: response } = await genaiClient.llmCall({
			prompt: fullPrompt,
			opts: { model: GROUNDING_MODEL_NAME, temperature: 0.3 },
		});

		// Parse and validate JSON response
		const analysisResult = parseNewsAnalysisResponse(response);

		// Use grounded sources if available (store full SearchResult objects, not just URLs)
		if (searchResult.results.length > 0) {
			// Store full SearchResult objects with title, snippet, url, and sourceDomain for formatting
			/** @type {SearchResult[]} */
			analysisResult.sources = searchResult.results;
		}

		// Calculate confidence using formula: (0.6 × event_significance + 0.4 × |sentiment|)
		const confidence = 0.6 * analysisResult.event_significance + 0.4 * Math.abs(analysisResult.sentiment_score);
		analysisResult.confidence = Math.max(0, Math.min(1, confidence)); // Clamp to [0, 1]

		console.debug('[Gemini] News analysis complete with grounding', {
			symbol,
			category: analysisResult.event_category,
			confidence: analysisResult.confidence,
			groundedSources: analysisResult.sources.length
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
			description: parsed.description || ''
		};
	} catch (error) {
		console.error('[Gemini] Response parsing failed:', error.message);
		// Return neutral/none event on parsing failure
		return {
			event_category: EventCategory.NONE,
			event_significance: 0,
			sentiment_score: 0,
			headline: 'Could not detect market event',
			description: ''
		};
	}
}