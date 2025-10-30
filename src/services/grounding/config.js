// Environment variables and configuration
require('dotenv').config();

// Feature enablement and API keys
const ENABLE_GEMINI_GROUNDING = process.env.ENABLE_GEMINI_GROUNDING === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Performance and control parameters
const GROUNDING_MAX_SOURCES = parseInt(process.env.GROUNDING_MAX_SOURCES || '3', 10);
const GROUNDING_TIMEOUT_MS = parseInt(process.env.GROUNDING_TIMEOUT_MS || '30000', 10);
const GROUNDING_MAX_LENGTH = parseInt(process.env.GROUNDING_MAX_LENGTH || '2000', 10);
const GROUNDING_MODEL_NAME = process.env.GROUNDING_MODEL_NAME || 'gemini-2.5-flash';

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
	SEARCH_QUERY_PROMPT,
	GROUNDING_MODEL_NAME,
};