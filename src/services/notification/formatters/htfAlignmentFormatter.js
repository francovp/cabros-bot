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
 * Resolves higher-timeframe alignment metadata and generates a formatted status string.
 * @param {Object} enriched
 * @returns {{ classification: 'aligned'|'counter-trend'|'mixed', label: string, netScore: number|null, divergentTimeframes: string[], text: string }|null}
 */
function resolveHtfAlignment(enriched = {}) {
	const multiTimeframe = enriched.multiTimeframeData || enriched.trendConfluence || null;
	if (!multiTimeframe || typeof multiTimeframe !== 'object' || Array.isArray(multiTimeframe)) {
		return null;
	}

	const alignment = (multiTimeframe.alignment && typeof multiTimeframe.alignment === 'object' && !Array.isArray(multiTimeframe.alignment))
		? multiTimeframe.alignment
		: multiTimeframe;

	const netScore = numberOrNull(alignment.net_score ?? multiTimeframe.net_score);
	const rawStatus = typeof alignment.status === 'string'
		? alignment.status
		: (typeof multiTimeframe.status === 'string' ? multiTimeframe.status : null);
	const rawDirection = typeof alignment.direction === 'string'
		? alignment.direction
		: (typeof alignment.trend === 'string'
			? alignment.trend
			: (typeof multiTimeframe.direction === 'string' ? multiTimeframe.direction : null));

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
		const normalizedDirection = normalizeTrendDirection(rawDirection || rawStatus);

		if (normalizedStatus === 'aligned') {
			classification = 'aligned';
		} else if (normalizedStatus === 'counter-trend') {
			classification = 'counter-trend';
		} else if (normalizedStatus === 'unknown') {
			classification = 'mixed';
		} else if (side === 'BUY') {
			if (normalizedDirection === 'bullish') {
				classification = 'aligned';
			} else if (normalizedDirection === 'bearish') {
				classification = 'counter-trend';
			}
		} else if (side === 'SELL') {
			if (normalizedDirection === 'bearish') {
				classification = 'aligned';
			} else if (normalizedDirection === 'bullish') {
				classification = 'counter-trend';
			}
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
};
