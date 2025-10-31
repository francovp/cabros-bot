const genaiClient = require('./genaiClient');
const { validateGeminiResponse } = require('../../lib/validation');
const { GEMINI_SYSTEM_PROMPT } = require('./config');
const { EventCategory } = require('../../controllers/webhooks/handlers/newsMonitor/constants');

// News analysis system prompt for Gemini
const NEWS_ANALYSIS_SYSTEM_PROMPT = `You are a financial market sentiment analyst specializing in crypto and stock news analysis.
Analyze the provided news/context and detect market-moving events.
Respond ONLY with valid JSON in this exact format:
{
  "event_category": "price_surge|price_decline|public_figure|regulatory|none",
  "event_significance": 0.0-1.0,
  "sentiment_score": -1.0-1.0,
  "headline": "one-line event description",
  "sources": ["url1", "url2"]
}

Categories:
- price_surge: Bullish events (positive news, price increases, upgrades)
- price_decline: Bearish events (negative news, price declines, downgrades)
- public_figure: Mentions of influential figures (Elon, Trump, etc.)
- regulatory: Official announcements, policy changes, regulations
- none: No significant event detected

Be conservative with scores: 0.7+ only for high-credibility, well-sourced events.`;

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
	analyzeNewsForSymbol,
	parseNewsAnalysisResponse,
};

/**
 * Analyze news/context for a symbol and detect market events
 * 003-news-monitor: User Story 5 (event detection)
 * @param {string} symbol - Financial symbol
 * @param {string} context - News/context text to analyze
 * @returns {Promise<Object>} Analysis result with event_category, sentiment, confidence
 */
async function analyzeNewsForSymbol(symbol, context) {
	const prompt = `Analyze this news/market context for symbol ${symbol}:

${context}

Detect any market-moving events and respond with JSON only. Follow this exact format:
{
  "event_category": "price_surge|price_decline|public_figure|regulatory|none",
  "event_significance": 0.0-1.0,
  "sentiment_score": -1.0-1.0,
  "headline": "one-line event description",
  "sources": ["url1", "url2"]
}`;

	try {
		// Create a proper system instruction that will be passed to genaiClient
		const fullPrompt = `${NEWS_ANALYSIS_SYSTEM_PROMPT}\n\n${prompt}`;
		
		const { text: response } = await genaiClient.llmCall({
			prompt: fullPrompt,
			opts: { model: 'gemini-2.0-flash', temperature: 0.3 },
		});

		// Parse and validate JSON response
		const analysisResult = parseNewsAnalysisResponse(response);

		// Calculate confidence using formula: (0.6 × event_significance + 0.4 × |sentiment|)
		const confidence = 0.6 * analysisResult.event_significance + 0.4 * Math.abs(analysisResult.sentiment_score);
		analysisResult.confidence = Math.max(0, Math.min(1, confidence)); // Clamp to [0, 1]

		console.debug('[Gemini] News analysis complete', {
			symbol,
			category: analysisResult.event_category,
			confidence: analysisResult.confidence
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
			sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 10) : []
		};
	} catch (error) {
		console.error('[Gemini] Response parsing failed:', error.message);
		// Return neutral/none event on parsing failure
		return {
			event_category: EventCategory.NONE,
			event_significance: 0,
			sentiment_score: 0,
			headline: 'Could not detect market event',
			sources: []
		};
	}
}