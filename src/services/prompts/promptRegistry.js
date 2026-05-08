const {
	GROUNDING_MAX_LENGTH,
} = require('../grounding/config');
const {
	getSearchQuerySystemPrompt,
	getSearchQueryUserPrompt,
	getGroundedSummarySystemPrompt,
	getGroundedSummaryUserPrompt,
	getAlertEnrichmentSystemPrompt,
	getAlertEnrichmentUserPrompt,
	getNewsAnalysisSystemPrompt,
	getNewsAnalysisUserPrompt,
	getNewsAnalysisSearchQueryPrompt,
	getConfidenceEnrichmentSystemPrompt,
	getConfidenceEnrichmentUserPrompt,
	getMarketPriceFetchPrompt,
} = require('./localPromptTemplates');

const PromptKeys = Object.freeze({
	SEARCH_QUERY_DERIVATION: 'SEARCH_QUERY_DERIVATION',
	GROUNDED_SUMMARY: 'GROUNDED_SUMMARY',
	ALERT_ENRICHMENT: 'ALERT_ENRICHMENT',
	NEWS_ANALYSIS: 'NEWS_ANALYSIS',
	NEWS_ANALYSIS_SEARCH_QUERY: 'NEWS_ANALYSIS_SEARCH_QUERY',
	CONFIDENCE_ENRICHMENT: 'CONFIDENCE_ENRICHMENT',
	MARKET_PRICE_FETCH: 'MARKET_PRICE_FETCH',
});

const CONFIDENCE_ENRICHMENT_SYSTEM_PROMPT = getConfidenceEnrichmentSystemPrompt();

const PROMPT_DEFINITIONS = {
	[PromptKeys.SEARCH_QUERY_DERIVATION]: {
		name: 'search-query-derivation',
		type: 'chat',
		buildFallback: ({ alertText }) => ({
			type: 'chat',
			messages: [
				{ role: 'system', content: getSearchQuerySystemPrompt() },
				{ role: 'user', content: getSearchQueryUserPrompt({ alertText }) },
			],
		}),
	},
	[PromptKeys.GROUNDED_SUMMARY]: {
		name: 'grounded-summary',
		type: 'chat',
		buildFallback: ({ alertText, maxLength = GROUNDING_MAX_LENGTH, languageDirective = '', contextPrompt = '', contextSnippet = '' }) => ({
			type: 'chat',
			messages: [
				{
					role: 'system',
					content: getGroundedSummarySystemPrompt({ maxLength, languageDirective }),
				},
				{
					role: 'user',
					content: getGroundedSummaryUserPrompt({
						alertText,
						maxLength,
						contextPrompt,
						contextSnippet,
					}),
				},
			],
		}),
	},
	[PromptKeys.ALERT_ENRICHMENT]: {
		name: 'alert-enrichment',
		type: 'chat',
		buildFallback: ({ alertContext, languageDirective = '' }) => ({
			type: 'chat',
			messages: [
				{
					role: 'system',
					content: getAlertEnrichmentSystemPrompt({ languageDirective }),
				},
				{
					role: 'user',
					content: getAlertEnrichmentUserPrompt({ alertContext }),
				},
			],
		}),
	},
	[PromptKeys.NEWS_ANALYSIS]: {
		name: 'news-analysis',
		type: 'chat',
		buildFallback: ({ symbol, enrichedContext }) => ({
			type: 'chat',
			messages: [
				{ role: 'system', content: getNewsAnalysisSystemPrompt() },
				{
					role: 'user',
					content: getNewsAnalysisUserPrompt({ symbol, enrichedContext }),
				},
			],
		}),
	},
	[PromptKeys.NEWS_ANALYSIS_SEARCH_QUERY]: {
		name: 'news-analysis-search-query',
		type: 'text',
		buildFallback: ({ symbol }) => ({
			type: 'text',
			text: getNewsAnalysisSearchQueryPrompt({ symbol }),
		}),
	},
	[PromptKeys.CONFIDENCE_ENRICHMENT]: {
		name: 'confidence-enrichment',
		type: 'chat',
		buildFallback: ({ headline, sentimentScore, eventSignificance, sourcesCount, sourcesText, geminiConfidence }) => ({
			type: 'chat',
			messages: [
				{ role: 'system', content: getConfidenceEnrichmentSystemPrompt() },
				{
					role: 'user',
					content: getConfidenceEnrichmentUserPrompt({
						headline,
						sentimentScore,
						eventSignificance,
						sourcesCount,
						sourcesText,
						geminiConfidence,
					}),
				},
			],
		}),
	},
	[PromptKeys.MARKET_PRICE_FETCH]: {
		name: 'market-price-fetch',
		type: 'text',
		buildFallback: ({ symbol }) => ({
			type: 'text',
			text: getMarketPriceFetchPrompt({ symbol }),
		}),
	},
};

function getPromptDefinition(promptKey) {
	const definition = PROMPT_DEFINITIONS[promptKey];
	if (!definition) {
		throw new Error(`Unknown prompt key: ${promptKey}`);
	}

	return definition;
}

module.exports = {
	PromptKeys,
	PROMPT_DEFINITIONS,
	CONFIDENCE_ENRICHMENT_SYSTEM_PROMPT,
	getPromptDefinition,
};