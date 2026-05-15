const { validateAlert } = require('../../../../lib/validation');
const { groundAlert } = require('../../../../services/grounding/grounding');
const { GROUNDING_MODEL_NAME } = require('../../../../services/grounding/config');
const { normalizeActionableAlert, URGENCY_ORDER } = require('../../../../services/alerts/actionableAlert');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');

function mergeUnique(first = [], second = [], maxItems = 6) {
	const result = [];
	const seen = new Set();

	[first, second].forEach(group => {
		(group || []).forEach(item => {
			if (!item || typeof item !== 'string') {
				return;
			}

			if (!seen.has(item)) {
				seen.add(item);
				result.push(item);
			}
		});
	});

	return result.slice(0, maxItems);
}

function extractBacktickedValues(text = '') {
	if (!text || typeof text !== 'string') {
		return [];
	}

	const matches = [...text.matchAll(/`([^`]+)`/g)];
	return matches.map(match => match[1]).filter(Boolean);
}

function buildTechnicalLevels(levels = {}) {
	const supports = mergeUnique(levels.supports || [], [], 6);
	const resistances = mergeUnique(levels.resistances || [], [], 6);

	return { supports, resistances };
}

function pickFirstText(...values) {
	return values.find(value => typeof value === 'string' && value.trim()) || '';
}

function resolveUrgencyLevel(primary, secondary) {
	const primaryScore = URGENCY_ORDER[primary] || 0;
	const secondaryScore = URGENCY_ORDER[secondary] || 0;
	return primaryScore >= secondaryScore ? primary : secondary;
}

function resolveSentiment(primarySentiment, secondarySentiment, primaryScore, secondaryScore) {
	const primaryIsMeaningful = primarySentiment && (primarySentiment !== 'NEUTRAL' || Math.abs(primaryScore || 0) > 0);
	if (primaryIsMeaningful) {
		return primarySentiment;
	}

	const secondaryIsMeaningful = secondarySentiment && (secondarySentiment !== 'NEUTRAL' || Math.abs(secondaryScore || 0) > 0);
	if (secondaryIsMeaningful) {
		return secondarySentiment;
	}

	return primarySentiment || secondarySentiment || 'NEUTRAL';
}

function resolveSignalSide(primary, secondary) {
	if (secondary && secondary !== 'WAIT') {
		return secondary;
	}

	if (primary && primary !== 'WAIT') {
		return primary;
	}

	return primary || secondary || null;
}

function resolveSentimentScore(primaryScore, secondaryScore) {
	const primaryIsNumber = typeof primaryScore === 'number' && !Number.isNaN(primaryScore);
	const secondaryIsNumber = typeof secondaryScore === 'number' && !Number.isNaN(secondaryScore);

	if (primaryIsNumber && Math.abs(primaryScore) > 0) {
		return primaryScore;
	}

	if (secondaryIsNumber && Math.abs(secondaryScore) > 0) {
		return secondaryScore;
	}

	if (primaryIsNumber) {
		return primaryScore;
	}

	if (secondaryIsNumber) {
		return secondaryScore;
	}

	return 0;
}

function mergeScenarios(primary = {}, secondary = {}) {
	return {
		bull: (primary && primary.bull) || (secondary && secondary.bull) || null,
		bear: (primary && primary.bear) || (secondary && secondary.bear) || null,
	};
}

function mergeEnrichmentData(text, geminiEnriched, mcpEnriched) {
	const gemini = geminiEnriched || {};
	const mcp = mcpEnriched || {};

	const geminiLevels = gemini.technical_levels || { supports: [], resistances: [] };
	const mcpLevels = mcp.technical_levels || { supports: [], resistances: [] };
	const technicalLevels = buildTechnicalLevels({
		supports: mergeUnique(geminiLevels.supports || [], mcpLevels.supports || []),
		resistances: mergeUnique(geminiLevels.resistances || [], mcpLevels.resistances || []),
	});

	const geminiScore = typeof gemini.sentiment_score === 'number' ? gemini.sentiment_score : null;
	const mcpScore = typeof mcp.sentiment_score === 'number' ? mcp.sentiment_score : null;

	const geminiBackticked = extractBacktickedValues(gemini.extraText);
	const modelName = geminiBackticked[0] || GROUNDING_MODEL_NAME;
	const groundingFromGemini = geminiBackticked[1] || GROUNDING_MODEL_NAME;
	const groundingProviders = mergeUnique([groundingFromGemini], ['tradingview-mcp'], 8);
	const extraText = '*Model used*: ' + '`' + `${modelName}` + '`' + '\n*Grounding*: ' + '`' + `${groundingProviders.join('`, `')}` + '`';
	const urgencyLevel = resolveUrgencyLevel(gemini.urgency_level, mcp.urgency_level);

	return normalizeActionableAlert({
		...mcp,
		...gemini,
		original_text: text,
		sentiment: resolveSentiment(gemini.sentiment, mcp.sentiment, geminiScore, mcpScore),
		sentiment_score: resolveSentimentScore(geminiScore, mcpScore),
		insights: mergeUnique(gemini.insights || [], mcp.insights || []),
		technical_levels: technicalLevels,
		sources: Array.isArray(gemini.sources) ? gemini.sources : [],
		truncated: !!(gemini.truncated || mcp.truncated),
		extraText,
		headline: pickFirstText(gemini.headline, mcp.headline),
		recommended_action: pickFirstText(gemini.recommended_action, mcp.recommended_action),
		urgency_level: urgencyLevel,
		urgency_reason: urgencyLevel === mcp.urgency_level
			? pickFirstText(mcp.urgency_reason, gemini.urgency_reason)
			: pickFirstText(gemini.urgency_reason, mcp.urgency_reason),
		risk_warning: pickFirstText(gemini.risk_warning, mcp.risk_warning) || null,
		scenarios: mergeScenarios(gemini.scenarios, mcp.scenarios),
		asset_symbol: pickFirstText(gemini.asset_symbol, mcp.asset_symbol) || null,
		timeframe: pickFirstText(gemini.timeframe, mcp.timeframe) || null,
		signal_side: resolveSignalSide(gemini.signal_side, mcp.signal_side),
		language: gemini.language || mcp.language,
		market_context: gemini.market_context || mcp.market_context,
		indicator_context: gemini.indicator_context || mcp.indicator_context,
	});
}

async function enrichWithGemini(text, tokenUsage) {
	const {
		sentiment,
		sentiment_score,
		insights,
		technical_levels,
		scenarios,
		headline,
		recommended_action,
		urgency_level,
		urgency_reason,
		risk_warning,
		asset_symbol,
		timeframe,
		signal_side,
		sources,
		truncated,
		modelUsed,
	} = await groundAlert({
		text,
		options: {
			preserveLanguage: true,
			tokenUsage,
		},
	});

	// Build footer with model metadata (controlled by env var, default: true)
	const enableFooter = process.env.ENABLE_MESSAGE_FOOTER_METADATA !== 'false';
	const modelName = modelUsed || GROUNDING_MODEL_NAME;
	const extraText = enableFooter
		? '*Model used*: ' + '`' + `${modelName}` + '`' + '\n*Grounding*: ' + '`' + `${GROUNDING_MODEL_NAME}` + '`'
		: '';

	return normalizeActionableAlert({
		original_text: text,
		sentiment,
		sentiment_score,
		insights,
		technical_levels,
		scenarios,
		headline,
		recommended_action,
		urgency_level,
		urgency_reason,
		risk_warning,
		asset_symbol,
		timeframe,
		signal_side,
		sources,
		truncated,
		extraText,
	});
}

/**
 * Derives a search query from alert text
 * @param {string} alertText Raw text to derive query from
 * @param {number} maxLength Maximum length for the generated query
 * @returns {Promise<{query: string, confidence: number}>}
 */
async function deriveSearchQuery(alertText, maxLength = 150) {
	const { text } = validateAlert(alertText);

	try {
		const { query, confidence } = await groundAlert.deriveSearchQuery(text, { maxLength });
		return { query, confidence };
	} catch (error) {
		// Fallback to simple approach if LLM fails
		const cleanText = text
			.replace(/[^\w\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();

		// Preserve whole words up to maxLength
		let query = cleanText;
		if (query.length > maxLength) {
			query = query.substring(0, maxLength);
			query = query.substring(0, query.lastIndexOf(' '));
		}

		// Add context keywords for financial/crypto alerts
		query += ' crypto cryptocurrency market news';

		return {
			query,
			// Lower confidence when using fallback
			confidence: 0.5,
		};
	}
}

/**
 * Enriches an alert with grounded context using Gemini
 *
 * Returns an EnrichedAlert object where:
 * - `original_text` comes from the webhook request body
 * - `sources` are derived from `genaiClient.search` `searchResults`
 *
 * @see specs/004-enrich-alert-output/contracts/api.md for the full data contract
 * @param {import('./types').Alert} alert
 * @returns {Promise<import('./types').EnrichedAlert>}
 */
async function enrichAlert(alert, options = {}) {
	// Support being called with either a plain text string or an object
	// { text, metadata }
	const inputText = (typeof alert === 'string') ? alert : (alert && typeof alert.text === 'string' ? alert.text : alert);
	const metadata = (alert && alert.metadata) ? alert.metadata : null;
	const tokenUsage = options.tokenUsage;

	const validated = validateAlert(inputText, metadata);
	// validateAlert may return either a string (when mocked in tests) or an object { text, metadata }
	const text = (typeof validated === 'string') ? validated : (validated && validated.text) ? validated.text : inputText;
	const isGeminiEnabled = process.env.ENABLE_GEMINI_GROUNDING === 'true';
	const shouldUseTradingViewData = options.useTradingViewData === true;
	const isMcpEnabled = shouldUseTradingViewData && tradingViewMcpService.isEnabled();

	if (!isGeminiEnabled && !isMcpEnabled) {
		return null;
	}

	let mcpEnrichedAlert = null;
	if (isMcpEnabled) {
		try {
			mcpEnrichedAlert = await tradingViewMcpService.enrichFromAlertText(text);
		} catch (error) {
			console.warn('[Alert] TradingView MCP enrichment failed, continuing with grounding flow:', error.message);
		}
	}

	if (!isGeminiEnabled) {
		return mcpEnrichedAlert;
	}

	try {
		const geminiEnrichedAlert = await enrichWithGemini(text, tokenUsage);

		if (mcpEnrichedAlert) {
			return mergeEnrichmentData(text, geminiEnrichedAlert, mcpEnrichedAlert);
		}

		return geminiEnrichedAlert;
	} catch (error) {
		if (mcpEnrichedAlert) {
			console.warn('[Alert] Gemini grounding failed, using TradingView MCP enrichment:', error.message);
			return mcpEnrichedAlert;
		}

		throw new Error(`Alert enrichment failed: ${error.message}`);
	}
}

module.exports = {
	deriveSearchQuery,
	enrichAlert,
};
