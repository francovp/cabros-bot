'use strict';

const { getRuntimeConfig } = require('../../remoteConfig/RemoteConfigService');
const { parseTradingViewSignal } = require('../../tradingview/parseTradingViewSignal');
const {
	normalizeTrendDirection,
	normalizeConfluenceStatus,
} = require('../../tradingview/marketScannerScoring');

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/**
 * Resolves the side (BUY / SELL) of an enriched alert object using explicit fields,
 * parsed signal patterns, setup type, or sentiment fallbacks.
 * @param {Object} enriched
 * @returns {'BUY'|'SELL'|null}
 */
function resolveSide(enriched = {}) {
	if (typeof enriched.side === 'string') {
		const s = enriched.side.trim().toUpperCase();
		if (s === 'BUY' || s === 'SELL') {
			return s;
		}
	}

	if (typeof enriched.original_text === 'string' && enriched.original_text) {
		const parsed = parseTradingViewSignal(enriched.original_text);
		if (parsed && (parsed.side === 'BUY' || parsed.side === 'SELL')) {
			return parsed.side;
		}
	}

	if (typeof enriched.setup_type === 'string') {
		const norm = normalizeTrendDirection(enriched.setup_type);
		if (norm === 'bullish') return 'BUY';
		if (norm === 'bearish') return 'SELL';
	}

	if (typeof enriched.sentiment === 'string') {
		const norm = normalizeTrendDirection(enriched.sentiment);
		if (norm === 'bullish') return 'BUY';
		if (norm === 'bearish') return 'SELL';
	}

	return null;
}

/**
 * Resolves a directional/recommendation token from a value that may be a plain
 * string or an object exposing `action`, `direction`, or `trend`.
 *
 * TradingView MCP payloads arrive in both shapes: `{ recommendation: "BUY" }`
 * and `{ recommendation: { action: "BUY" } }`. Both must normalize identically,
 * otherwise a valid object payload silently drops the whole HTF line.
 *
 * @param {*} value
 * @returns {string|null}
 */
function resolveDirectionalToken(value) {
	if (typeof value === 'string') {
		return value.trim() || null;
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const key of ['action', 'direction', 'trend', 'status', 'recommendation']) {
			const candidate = value[key];
			if (typeof candidate === 'string' && candidate.trim()) {
				return candidate.trim();
			}
		}
	}
	return null;
}

/**
 * Applies one precedence rule for contradictory confluence fields (GH-717).
 *
 * `net_score` is the strongest signal and always wins when present. Otherwise an
 * explicit HTF direction is authoritative: a `status` that contradicts it is a
 * provider serialization artifact, so side-aware classification is driven by the
 * direction. When no explicit direction exists, the normalized `status` verdict
 * stands, and finally the direction alone is classified against the alert side.
 *
 * @param {'bullish'|'bearish'|null} direction Normalized higher-timeframe direction.
 * @param {'BUY'|'SELL'|null} side Resolved alert side.
 * @returns {'aligned'|'counter-trend'|'mixed'}
 */
function classifyByDirection(direction, side) {
	if (side === 'BUY') {
		if (direction === 'bullish') return 'aligned';
		if (direction === 'bearish') return 'counter-trend';
	} else if (side === 'SELL') {
		if (direction === 'bearish') return 'aligned';
		if (direction === 'bullish') return 'counter-trend';
	}
	return 'mixed';
}

/**
 * Resolves higher-timeframe alignment metadata and generates a formatted status string.
 * @param {Object} enriched
 * @returns {{ classification: 'aligned'|'counter-trend'|'mixed', label: string, netScore: number|null, divergentTimeframes: string[], text: string }|null}
 */
function resolveHtfAlignment(enriched = {}) {
	const rawMt = enriched.multiTimeframeData || enriched.trendConfluence || null;
	if (!rawMt) {
		return null;
	}

	let multiTimeframe = rawMt;
	let stringFallback = null;

	if (typeof rawMt === 'string' && rawMt.trim()) {
		stringFallback = rawMt.trim();
		multiTimeframe = {};
	} else if (typeof rawMt !== 'object' || Array.isArray(rawMt)) {
		return null;
	}

	const alignment = (multiTimeframe.alignment && typeof multiTimeframe.alignment === 'object' && !Array.isArray(multiTimeframe.alignment))
		? multiTimeframe.alignment
		: multiTimeframe;

	const stringAlignment = typeof multiTimeframe.alignment === 'string' && multiTimeframe.alignment.trim()
		? multiTimeframe.alignment.trim()
		: null;
	const stringRecommendation = resolveDirectionalToken(multiTimeframe.recommendation)
		?? resolveDirectionalToken(alignment.recommendation);
	const stringTrend = resolveDirectionalToken(multiTimeframe.trend)
		?? resolveDirectionalToken(alignment.trend);

	const netScore = numberOrNull(alignment.net_score ?? multiTimeframe.net_score);
	const rawStatus = typeof alignment.status === 'string' && alignment.status.trim()
		? alignment.status.trim()
		: (typeof multiTimeframe.status === 'string' && multiTimeframe.status.trim()
			? multiTimeframe.status.trim()
			: (stringAlignment || stringRecommendation || stringFallback));
	const rawDirection = typeof alignment.direction === 'string' && alignment.direction.trim()
		? alignment.direction.trim()
		: (typeof alignment.trend === 'string' && alignment.trend.trim()
			? alignment.trend.trim()
			: (typeof multiTimeframe.direction === 'string' && multiTimeframe.direction.trim()
				? multiTimeframe.direction.trim()
				: (stringTrend || stringAlignment || stringFallback)));

	let divergentTimeframes = [];
	const rawDivergent = alignment.divergent_timeframes ?? multiTimeframe.divergent_timeframes;
	if (Array.isArray(rawDivergent)) {
		divergentTimeframes = rawDivergent.map(tf => String(tf).trim()).filter(Boolean);
	} else if (typeof rawDivergent === 'string' && rawDivergent.trim()) {
		divergentTimeframes = rawDivergent.split(',').map(tf => tf.trim()).filter(Boolean);
	}

	// Fail open if no meaningful confluence fields are found
	if (netScore === null && !rawStatus && !rawDirection) {
		return null;
	}

	const side = resolveSide(enriched);

	let classification = 'mixed';

	if (netScore !== null) {
		if (side === 'BUY') {
			if (netScore > 0) classification = 'aligned';
			else if (netScore < 0) classification = 'counter-trend';
			else classification = 'mixed';
		} else if (side === 'SELL') {
			if (netScore < 0) classification = 'aligned';
			else if (netScore > 0) classification = 'counter-trend';
			else classification = 'mixed';
		} else {
			if (netScore > 0) classification = 'aligned';
			else if (netScore < 0) classification = 'counter-trend';
			else classification = 'mixed';
		}
	} else {
		const normalizedStatus = normalizeConfluenceStatus(rawStatus);
		// An explicit direction field is authoritative *when the side is known*, so
		// side-aware classification can actually be compared against it. `rawDirection`
		// falls back to `rawStatus`, so only a *dedicated* direction/trend/
		// recommendation token may override a status verdict (GH-717). With an
		// unknown side there is nothing to compare, so the status verdict stands.
		const explicitDirection = normalizeTrendDirection(
			rawDirection && rawDirection !== rawStatus ? rawDirection : null,
		);

		if (explicitDirection && side) {
			classification = classifyByDirection(explicitDirection, side);
		} else if (normalizedStatus === 'aligned') {
			classification = 'aligned';
		} else if (normalizedStatus === 'counter-trend') {
			classification = 'counter-trend';
		} else {
			// No usable status verdict: fall back to whichever directional token exists.
			classification = classifyByDirection(
				normalizeTrendDirection(rawDirection || rawStatus),
				side,
			);
		}
	}

	let emoji = '⚖️';
	let label = 'MIXTO';
	if (classification === 'aligned') {
		emoji = '📈';
		label = 'ALINEADO';
	} else if (classification === 'counter-trend') {
		emoji = '📉';
		label = 'EN CONTRA';
	}

	let text = `${emoji} HTF: ${label}`;
	if (netScore !== null) {
		const sign = netScore > 0 ? '+' : '';
		const formattedNet = Number.isInteger(netScore) ? String(netScore) : netScore.toFixed(1);
		text += ` (net ${sign}${formattedNet})`;
	}
	if (divergentTimeframes.length > 0) {
		text += ` · Divergentes: ${divergentTimeframes.join(', ')}`;
	}

	return {
		classification,
		label,
		netScore,
		divergentTimeframes,
		text,
	};
}

/**
 * Formats the higher-timeframe alignment line for alert notifications.
 * Respects the ENABLE_ALERT_HTF_RENDER runtime config and fails open to null if absent.
 * @param {Object} enriched
 * @param {Object} [options]
 * @returns {string|null}
 */
function formatHtfAlignment(enriched = {}, options = {}) {
	try {
		const config = getRuntimeConfig();
		if (config.ENABLE_ALERT_HTF_RENDER === false) {
			return null;
		}

		const resolved = resolveHtfAlignment(enriched);
		return resolved ? resolved.text : null;
	} catch (error) {
		console.warn('[HtfAlignmentFormatter] Failed to format HTF alignment:', error?.message || error);
		return null;
	}
}

module.exports = {
	formatHtfAlignment,
	resolveHtfAlignment,
	resolveSide,
	resolveDirectionalToken,
	classifyByDirection,
};
