// Environment variables and configuration
require('dotenv').config();

const {
	getGroundedSummarySystemPrompt,
	getAlertEnrichmentSystemPrompt,
	getNewsAnalysisSystemPrompt,
	getSearchQuerySystemPrompt,
} = require('../prompts/localPromptTemplates');

// Test mode flag for news monitoring
const ENABLE_NEWS_MONITOR_TEST_MODE = process.env.ENABLE_NEWS_MONITOR_TEST_MODE === 'true';

// Feature enablement and API keys
const ENABLE_GEMINI_GROUNDING = process.env.ENABLE_GEMINI_GROUNDING === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Brave Search Configuration
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
const BRAVE_SEARCH_ENDPOINT = process.env.BRAVE_SEARCH_ENDPOINT || 'https://api.search.brave.com/res/v1/web/search';
const FORCE_BRAVE_SEARCH = process.env.FORCE_BRAVE_SEARCH === 'true';

// Performance and control parameters
const GROUNDING_MAX_SOURCES = parseInt(process.env.GROUNDING_MAX_SOURCES || '3', 10);
const GROUNDING_TIMEOUT_MS = parseInt(process.env.GROUNDING_TIMEOUT_MS || '30000', 10);
const GROUNDING_MAX_LENGTH = parseInt(process.env.GROUNDING_MAX_LENGTH || '2000', 10);
const MODEL_PROVIDER = typeof process.env.MODEL_PROVIDER === 'string' && process.env.MODEL_PROVIDER.trim().length > 0
	? process.env.MODEL_PROVIDER.trim().toLowerCase()
	: 'gemini';
const GROUNDING_MODEL_NAME = FORCE_BRAVE_SEARCH ? 'brave-search' : process.env.GROUNDING_MODEL_NAME || 'gemini-2.5-flash';
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || null;
const GEMINI_MODEL_NAME_FALLBACK = process.env.GEMINI_MODEL_NAME_FALLBACK || 'gemini-2.5-flash-lite';
const AZURE_LLM_MODEL = process.env.AZURE_LLM_MODEL || null;
const AZURE_LLM_ENDPOINT = process.env.AZURE_LLM_ENDPOINT || 'https://models.github.ai/inference';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

// Cloudflare AI Gateway Configuration
const CF_AIG_TOKEN = process.env.CF_AIG_TOKEN;
const CF_AIG_BASE_URL = process.env.CF_AIG_BASE_URL || 'https://gateway.ai.cloudflare.com/v1/f0948fb7672bd3554aa39021ed513b47/default/compat';
const CF_AIG_MODEL = process.env.CF_AIG_MODEL || 'google-ai-studio/gemini-2.5-flash';

// Prompt configuration
const GEMINI_SYSTEM_PROMPT = getGroundedSummarySystemPrompt({
	maxLength: GROUNDING_MAX_LENGTH,
});

const ALERT_ENRICHMENT_SYSTEM_PROMPT = getAlertEnrichmentSystemPrompt();

const NEWS_ANALYSIS_SYSTEM_PROMPT = getNewsAnalysisSystemPrompt();

// Search query prompt
const SEARCH_QUERY_PROMPT = getSearchQuerySystemPrompt();

// Validation
if (ENABLE_GEMINI_GROUNDING && !GEMINI_API_KEY) {
	throw new Error('GEMINI_API_KEY is required when ENABLE_GEMINI_GROUNDING is true');
}

// Export configuration
module.exports = {
	ENABLE_GEMINI_GROUNDING,
	GEMINI_API_KEY,
	BRAVE_SEARCH_API_KEY,
	BRAVE_SEARCH_ENDPOINT,
	FORCE_BRAVE_SEARCH,
	GROUNDING_MAX_SOURCES,
	GROUNDING_TIMEOUT_MS,
	GEMINI_SYSTEM_PROMPT,
	ALERT_ENRICHMENT_SYSTEM_PROMPT,
	NEWS_ANALYSIS_SYSTEM_PROMPT,
	SEARCH_QUERY_PROMPT,
	GROUNDING_MODEL_NAME,
	GEMINI_MODEL_NAME,
	GEMINI_MODEL_NAME_FALLBACK,
	ENABLE_NEWS_MONITOR_TEST_MODE,
	AZURE_LLM_MODEL,
	AZURE_LLM_ENDPOINT,
	OPENROUTER_API_KEY,
	OPENROUTER_MODEL,
	CF_AIG_TOKEN,
	CF_AIG_BASE_URL,
	CF_AIG_MODEL,
	MODEL_PROVIDER,
};
