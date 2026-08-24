const { validateAlert } = require('../../../../lib/validation');
const { groundAlert } = require('../../../../services/grounding/grounding');
const { GROUNDING_MODEL_NAME } = require('../../../../services/grounding/config');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
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

	if (supports.length === 0 && resistances.length === 0) {
		return undefined;
	}

	return { supports, resistances };
}

function isOptionalRiskValue(value) {
	return (typeof value === 'number' && Number.isFinite(value))
		|| (typeof value === 'string' && value.trim().length > 0);
}

function pickSetupType(...values) {
	return values.find(value => (
		typeof value === 'string'
		&& ['breakout', 'mean_reversion', 'trend_continuation', 'reversal'].includes(value)
	));
}

function hasCompleteRiskMetadata(value = {}) {
	return ['invalidation_level', 'target_level', 'risk_reward_ratio']
		.every(field => isOptionalRiskValue(value[field]));
}

function selectRiskMetadata(gemini, mcp) {
	const source = hasCompleteRiskMetadata(mcp) ? mcp : hasCompleteRiskMetadata(gemini) ? gemini : null;
	const setupType = pickSetupType(gemini.setup_type, mcp.setup_type);
	if (!source) {
		return setupType ? { setup_type: setupType } : {};
	}

	return {
		invalidation_level: source.invalidation_level,
		target_level: source.target_level,
		risk_reward_ratio: source.risk_reward_ratio,
		...(setupType ? { setup_type: setupType } : {}),
	};
}

function extractPriorityMcpInsights(mcp = {}) {
	if (!mcp.confluenceData || !Array.isArray(mcp.insights)) {
		return [];
	}

	return mcp.insights.filter(insight => (
		typeof insight === 'string'
		&& (insight.startsWith('Confluencia:') || insight.startsWith('Confluencia contradictoria:'))
	));
}

function hasContradictoryConfluence(mcp = {}) {
	if (mcp && mcp.confluenceData) {
		const conf = mcp.confluenceData.confluence || mcp.confluenceData;
		if (conf) {
			const signalsAgree = conf.signals_agree;
			if (signalsAgree === false || ['NO', 'FALSE', '0'].includes(String(signalsAgree).toUpperCase())) {
				return true;
			}
			const rec = String(conf.recommendation || conf.action || '').toUpperCase();
			const isSell = rec.includes('SELL') || rec.includes('VENTA') || rec.includes('SHORT');
			const isBuy = rec.includes('BUY') || rec.includes('COMPRA') || rec.includes('LONG');
			if (mcp.sentiment === 'BEARISH' && isBuy) {
				return true;
			}
			if (mcp.sentiment === 'BULLISH' && isSell) {
				return true;
			}
		}
	}

	return hasContradictoryConfluenceInsight(mcp);
}

function hasContradictoryConfluenceInsight(mcp = {}) {
	return Array.isArray(mcp && mcp.insights)
		&& mcp.insights.some(insight => typeof insight === 'string' && insight.startsWith('Confluencia contradictoria:'));
}

function applySignCoherenceGuard(sentiment, score) {
	const clampedScore = typeof score === 'number' && Number.isFinite(score)
		? Math.max(-1, Math.min(1, score))
		: 0;

	if (sentiment === 'BEARISH') {
		const finalScore = clampedScore > 0
			? -clampedScore
			: (clampedScore < 0 ? clampedScore : -0.5);
		return { sentiment: 'BEARISH', sentiment_score: finalScore };
	}

	if (sentiment === 'BULLISH') {
		const finalScore = clampedScore < 0
			? -clampedScore
			: (clampedScore > 0 ? clampedScore : 0.5);
		return { sentiment: 'BULLISH', sentiment_score: finalScore };
	}

	return { sentiment: 'NEUTRAL', sentiment_score: 0 };
}

function selectSentimentAndScore(gemini = {}, mcp = {}) {
	const isMcpApplied = mcp.tradingViewEnrichmentApplied === true
		|| (mcp.tradingViewEnrichmentApplied !== false && Boolean(mcp.sentiment || typeof mcp.sentiment_score === 'number' || mcp.confluenceData || (Array.isArray(mcp.insights) && mcp.insights.length > 0)));

	const geminiSentiment = (typeof gemini.sentiment === 'string' && ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(gemini.sentiment))
		? gemini.sentiment
		: null;
	const geminiScore = (typeof gemini.sentiment_score === 'number' && Number.isFinite(gemini.sentiment_score))
		? gemini.sentiment_score
		: null;

	const mcpSentiment = (typeof mcp.sentiment === 'string' && ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(mcp.sentiment))
		? mcp.sentiment
		: null;
	const mcpScore = (typeof mcp.sentiment_score === 'number' && Number.isFinite(mcp.sentiment_score))
		? mcp.sentiment_score
		: null;

	const contradictoryConfluence = isMcpApplied && hasContradictoryConfluence(mcp);

	// Detect conflict between providers
	const hasLabelConflict = isMcpApplied && geminiSentiment && mcpSentiment
		&& geminiSentiment !== 'NEUTRAL' && mcpSentiment !== 'NEUTRAL'
		&& geminiSentiment !== mcpSentiment;
	const hasScoreConflict = isMcpApplied && geminiScore !== null && mcpScore !== null
		&& ((geminiScore > 0 && mcpScore < 0) || (geminiScore < 0 && mcpScore > 0));
	const sentimentConflict = hasLabelConflict || hasScoreConflict;

	let chosenSentiment = 'NEUTRAL';
	let chosenScore = 0;

	if (contradictoryConfluence) {
		chosenSentiment = mcpSentiment || 'NEUTRAL';
		chosenScore = mcpScore !== null ? mcpScore : (chosenSentiment === 'BEARISH' ? -0.5 : chosenSentiment === 'BULLISH' ? 0.5 : 0);
	} else if (sentimentConflict) {
		console.warn('[Alert] Sentiment conflict between Gemini and TradingView MCP; selecting MCP indicators over LLM prose');
		chosenSentiment = mcpSentiment || 'NEUTRAL';
		chosenScore = mcpScore !== null ? mcpScore : (chosenSentiment === 'BEARISH' ? -0.5 : chosenSentiment === 'BULLISH' ? 0.5 : 0);
	} else if (geminiSentiment !== null || geminiScore !== null) {
		chosenSentiment = geminiSentiment || 'NEUTRAL';
		chosenScore = geminiScore !== null ? geminiScore : (chosenSentiment === 'BEARISH' ? -0.5 : chosenSentiment === 'BULLISH' ? 0.5 : 0);
	} else if (isMcpApplied && (mcpSentiment !== null || mcpScore !== null)) {
		chosenSentiment = mcpSentiment || 'NEUTRAL';
		chosenScore = mcpScore !== null ? mcpScore : (chosenSentiment === 'BEARISH' ? -0.5 : chosenSentiment === 'BULLISH' ? 0.5 : 0);
	} else {
		chosenSentiment = mcpSentiment || geminiSentiment || 'NEUTRAL';
		chosenScore = mcpScore ?? geminiScore ?? 0;
	}

	const guarded = applySignCoherenceGuard(chosenSentiment, chosenScore);

	return {
		sentiment: guarded.sentiment,
		sentiment_score: guarded.sentiment_score,
		sentimentConflict: sentimentConflict ? true : undefined,
	};
}

function isMessageFooterMetadataEnabled() {
	return getRuntimeConfig().ENABLE_MESSAGE_FOOTER_METADATA;
}

function mergeEnrichmentData(text, geminiEnriched, mcpEnriched) {
	try {
		const gemini = geminiEnriched || {};
		const mcp = mcpEnriched || {};

		const geminiLevels = gemini.technical_levels || { supports: [], resistances: [] };
		const mcpLevels = mcp.technical_levels || { supports: [], resistances: [] };
		const technicalLevels = buildTechnicalLevels({
			supports: mergeUnique(geminiLevels.supports || [], mcpLevels.supports || []),
			resistances: mergeUnique(geminiLevels.resistances || [], mcpLevels.resistances || []),
		});

		const { sentiment, sentiment_score, sentimentConflict } = selectSentimentAndScore(gemini, mcp);

		const geminiBackticked = extractBacktickedValues(gemini.extraText);
		const modelName = geminiBackticked[0] || GROUNDING_MODEL_NAME;
		const groundingFromGemini = geminiBackticked[1] || GROUNDING_MODEL_NAME;
		const groundingProviders = mergeUnique([groundingFromGemini], ['tradingview-mcp'], 8);
		const extraText = isMessageFooterMetadataEnabled()
			? '*Model used*: ' + '`' + `${modelName}` + '`' + '\n*Grounding*: ' + '`' + `${groundingProviders.join('`, `')}` + '`'
			: '';
		const priorityMcpInsights = extractPriorityMcpInsights(mcp);
		const remainingMcpInsights = Array.isArray(mcp.insights)
			? mcp.insights.filter(insight => !priorityMcpInsights.includes(insight))
			: [];
		const insights = mergeUnique(
			priorityMcpInsights,
			mergeUnique(gemini.insights || [], remainingMcpInsights),
		);
		const optionalRiskMetadata = selectRiskMetadata(gemini, mcp);

		const mcpCurrentPrice = typeof mcp.current_price === 'number' && Number.isFinite(mcp.current_price) && mcp.current_price > 0
			? mcp.current_price
			: (mcp.price_data && typeof mcp.price_data.current_price === 'number' && Number.isFinite(mcp.price_data.current_price) && mcp.price_data.current_price > 0
				? mcp.price_data.current_price
				: null);

		return {
			original_text: text,
			tradingViewEnrichmentApplied: mcp.tradingViewEnrichmentApplied === true,
			...(mcp.tradingViewEnrichmentStatus ? { tradingViewEnrichmentStatus: mcp.tradingViewEnrichmentStatus } : {}),
			sentiment,
			sentiment_score,
			...(sentimentConflict ? { sentimentConflict: true } : {}),
			current_price: mcpCurrentPrice,
			...(mcp.price_data ? { price_data: mcp.price_data } : {}),
			insights,
			...(technicalLevels ? { technical_levels: technicalLevels } : {}),
			sources: Array.isArray(gemini.sources) ? gemini.sources : [],
			truncated: !!(gemini.truncated || mcp.truncated),
			extraText,
			confluenceData: mcp.confluenceData || null,
			multiTimeframeData: mcp.multiTimeframeData || null,
			...(gemini.promptProvenance ? { promptProvenance: gemini.promptProvenance } : {}),
			...Object.fromEntries(
				Object.entries(optionalRiskMetadata).filter(([, value]) => value !== undefined),
			),
		};
	} catch (error) {
		console.warn('[Alert] mergeEnrichmentData encountered error, falling back:', error.message);
		const fallback = geminiEnriched || mcpEnriched || {};
		const guarded = applySignCoherenceGuard(fallback.sentiment || 'NEUTRAL', fallback.sentiment_score || 0);
		return {
			original_text: text,
			...fallback,
			sentiment: guarded.sentiment,
			sentiment_score: guarded.sentiment_score,
		};
	}
}

async function enrichWithGemini(text, tokenUsage) {
	const {
		sentiment,
		sentiment_score,
		insights,
		sources,
		truncated,
		modelUsed,
		promptProvenance,
		invalidation_level,
		target_level,
		setup_type,
		risk_reward_ratio,
	} = await groundAlert({
		text,
		options: {
			preserveLanguage: true,
			tokenUsage,
		},
	});

	// Build footer with model metadata (controlled by env var, default: true)
	const enableFooter = isMessageFooterMetadataEnabled();
	const modelName = modelUsed || GROUNDING_MODEL_NAME;
	const extraText = enableFooter
		? '*Model used*: ' + '`' + `${modelName}` + '`' + '\n*Grounding*: ' + '`' + `${GROUNDING_MODEL_NAME}` + '`'
		: '';

	const hasSentiment = typeof sentiment === 'string' || typeof sentiment_score === 'number';
	const guarded = hasSentiment ? applySignCoherenceGuard(sentiment, sentiment_score) : null;

	return {
		original_text: text,
		...(guarded ? { sentiment: guarded.sentiment, sentiment_score: guarded.sentiment_score } : {}),
		insights,
		sources,
		truncated,
		extraText,
		...(promptProvenance ? { promptProvenance } : {}),
		...Object.fromEntries(
			Object.entries({ invalidation_level, target_level, setup_type, risk_reward_ratio })
				.filter(([, value]) => value !== undefined),
		),
	};
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
	const isGeminiEnabled = getRuntimeConfig().ENABLE_GEMINI_GROUNDING;
	const shouldUseTradingViewData = options.useTradingViewData === true;
	const isMcpEnabled = shouldUseTradingViewData && tradingViewMcpService.isEnabled();

	if (!isGeminiEnabled && !isMcpEnabled) {
		return null;
	}

	let mcpEnrichedAlert = null;
	let mcpEnrichmentFailed = false;
	if (isMcpEnabled) {
		try {
			mcpEnrichedAlert = await tradingViewMcpService.enrichFromAlertText(text);
		} catch (error) {
			mcpEnrichmentFailed = true;
			console.warn('[Alert] TradingView MCP enrichment failed, continuing with grounding flow:', error.message);
		}
	}

	if (!isGeminiEnabled) {
		if (mcpEnrichmentFailed) {
			throw new Error('TradingView MCP enrichment failed');
		}
		if (mcpEnrichedAlert) {
			const guarded = applySignCoherenceGuard(mcpEnrichedAlert.sentiment, mcpEnrichedAlert.sentiment_score);
			return {
				...mcpEnrichedAlert,
				sentiment: guarded.sentiment,
				sentiment_score: guarded.sentiment_score,
			};
		}
		return mcpEnrichedAlert;
	}

	try {
		const geminiEnrichedAlert = await enrichWithGemini(text, tokenUsage);

		if (mcpEnrichedAlert) {
			return mergeEnrichmentData(text, geminiEnrichedAlert, mcpEnrichedAlert);
		}

		if (geminiEnrichedAlert) {
			const guarded = applySignCoherenceGuard(geminiEnrichedAlert.sentiment, geminiEnrichedAlert.sentiment_score);
			return {
				...geminiEnrichedAlert,
				sentiment: guarded.sentiment,
				sentiment_score: guarded.sentiment_score,
			};
		}

		return geminiEnrichedAlert;
	} catch (error) {
		if (mcpEnrichedAlert) {
			console.warn('[Alert] Gemini grounding failed, using TradingView MCP enrichment:', error.message);
			const guarded = applySignCoherenceGuard(mcpEnrichedAlert.sentiment, mcpEnrichedAlert.sentiment_score);
			return {
				...mcpEnrichedAlert,
				sentiment: guarded.sentiment,
				sentiment_score: guarded.sentiment_score,
			};
		}

		throw new Error(`Alert enrichment failed: ${error.message}`);
	}
}

module.exports = {
	deriveSearchQuery,
	enrichAlert,
};
