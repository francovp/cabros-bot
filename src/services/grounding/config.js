// Environment variables and configuration
require('dotenv').config();

// Test mode flag for news monitoring
ENABLE_NEWS_MONITOR_TEST_MODE = process.env.ENABLE_NEWS_MONITOR_TEST_MODE === 'true';

// Feature enablement and API keys
const ENABLE_GEMINI_GROUNDING = process.env.ENABLE_GEMINI_GROUNDING === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Performance and control parameters
const GROUNDING_MAX_SOURCES = parseInt(process.env.GROUNDING_MAX_SOURCES || '3', 10);
const GROUNDING_TIMEOUT_MS = parseInt(process.env.GROUNDING_TIMEOUT_MS || '30000', 10);
const GROUNDING_MAX_LENGTH = parseInt(process.env.GROUNDING_MAX_LENGTH || '2000', 10);
const MODEL_PROVIDER = process.env.MODEL_PROVIDER || 'gemini';
const GROUNDING_MODEL_NAME = process.env.GROUNDING_MODEL_NAME || 'gemini-2.5-flash';
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || null;
const GEMINI_MODEL_NAME_FALLBACK = process.env.GEMINI_MODEL_NAME_FALLBACK || 'gemini-2.5-flash-lite';
const AZURE_LLM_MODEL = process.env.AZURE_LLM_MODEL || null;
const AZURE_LLM_ENDPOINT = process.env.AZURE_LLM_ENDPOINT || 'https://models.github.ai/inference';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

// Prompt configuration
const GEMINI_SYSTEM_PROMPT = process.env.GEMINI_SYSTEM_PROMPT || `
You are a helpful assistant that provides concise summaries of alerts with verified context.
Focus on:
1. Key facts and updates
2. Market impact or implications 
3. Related context from reliable sources

Keep summaries under ${GROUNDING_MAX_LENGTH} characters.
Preserve the original language of the alert if possible.
`.trim();

const ALERT_ENRICHMENT_SYSTEM_PROMPT = 'You are a financial market analyst. Your job is to analyze alerts and provide structured insights, sentiment, and technical levels.';

const NEWS_ANALYSIS_SYSTEM_PROMPT = `You are a financial market sentiment analyst specializing in crypto and stock news analysis.
Analyze the provided news/context and detect market-moving events.`;

// Search query prompt
const SEARCH_QUERY_PROMPT = process.env.SEARCH_QUERY_PROMPT || `
Extract key topics and entities from this alert to create a search query.
Focus on recent developments, market conditions, or specific events mentioned.
`.trim();

// Validation
if (ENABLE_GEMINI_GROUNDING && !GEMINI_API_KEY) {
	throw new Error('GEMINI_API_KEY is required when ENABLE_GEMINI_GROUNDING is true');
}

// Export configuration
module.exports = {
	ENABLE_GEMINI_GROUNDING,
	GEMINI_API_KEY,
	GROUNDING_MAX_SOURCES,
	GROUNDING_TIMEOUT_MS,
	GEMINI_SYSTEM_PROMPT,
	ALERT_ENRICHMENT_SYSTEM_PROMPT,
	NEWS_ANALYSIS_SYSTEM_PROMPT,
	SEARCH_QUERY_PROMPT,
	GROUNDING_MODEL_NAME,
	GEMINI_MODEL_NAME,
	GEMINI_MODEL_NAME_FALLBACK,
	AZURE_LLM_MODEL,
	AZURE_LLM_ENDPOINT,
	OPENROUTER_API_KEY,
	OPENROUTER_MODEL,
	MODEL_PROVIDER,
};