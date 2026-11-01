'use strict';

const INDEPENDENT_LEVEL_SOURCES = new Set(['tradingview-mcp', 'fallback-trade-plan', 'derived-quote']);

function getCalibratedRiskMetadata(enrichmentData) {
	if (!enrichmentData || typeof enrichmentData !== 'object') return null;
	if (enrichmentData.promptProvenance?.schemaDriftDetected !== true) return enrichmentData;
	if (!INDEPENDENT_LEVEL_SOURCES.has(enrichmentData.levelsSource)) return null;
	// levelsSource identifies the level block, not the setup label. The latter may
	// still have come from the drifted prompt, so retain only independent levels.
	return {
		invalidation_level: enrichmentData.invalidation_level,
		invalidationLevel: enrichmentData.invalidationLevel,
		target_level: enrichmentData.target_level,
		targetLevel: enrichmentData.targetLevel,
		risk_reward_ratio: enrichmentData.risk_reward_ratio,
		riskRewardRatio: enrichmentData.riskRewardRatio,
	};
}

module.exports = { getCalibratedRiskMetadata };
