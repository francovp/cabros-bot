const genaiClient = require('./genaiClient');
const { validateGeminiResponse } = require('../../lib/validation');
const { GEMINI_SYSTEM_PROMPT, GROUNDING_MODEL_NAME, GEMINI_MODEL_NAME, GEMINI_MODEL_NAME_FALLBACK, ENABLE_NEWS_MONITOR_TEST_MODE, NEWS_ANALYSIS_SYSTEM_PROMPT } = require('./config');
const { EventCategory } = require('../../controllers/webhooks/handlers/newsMonitor/constants');

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
	const langDirective = preserveLanguage
		? 'Respond in the same language as the Alert text.'
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



module.exports = {
	generateGroundedSummary,
	generateEnrichedAlert,
	parseEnrichedAlertResponse,
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

Instructions (important):

- **Task:** Read the provided news/context and detect any market-moving event related to the symbol.
- **Output:** Respond *only* with a single, valid JSON object (no surrounding text, no markdown, no commentary).
- **JSON schema:** Follow the example exactly. Use real values (numbers/strings) — do NOT include type annotations or ranges inside the JSON.

Example JSON (respond with a similar structure using real values):
{
  "event_category": "price_surge",
  "event_significance": 0.75,
  "sentiment_score": 0.45,
  "headline": "One-line event description",
  "description": "Detailed explanation of the event with bulletpoints and bold text."
}

Field guidance:

- **event_category** (string): one of **price_surge**, **price_decline**, **public_figure**, **regulatory**, **none**.
- **event_significance** (number): 0.0 to 1.0 — how important the detected event is (use 0.0 for none, 1.0 for very significant).
- **sentiment_score** (number): -1.0 to 1.0 — negative = bearish, positive = bullish.
- **headline** (string): one concise line describing the event (max ~250 chars).
- **description** (string): Detailed explanation with enrich text using hypen bulletpoints (not asterisks), nextline and bold text for readability (up to ~2000 chars).

Event category hints:

- **price_surge:** Bullish events (positive news, material price increases, upgrades, major buying pressure).
- **price_decline:** Bearish events (negative news, material price drops, downgrades, selling pressure).
- **public_figure:** Mentions/quotes from high-impact individuals that can move markets (e.g., Elon Musk).
- **regulatory:** Official announcements, policy changes, fines, or legal actions.
- **none:** No significant event detected.

Conservatism and formatting rules:

- Be conservative when assigning high scores — prefer 0.6+ only for well-sourced, high-credibility events.
- Do not include any extra text before/after the JSON. If uncertain, return **event_category: "none"** with low significance.
- Keep numeric values as plain numbers (no percent signs or units inside the JSON fields).

End of instructions.`

		// Create a proper system instruction that will be passed to genaiClient
		const fullPrompt = `${NEWS_ANALYSIS_SYSTEM_PROMPT}\n\n${prompt}`;
		
		let response;
		try {
			const result = await genaiClient.llmCall({
				prompt: fullPrompt,
				opts: { model: GEMINI_MODEL_NAME, temperature: 0.3 },
			});
			response = result.text;
		} catch (primaryError) {
			// Check if error is due to model overload (503 UNAVAILABLE)
			const errorMessage = primaryError.message || '';
			if (errorMessage.includes('503') || errorMessage.includes('UNAVAILABLE') || errorMessage.includes('overloaded')) {
				console.warn('[Gemini] Primary model overloaded, attempting fallback model:', GEMINI_MODEL_NAME_FALLBACK);
				try {
					const fallbackResult = await genaiClient.llmCall({
						prompt: fullPrompt,
						opts: { model: GEMINI_MODEL_NAME_FALLBACK, temperature: 0.3 },
					});
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

/**
 * Generates a structured enriched alert with sentiment, insights, and technical levels
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
		systemPrompt = GEMINI_SYSTEM_PROMPT,
	} = options;

	// Short alert check (< 15 chars or < 2 words)
	if (text.length < 15 || text.split(/\s+/).length < 2) {
		return {
			sentiment: 'NEUTRAL',
			sentiment_score: 0.5,
			insights: [],
			technical_levels: { supports: [], resistances: [] },
		};
	}

	// Prepare prompt with language preservation if needed
	const langDirective = preserveLanguage
		? 'Respond in the same language as the Alert text.'
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
Analyze this alert and provide structured insights, sentiment, and technical levels based on the context.

Alert: ${text}${contextPrompt}${contextSnippet}

Instructions:
- **Output:** Respond *only* with a single, valid JSON object.
- **JSON schema:**
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "sentiment_score": number (0.0 to 1.0),
  "insights": string[] (max 3 key points),
  "technical_levels": {
    "supports": string[],
    "resistances": string[]
  }
}
`;

	try {
		const { text: responseText } = await genaiClient.llmCall({
			prompt,
			context: { citations: searchResults },
			opts: { model: GROUNDING_MODEL_NAME, temperature: 0.2 },
		});

		return parseEnrichedAlertResponse(responseText);
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
			insights: Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3) : [],
			technical_levels: {
				supports: Array.isArray(parsed?.technical_levels?.supports) ? parsed.technical_levels.supports : [],
				resistances: Array.isArray(parsed?.technical_levels?.resistances) ? parsed.technical_levels.resistances : [],
			},
		};
	} catch (error) {
		console.warn(`[Gemini] Response parsing failed, using safe defaults: ${error.message}`);
		return {
			sentiment: 'NEUTRAL',
			sentiment_score: 0.5,
			insights: [],
			technical_levels: { supports: [], resistances: [] },
		};
	}
}