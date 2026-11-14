/**
 * Render-or-skip predicate for Gemini grounding output (CB-583 / Issue #583).
 *
 * When MCP enrichment is failing and TradingView levels are missing, the
 * Gemini grounding call can still produce a response — but only one line of
 * bare sentiment/score text that no formatter renders into the delivered
 * message. Each call costs ~1.1k tokens for zero user value.
 *
 * The predicate `isEnrichmentRenderable()` lets `enrichAlert` skip the
 * Gemini call entirely (returning `null`) when the prospective output
 * would be invisible. Renderable output requires at least one of:
 *
 *   - a non-empty `insights` array (the formatters render insights)
 *   - at least one sourced entry with title and URL (sources section)
 *   - non-empty `technical_levels.supports` or `.resistances` (the
 *     support/resistance section, which also covers Gemini-parsed
 *     fallback levels per CB-226)
 *   - risk metadata that the formatters emit (invalidation/target/RR)
 *
 * Pure sentiment/score without insights, sources, or levels is not
 * renderable: the formatters only emit the `Sentiment: BULLISH (0.55)`
 * line when one of the richer sections is present, so token spend on a
 * sentiment-only call is wasted.
 */

const NON_EMPTY_STRING = (value) => typeof value === 'string' && value.trim().length > 0;

function hasRenderableInsights(enriched = {}) {
	const insights = enriched.insights;
	return Array.isArray(insights) && insights.some((item) => NON_EMPTY_STRING(item));
}

function hasRenderableSources(enriched = {}) {
	const sources = enriched.sources;
	if (!Array.isArray(sources) || sources.length === 0) {
		return false;
	}
	return sources.some((source) => {
		if (!source || typeof source !== 'object') {
			return false;
		}
		const title = NON_EMPTY_STRING(source.title) || NON_EMPTY_STRING(source.snippet);
		const url = NON_EMPTY_STRING(source.url);
		return Boolean(title && url);
	});
}

function hasRenderableTechnicalLevels(enriched = {}) {
	const levels = enriched.technical_levels;
	if (!levels || typeof levels !== 'object') {
		return false;
	}
	const supports = Array.isArray(levels.supports) ? levels.supports : [];
	const resistances = Array.isArray(levels.resistances) ? levels.resistances : [];
	return supports.some(NON_EMPTY_STRING) || resistances.some(NON_EMPTY_STRING);
}

function hasRenderableRiskMetadata(enriched = {}) {
	return NON_EMPTY_STRING(enriched.invalidation_level)
		|| NON_EMPTY_STRING(enriched.target_level)
		|| (typeof enriched.risk_reward_ratio === 'number' && Number.isFinite(enriched.risk_reward_ratio))
		|| (typeof enriched.risk_reward_ratio === 'string' && enriched.risk_reward_ratio.trim().length > 0);
}

/**
 * Returns true when the enriched payload would produce visible output in
 * the Telegram/WhatsApp formatters. Pure sentiment/score without any of
 * the rendered sections is treated as invisible so the grounding call can
 * be skipped upstream.
 *
 * The function is intentionally synchronous and pure: it does not touch
 * network, env, or formatter state, so tests and runtime callers can
 * safely share a single instance.
 *
 * @param {Object} enriched candidate enriched payload (Gemini output or merged)
 * @returns {boolean}
 */
function isEnrichmentRenderable(enriched = {}) {
	if (!enriched || typeof enriched !== 'object') {
		return false;
	}

	return hasRenderableInsights(enriched)
		|| hasRenderableSources(enriched)
		|| hasRenderableTechnicalLevels(enriched)
		|| hasRenderableRiskMetadata(enriched);
}

module.exports = {
	isEnrichmentRenderable,
	hasRenderableInsights,
	hasRenderableSources,
	hasRenderableTechnicalLevels,
	hasRenderableRiskMetadata,
};
