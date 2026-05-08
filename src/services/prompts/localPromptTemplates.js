const { getPromptFileTemplate } = require('./filePromptLoader');

const LOCAL_PROMPT_FILES = Object.freeze({
	SEARCH_QUERY_DERIVATION_SYSTEM: 'search-query-derivation.system.txt',
	SEARCH_QUERY_DERIVATION_USER: 'search-query-derivation.user.txt',
	GROUNDED_SUMMARY_SYSTEM: 'grounded-summary.system.txt',
	GROUNDED_SUMMARY_USER: 'grounded-summary.user.txt',
	ALERT_ENRICHMENT_SYSTEM: 'alert-enrichment.system.txt',
	ALERT_ENRICHMENT_USER: 'alert-enrichment.user.txt',
	NEWS_ANALYSIS_SYSTEM: 'news-analysis.system.txt',
	NEWS_ANALYSIS_USER: 'news-analysis.user.txt',
	NEWS_ANALYSIS_SEARCH_QUERY: 'news-analysis-search-query.txt',
	CONFIDENCE_ENRICHMENT_SYSTEM: 'confidence-enrichment.system.txt',
	CONFIDENCE_ENRICHMENT_USER: 'confidence-enrichment.user.txt',
	MARKET_PRICE_FETCH: 'market-price-fetch.txt',
});

function getSearchQuerySystemPrompt() {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.SEARCH_QUERY_DERIVATION_SYSTEM, {
		envVar: 'SEARCH_QUERY_PROMPT',
	});
}

function getSearchQueryUserPrompt({ alertText }) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.SEARCH_QUERY_DERIVATION_USER, {
		variables: { alertText },
	});
}

function getGroundedSummarySystemPrompt({ maxLength, languageDirective = '' } = {}) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.GROUNDED_SUMMARY_SYSTEM, {
		envVar: 'GEMINI_SYSTEM_PROMPT',
		variables: { maxLength, languageDirective },
	});
}

function getGroundedSummaryUserPrompt({ alertText, maxLength, contextPrompt = '', contextSnippet = '' }) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.GROUNDED_SUMMARY_USER, {
		variables: {
			alertText,
			maxLength,
			contextPrompt,
			contextSnippet,
		},
	});
}

function getAlertEnrichmentSystemPrompt({ languageDirective = '' } = {}) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.ALERT_ENRICHMENT_SYSTEM, {
		envVar: 'ALERT_ENRICHMENT_SYSTEM_PROMPT',
		variables: { languageDirective },
	});
}

function getAlertEnrichmentUserPrompt({ alertContext }) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.ALERT_ENRICHMENT_USER, {
		variables: { alertContext },
	});
}

function getNewsAnalysisSystemPrompt() {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.NEWS_ANALYSIS_SYSTEM, {
		envVar: 'NEWS_ANALYSIS_SYSTEM_PROMPT',
	});
}

function getNewsAnalysisUserPrompt({ symbol, enrichedContext }) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.NEWS_ANALYSIS_USER, {
		variables: { symbol, enrichedContext },
	});
}

function getNewsAnalysisSearchQueryPrompt({ symbol }) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.NEWS_ANALYSIS_SEARCH_QUERY, {
		variables: { symbol },
	});
}

function getConfidenceEnrichmentSystemPrompt() {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.CONFIDENCE_ENRICHMENT_SYSTEM, {
		envVar: 'CONFIDENCE_ENRICHMENT_SYSTEM_PROMPT',
	});
}

function getConfidenceEnrichmentUserPrompt({
	headline,
	sentimentScore,
	eventSignificance,
	sourcesCount,
	sourcesText,
	geminiConfidence,
}) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.CONFIDENCE_ENRICHMENT_USER, {
		variables: {
			headline,
			sentimentScore,
			eventSignificance,
			sourcesCount,
			sourcesText,
			geminiConfidence,
		},
	});
}

function getMarketPriceFetchPrompt({ symbol }) {
	return getPromptFileTemplate(LOCAL_PROMPT_FILES.MARKET_PRICE_FETCH, {
		variables: { symbol },
	});
}

module.exports = {
	LOCAL_PROMPT_FILES,
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
};