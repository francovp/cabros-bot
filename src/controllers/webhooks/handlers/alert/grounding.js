const { validateAlert } = require('../../../../lib/validation');
const { groundAlert } = require('../../../../services/grounding/grounding');
const { GROUNDING_MODEL_NAME } = require('../../../../services/grounding/config');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const { parseTradingViewSignal } = require('../../../../services/tradingview/parseTradingViewSignal');
const {
	deriveFallbackTradePlan,
	calculateFallbackRiskLevels,
} = require('../../../../services/tradingview/fallbackTradePlan');
const {
	toPositiveFiniteNumber,
	computeDeterministicRiskReward,
} = require('../../../../services/tradingview/riskRewardMath');
const { tokenCostBudgetService } = require('../../../../lib/tokenUsage');

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

// GH-599: `risk_reward_ratio` is the one optional-risk field the provider is allowed
// to omit, and it is pure arithmetic over fields we already have. Treating its absence
// as "the whole block is unusable" made the fallback path discard real grounded entry
// prices and levels — the precise data loss this issue exists to prevent. So compute
// the ratio from the grounded entry/levels instead of throwing them away.
//
// A returned `side: null` means the block is NOT salvageable and the caller must fall
// back to a derived plan: the entry price is missing/non-positive, or the levels are
// not on the correct side of entry (a BUY whose stop sits above entry has no R:R).
// `computeDeterministicRiskReward` already encodes exactly those rejections.
function completeGroundedRiskMetadata(value = {}, parsedSignal) {
	const side = parsedSignal && parsedSignal.side ? parsedSignal.side : null;
	if (!side) {
		return { side: null };
	}

	const riskRewardRatio = computeDeterministicRiskReward({
		entry: value.current_price,
		invalidation: value.invalidation_level,
		target: value.target_level,
		side,
	});
	if (riskRewardRatio === null || !(riskRewardRatio > 0)) {
		return { side: null };
	}

	return {
		side,
		invalidation_level: value.invalidation_level,
		target_level: value.target_level,
		risk_reward_ratio: riskRewardRatio,
	};
}

// GH-1229: a heuristic per-timeframe percentage plan is NOT a provider-derived level.
// It is numerically complete, so it must not outrank a real support/resistance level
// just by virtue of filling all three fields. `levelsSource` is the provenance signal
// that lets the merge weigh it below a genuine provider block.
//
// Precedence, highest first:
//   1. ATR/MCP levels  - real provider data
//   2. Gemini levels   - real provider data (support/resistance parsed from grounding)
//   3. heuristic MCP   - per-timeframe percentage guess, used only as a last resort
function isHeuristicRiskBlock(value = {}) {
	return value.levelsSource === 'fallback-trade-plan';
}

function selectRiskMetadata(gemini, mcp) {
	const mcpComplete = hasCompleteRiskMetadata(mcp);
	const heuristicMcp = mcpComplete && isHeuristicRiskBlock(mcp);
	const source = [
		mcpComplete && !heuristicMcp ? mcp : null,
		hasCompleteRiskMetadata(gemini) ? gemini : null,
		heuristicMcp ? mcp : null,
	].find(Boolean) || null;
	const setupType = pickSetupType(gemini.setup_type, mcp.setup_type);
	const setupEvidence = setupType && (setupType === gemini.setup_type ? gemini.setup_evidence : mcp.setup_evidence);
	if (!source) {
		return {
			...(setupType ? { setup_type: setupType } : {}),
			...(setupEvidence ? { setup_evidence: setupEvidence } : {}),
		};
	}

	return {
		invalidation_level: source.invalidation_level,
		target_level: source.target_level,
		risk_reward_ratio: source.risk_reward_ratio,
		// Reports WHICH block actually supplied the risk levels, so a caller cannot
		// describe a rejected heuristic block as the origin of the emitted levels.
		riskLevelsSource: source === mcp ? (mcp.levelsSource || 'tradingview-mcp') : 'gemini-grounding',
		...(setupType ? { setup_type: setupType } : {}),
		...(setupEvidence ? { setup_evidence: setupEvidence } : {}),
	};
}

// GH-509 / CB-226: MCP levels win whenever MCP enrichment produced data (full or
// partial). Gemini-parsed levels are a fail-open fallback for the common outage case
// (status failed/undefined or enrichment never ran), and are provenance-tagged so
// downstream consumers can distinguish provider quality.
function hasAppliedMcpLevels(mcp = {}) {
	const status = mcp.tradingViewEnrichmentStatus;
	if (status === 'full' || status === 'partial') {
		return true;
	}

	return mcp.tradingViewEnrichmentApplied === true && status !== 'failed';
}

function buildMergedTechnicalLevels(gemini = {}, mcp = {}) {
	const mcpLevels = mcp.technical_levels || { supports: [], resistances: [] };
	const merged = buildTechnicalLevels({
		supports: mergeUnique([], mcpLevels.supports || []),
		resistances: mergeUnique([], mcpLevels.resistances || []),
	});

	if (merged) {
		return { levels: merged, levelsSource: undefined };
	}

	if (!hasAppliedMcpLevels(mcp)) {
		const geminiOnly = buildTechnicalLevels({
			supports: mergeUnique((gemini.technical_levels || {}).supports || [], []),
			resistances: mergeUnique((gemini.technical_levels || {}).resistances || [], []),
		});

		if (geminiOnly) {
			return { levels: geminiOnly, levelsSource: 'gemini-grounding' };
		}
	}

	return { levels: undefined, levelsSource: undefined };
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

		const { levels: technicalLevels, levelsSource: technicalLevelsSource } = buildMergedTechnicalLevels(gemini, mcp);

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
		let optionalRiskMetadata = selectRiskMetadata(gemini, mcp);

		const mcpCurrentPrice = typeof mcp.current_price === 'number' && Number.isFinite(mcp.current_price) && mcp.current_price > 0
			? mcp.current_price
			: (mcp.price_data && typeof mcp.price_data.current_price === 'number' && Number.isFinite(mcp.price_data.current_price) && mcp.price_data.current_price > 0
				? mcp.price_data.current_price
				: null);

		// GH-1229: `levelsSource` describes where the emitted risk levels actually came
		// from. When MCP supplied only a heuristic block and Gemini won the precedence
		// fight, tagging the result `fallback-trade-plan` would describe a block that was
		// rejected. Prefer the chosen risk block's own provenance, falling back to the
		// technical_levels tag only when no risk block was selected.
		let levelsSource = optionalRiskMetadata.riskLevelsSource
			|| technicalLevelsSource
			|| mcp.levelsSource
			|| undefined;

		if (!hasCompleteRiskMetadata(optionalRiskMetadata) && mcpCurrentPrice) {
			const parsed = parseTradingViewSignal(text);
			if (parsed && parsed.side) {
				const fallback = calculateFallbackRiskLevels(mcpCurrentPrice, parsed.timeframe, parsed.side);
				if (fallback) {
					optionalRiskMetadata = {
						invalidation_level: fallback.invalidation_level,
						target_level: fallback.target_level,
						risk_reward_ratio: fallback.risk_reward_ratio,
						setup_type: optionalRiskMetadata.setup_type || fallback.setup_type,
					};
					if (!levelsSource) {
						levelsSource = 'derived-quote';
					}
				}
			}
		}

		return {
			original_text: text,
			tradingViewEnrichmentApplied: mcp.tradingViewEnrichmentApplied === true,
			...(mcp.tradingViewEnrichmentStatus ? { tradingViewEnrichmentStatus: mcp.tradingViewEnrichmentStatus } : {}),
			sentiment,
			sentiment_score,
			...(typeof gemini.sentiment_score_raw === 'number' && Number.isFinite(gemini.sentiment_score_raw)
				? { sentiment_score_raw: gemini.sentiment_score_raw }
				: {}),
			...(sentimentConflict ? { sentimentConflict: true } : {}),
			current_price: mcpCurrentPrice ?? gemini.current_price ?? null,
			...(mcpCurrentPrice !== null
				? { priceSource: mcp.priceSource || (mcp.levelsSource === 'derived-quote' ? 'derived-quote' : 'tradingview-mcp'), ...(mcp.price_currency ? { price_currency: mcp.price_currency } : {}) }
				: (gemini.current_price ? { priceSource: 'gemini-grounding', ...(gemini.price_currency ? { price_currency: gemini.price_currency } : {}) } : {})),
			...(mcp.price_data ? { price_data: mcp.price_data } : {}),
			insights,
			...(technicalLevels ? { technical_levels: technicalLevels } : {}),
			...(levelsSource ? { levelsSource } : {}),
			sources: Array.isArray(gemini.sources) ? gemini.sources : [],
			truncated: !!(gemini.truncated || mcp.truncated),
			extraText,
			confluenceData: mcp.confluenceData || null,
			multiTimeframeData: mcp.multiTimeframeData || null,
			...(gemini.promptProvenance ? { promptProvenance: gemini.promptProvenance } : {}),
			...Object.fromEntries(
				Object.entries(optionalRiskMetadata)
					.filter(([key, value]) => key !== 'riskLevelsSource' && value !== undefined),
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
		sentiment_score_raw,
		insights,
		sources,
		truncated,
		modelUsed,
		promptProvenance,
		technical_levels,
		invalidation_level,
		target_level,
		setup_type,
		setup_evidence,
		risk_reward_ratio,
		current_price,
		price_currency,
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
		...(typeof sentiment_score_raw === 'number' && Number.isFinite(sentiment_score_raw)
			? { sentiment_score_raw }
			: {}),
		insights,
		sources,
		truncated,
		extraText,
		...(promptProvenance ? { promptProvenance } : {}),
		...(technical_levels ? { technical_levels } : {}),
		...(current_price ? { priceSource: 'gemini-grounding' } : {}),
		...Object.fromEntries(
			Object.entries({ invalidation_level, target_level, setup_type, setup_evidence, risk_reward_ratio, current_price, price_currency })
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
	const isBudgetExceeded = tokenCostBudgetService.isBudgetExceeded();
	if (isBudgetExceeded) {
		console.warn('[Alert] Daily token cost budget exceeded, disabling Gemini grounding for alert');
	}
	const isGeminiEnabled = getRuntimeConfig().ENABLE_GEMINI_GROUNDING && !isBudgetExceeded;
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
			const fallbackPlan = await deriveFallbackTradePlan(text).catch(() => null);
			if (fallbackPlan) {
				const sideSentiment = fallbackPlan.side === 'SELL' ? 'BEARISH' : 'BULLISH';
				const sideScore = fallbackPlan.side === 'SELL' ? -0.55 : 0.55;
				return {
					original_text: text,
					sentiment: sideSentiment,
					sentiment_score: sideScore,
					insights: [`Señal de ${fallbackPlan.side === 'SELL' ? 'VENTA' : 'COMPRA'} detectada para ${fallbackPlan.symbol}`],
					technical_levels: { supports: [], resistances: [] },
					current_price: fallbackPlan.current_price,
					price_data: fallbackPlan.price_data,
					invalidation_level: fallbackPlan.invalidation_level,
					target_level: fallbackPlan.target_level,
					risk_reward_ratio: fallbackPlan.risk_reward_ratio,
					setup_type: fallbackPlan.setup_type,
					levelsSource: 'derived-quote',
					sources: [],
					truncated: false,
					extraText: '*Model used*: `derived-quote`',
				};
			}
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
			let result = {
				...geminiEnrichedAlert,
				sentiment: guarded.sentiment,
				sentiment_score: guarded.sentiment_score,
				// GH-509 / CB-226: on the Gemini-only path (MCP absent or failed), any
				// Gemini-parsed levels are fallback data and carry provenance.
				...(geminiEnrichedAlert.technical_levels ? { levelsSource: 'gemini-grounding' } : {}),
			};

			if (!hasCompleteRiskMetadata(geminiEnrichedAlert)) {
				// A grounded block missing ONLY the optional ratio is completed arithmetically
				// so the grounded entry price and levels survive (GH-599). Only a block that
				// is genuinely unusable (no usable entry, or levels on the wrong side of it)
				// falls through to the derived-quote heuristic plan below.
				const grounded = completeGroundedRiskMetadata(geminiEnrichedAlert, parseTradingViewSignal(text));
				if (grounded.side) {
					// Only the ratio is new here: the levels came from the same object
					// `result` was spread from, so they are already in place.
					result = { ...result, risk_reward_ratio: grounded.risk_reward_ratio };
				} else {
					const fallbackPlan = await deriveFallbackTradePlan(text).catch(() => null);
					if (fallbackPlan) {
						result = {
							...result,
							current_price: fallbackPlan.current_price,
							priceSource: 'derived-quote',
							price_data: fallbackPlan.price_data,
							invalidation_level: fallbackPlan.invalidation_level,
							target_level: fallbackPlan.target_level,
							risk_reward_ratio: fallbackPlan.risk_reward_ratio,
							setup_type: result.setup_type || fallbackPlan.setup_type,
							levelsSource: 'derived-quote',
						};
						delete result.price_currency;
					}
				}
			}

			return result;
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

		const fallbackPlan = await deriveFallbackTradePlan(text).catch(() => null);
		if (fallbackPlan) {
			const sideSentiment = fallbackPlan.side === 'SELL' ? 'BEARISH' : 'BULLISH';
			const sideScore = fallbackPlan.side === 'SELL' ? -0.55 : 0.55;
			return {
				original_text: text,
				sentiment: sideSentiment,
				sentiment_score: sideScore,
				insights: [`Señal de ${fallbackPlan.side === 'SELL' ? 'VENTA' : 'COMPRA'} detectada para ${fallbackPlan.symbol}`],
				technical_levels: { supports: [], resistances: [] },
				current_price: fallbackPlan.current_price,
				price_data: fallbackPlan.price_data,
				invalidation_level: fallbackPlan.invalidation_level,
				target_level: fallbackPlan.target_level,
				risk_reward_ratio: fallbackPlan.risk_reward_ratio,
				setup_type: fallbackPlan.setup_type,
				levelsSource: 'derived-quote',
				sources: [],
				truncated: false,
				extraText: '*Model used*: `derived-quote`',
			};
		}

		throw new Error(`Alert enrichment failed: ${error.message}`);
	}
}

module.exports = {
	deriveSearchQuery,
	enrichAlert,
};
