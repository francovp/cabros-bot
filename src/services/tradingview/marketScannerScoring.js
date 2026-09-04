/**
 * marketScannerScoring.js
 * 
 * Pure scoring helpers for ranking market scanner items by actionable trade quality.
 * Scores are deterministic and normalized to 0-100 for cross-section comparison.
 *
 * Feature: Rank market scanner results by actionable trade quality (#140)
 */

/**
 * Score a single scanner item on a 0-100 scale.
 *
 * Scoring dimensions (each capped to a sub-score, then aggregated):
 *   - Trend strength (changePercent): 0-25 points
 *   - Momentum health (RSI): 0-25 points
 *   - Volume confirmation (volume_ratio): 0-20 points
 *   - Breakout confluence (breakout_type + volume): 0-20 points
 *   - Volatility regime (BBW): 0-10 points
 *   - Higher-timeframe trend confluence: configurable bonus or penalty
 *
 * Chase-entry penalty: If RSI is extreme (>75 gainers, <25 losers) and
 * volume ratio is below 1.5, a 15-point penalty is applied.
 *
 * @param {Object} item - Scanner item from MCP result
 * @param {string} scanType - Scan type (top_gainers, top_losers, etc.)
 * @param {Object} [options] - Optional scoring options
 * @param {number} [options.rsiOversold=30] - RSI oversold threshold
 * @param {number} [options.rsiOverbought=70] - RSI overbought threshold
 * @param {Object} [options.trendConfluence] - Optional higher-timeframe trend metadata
 * @param {number} [options.trendConfluenceAlignedBonus=10] - Bonus for aligned higher-timeframe trend
 * @param {number} [options.trendConfluenceCounterTrendPenalty=10] - Penalty for counter-trend setup
 * @returns {{ score: number, reason: string, trendConfluence?: Object }}
 */
function scoreScannerItem(item, scanType, options = {}) {
	const {
		rsiOversold = 30,
		rsiOverbought = 70,
		trendConfluenceAlignedBonus = 10,
		trendConfluenceCounterTrendPenalty = 10,
	} = options;

	const change = numberOrNull(item.changePercent);
	const rsi = numberOrNull(item.indicators?.RSI ?? null);
	const volRatio = numberOrNull(item.volume_ratio ?? null);
	const breakout = item.breakout_type;
	const bbw = numberOrNull(item.bbw ?? null);

	const isGainer = scanType === 'top_gainers';
	const isLoser = scanType === 'top_losers';

	// --- Trend strength (0-25) ---
	let trendScore = 0;
	if (change !== null && (isGainer || isLoser)) {
		const absChange = Math.abs(change);
		// Scale: 0% → 0, 10%+ → 25 (diminishing returns past 10%)
		trendScore = Math.min(25, (absChange / 10) * 25);
	} else if (!isGainer && !isLoser) {
		// For non-trend scans, give a modest base score
		trendScore = 10;
	}

	// --- Momentum health (0-25) ---
	let momentumScore = 0;
	if (rsi !== null) {
		if (isGainer) {
			// Ideal RSI for gainers: 50-70 (strong but not overheated)
			if (rsi >= rsiOverbought) {
				momentumScore = Math.max(0, 15 - (rsi - rsiOverbought) * 0.5);
			} else if (rsi >= 50) {
				momentumScore = 15 + ((rsi - 50) / (rsiOverbought - 50)) * 10;
			} else {
				momentumScore = Math.max(0, (rsi / 50) * 15);
			}
		} else if (isLoser) {
			// Ideal RSI for losers: 30-50 (weak but not oversold)
			if (rsi <= rsiOversold) {
				momentumScore = Math.max(0, 15 - (rsiOversold - rsi) * 0.5);
			} else if (rsi <= 50) {
				momentumScore = 15 + ((50 - rsi) / (50 - rsiOversold)) * 10;
			} else {
				momentumScore = Math.max(0, ((100 - rsi) / 50) * 15);
			}
		} else {
			// Neutral momentum for volume/BB scans: center-weighted
			momentumScore = Math.max(0, 25 - Math.abs(rsi - 50) * 0.5);
		}
	} else {
		momentumScore = 5; // No RSI → low confidence
	}

	// --- Volume confirmation (0-20) ---
	let volumeScore = 0;
	if (volRatio !== null) {
		if (volRatio >= 2) {
			volumeScore = 20;
		} else if (volRatio >= 1.5) {
			volumeScore = 15 + ((volRatio - 1.5) / 0.5) * 5;
		} else if (volRatio >= 1) {
			volumeScore = 5 + ((volRatio - 1) / 0.5) * 10;
		} else {
			volumeScore = Math.max(0, (volRatio / 1) * 5);
		}
	} else {
		volumeScore = 3; // No volume data → weak signal
	}

	// --- Breakout confluence (0-20) ---
	let breakoutScore = 0;
	if (typeof breakout === 'string' && breakout.trim()) {
		const normalizedBreakout = breakout.trim().toLowerCase();
		const hasVolume = volRatio !== null && volRatio >= 1.2;

		if (
			(normalizedBreakout === 'bullish' && isGainer)
			|| (normalizedBreakout === 'bearish' && isLoser)
		) {
			// Breakout aligns with trend direction
			breakoutScore = hasVolume ? 20 : 12;
		} else if (
			(normalizedBreakout === 'bullish' && isLoser)
			|| (normalizedBreakout === 'bearish' && isGainer)
		) {
			// Breakout contradicts trend direction → divergence (interesting!)
			breakoutScore = hasVolume ? 15 : 8;
		} else {
			// Neutral or unclassified breakout
			breakoutScore = hasVolume ? 10 : 5;
		}
	} else if (scanType === 'volume_breakout_scanner' || scanType === 'smart_volume_scanner') {
		breakoutScore = 5; // Expected breakout info missing
	}

	// --- Volatility regime (0-10) ---
	let volatilityScore = 0;
	if (bbw !== null) {
		// BBW < 0.1 = squeeze (potential breakout), 0.1-0.4 = normal, >0.4 = expanded
		if (bbw < 0.1 && (scanType === 'bollinger_scan')) {
			volatilityScore = 10; // Squeeze is interesting for Bollinger scans
		} else if (bbw >= 0.1 && bbw <= 0.4) {
			volatilityScore = 5;
		} else if (bbw > 0.4) {
			volatilityScore = 3; // Expanded bands → trend may be exhausting
		} else {
			volatilityScore = 2;
		}
	} else if (scanType === 'bollinger_scan') {
		volatilityScore = 2; // BBW expected but missing
	} else {
		volatilityScore = 5; // Neutral for non-BB scans
	}

	// --- Chase-entry penalty ---
	let chasePenalty = 0;
	if (rsi !== null && volRatio !== null) {
		if ((isGainer && rsi > 75 && volRatio < 1.5) || (isLoser && rsi < 25 && volRatio < 1.5)) {
			chasePenalty = 15;
		} else if ((isGainer && rsi > 80) || (isLoser && rsi < 20)) {
			chasePenalty = 10;
		}
	} else if (rsi !== null) {
		if ((isGainer && rsi > 80) || (isLoser && rsi < 20)) {
			chasePenalty = 8;
		}
	}

	const trendConfluence = resolveTrendConfluence(item, scanType, options);
	let trendConfluenceAdjustment = 0;
	if (trendConfluence?.status === 'aligned') {
		trendConfluenceAdjustment = normalizeAdjustment(trendConfluenceAlignedBonus, 10);
	} else if (trendConfluence?.status === 'counter-trend') {
		trendConfluenceAdjustment = -normalizeAdjustment(trendConfluenceCounterTrendPenalty, 10);
	}

	if (trendConfluence && trendConfluenceAdjustment !== 0) {
		trendConfluence.adjustment = trendConfluenceAdjustment;
	}

	// --- Composite score (0-100) ---
	const rawScore = trendScore + momentumScore + volumeScore + breakoutScore + volatilityScore + trendConfluenceAdjustment;
	const finalScore = Math.max(0, Math.min(100, rawScore - chasePenalty));

	// --- Reason text ---
	const parts = [];
	if (change !== null && (isGainer || isLoser)) {
		parts.push(`${change > 0 ? '+' : ''}${change.toFixed(1)}%`);
	}
	if (rsi !== null) {
		parts.push(`RSI ${rsi.toFixed(1)}`);
	}
	if (volRatio !== null) {
		parts.push(`Vol ${volRatio.toFixed(1)}x`);
	}
	if (chasePenalty > 0) {
		parts.push(`⚠️ chase penalty -${chasePenalty}`);
	}
	if (trendConfluenceAdjustment > 0) {
		parts.push(`HTF aligned +${formatAdjustment(trendConfluenceAdjustment)}`);
	} else if (trendConfluenceAdjustment < 0) {
		parts.push(`HTF counter-trend ${formatAdjustment(trendConfluenceAdjustment)}`);
	}

	const reason = parts.length > 0 ? parts.join(' · ') : 'insufficient data';

	const result = {
		score: Math.round(finalScore),
		reason,
	};
	if (trendConfluence) {
		result.trendConfluence = trendConfluence;
	}

	return result;
}

/**
 * Sort scanner items by score descending.
 *
 * @param {Array<Object>} items - Scanner items
 * @param {string} scanType - Scan type
 * @param {Object} [options] - Scoring options (passed to scoreScannerItem)
 * @returns {Array<Object>} Items with `_score` and `_scoreReason` attached, sorted
 */
function rankScannerItems(items, scanType, options = {}) {
	if (!Array.isArray(items)) {
		return [];
	}

	const scored = items.map((item) => {
		const { score, reason, trendConfluence } = scoreScannerItem(item, scanType, options);
		return {
			...item,
			_score: score,
			_scoreReason: reason,
			...(trendConfluence ? { _trendConfluence: trendConfluence } : {}),
		};
	});

	return scored.sort((a, b) => b._score - a._score);
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function resolveTrendConfluence(item = {}, scanType, options = {}) {
	const raw = options.trendConfluence
		|| item.trendConfluence
		|| item.multiTimeframeData
		|| item.multi_timeframe
		|| item.multiTimeframe;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}

	const explicitStatus = resolveExplicitStatusFromRaw(raw);
	const direction = resolveDirectionFromRaw(raw);
	const expectedDirection = getExpectedTrendDirection(item, scanType);

	const isDirectionlessScan = scanType === 'bollinger_scan' || scanType === 'volume_confirmation';

	let status = explicitStatus;
	if (direction && expectedDirection) {
		status = direction === expectedDirection ? 'aligned' : 'counter-trend';
	} else if (isDirectionlessScan && direction) {
		status = 'aligned';
	} else if (!status && typeof raw.aligned === 'boolean') {
		status = raw.aligned ? 'aligned' : 'counter-trend';
	} else if (!status && direction) {
		status = 'unknown';
	}
	if (!expectedDirection && !isDirectionlessScan && (status === 'aligned' || status === 'counter-trend')) {
		status = 'unknown';
	}
	if (!expectedDirection && isDirectionlessScan && !direction && (status === 'aligned' || status === 'counter-trend')) {
		status = 'unknown';
	}
	if (!status) {
		return null;
	}

	const confidence = normalizeConfidence(
		raw.confidence
		?? raw.alignment?.confidence
		?? raw.recommendation?.confidence,
	);

	return {
		status,
		direction: direction || null,
		confidence,
	};
}

function resolveExplicitStatusFromRaw(raw = {}) {
	const candidates = [
		raw.status,
		raw.alignment?.status,
		raw.recommendation?.action,
	];

	for (const candidate of candidates) {
		const normalized = normalizeConfluenceStatus(candidate);
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

function resolveDirectionFromRaw(raw = {}) {
	const candidates = [
		raw.direction,
		raw.trend,
		raw.bias,
		raw.alignment?.direction,
		raw.alignment?.trend,
		raw.alignment?.status,
		raw.status,
		raw.recommendation?.direction,
		raw.recommendation?.action,
		raw.alignment,
		raw.recommendation,
	];

	for (const candidate of candidates) {
		const normalized = normalizeTrendDirection(candidate);
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

function getExpectedTrendDirection(item = {}, scanType) {
	if (scanType === 'top_gainers') {
		return 'bullish';
	}
	if (scanType === 'top_losers') {
		return 'bearish';
	}

	const breakoutDirection = normalizeTrendDirection(item.breakout_type);
	if (breakoutDirection) {
		return breakoutDirection;
	}

	return normalizeTrendDirection(item.trading_recommendation);
}

function normalizeTrendDirection(value) {
	if (typeof value !== 'string') {
		return null;
	}

	const normalized = value.trim().toLowerCase();
	if (/(bull|buy|long|alcist|compra)/.test(normalized)) {
		return 'bullish';
	}
	if (/(bear|sell|short|bajist|venta)/.test(normalized)) {
		return 'bearish';
	}

	return null;
}

function normalizeConfluenceStatus(value) {
	if (typeof value !== 'string') {
		return null;
	}

	const normalized = value.trim().toLowerCase();
	if (/(counter.?trend|oppos|divergen|contra.?tend)/.test(normalized)) {
		return 'counter-trend';
	}
	if (/(not\s+aligned|misaligned|unaligned|not\s+confluent)/.test(normalized)) {
		return 'counter-trend';
	}
	if (/(^|\s)(aligned|confluence|confluent)(\s|$)/.test(normalized)) {
		return 'aligned';
	}
	if (/(mixed|neutral|hold|sideways|range|indecisive)/.test(normalized)) {
		return 'unknown';
	}

	return null;
}

function normalizeConfidence(value) {
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
		const textualLevels = [
			{ pattern: /very\s*high|high/, confidence: 85 },
			{ pattern: /medium|moderate|neutral/, confidence: 60 },
			{ pattern: /very\s*low|low/, confidence: 35 },
		];
		const level = textualLevels.find(({ pattern }) => pattern.test(normalized));
		if (level) {
			return level.confidence;
		}
	}

	const numeric = numberOrNull(value);
	if (numeric === null) {
		return null;
	}

	return Math.round(Math.min(100, Math.max(0, numeric <= 1 ? numeric * 100 : numeric)));
}

function normalizeAdjustment(value, fallback) {
	const numeric = numberOrNull(value);
	return numeric === null ? fallback : Math.max(0, numeric);
}

function formatAdjustment(value) {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

module.exports = {
	scoreScannerItem,
	rankScannerItems,
	resolveTrendConfluence,
	normalizeTrendDirection,
	normalizeConfluenceStatus,
};
