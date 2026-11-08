'use strict';

const { getChartRendererService } = require('./chartRenderer');

/**
 * Resolve the chart request an alert (or direct chart request) describes.
 *
 * Everything here is defensive: charts are strictly additive, so any missing or
 * malformed field simply yields `null` and the caller keeps the text-only path.
 */

const TIMEFRAME_BAR_COUNTS = Object.freeze({ default: 24 });

function pickSymbol(alert = {}) {
	const candidates = [
		alert.symbol,
		alert.chartSymbol,
		alert.enriched?.symbol,
		alert.signalMeta?.symbol,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate.trim().toUpperCase();
		}
	}
	return null;
}

function pickTimeframe(alert = {}) {
	const candidates = [alert.timeframe, alert.enriched?.timeframe, alert.signalMeta?.timeframe];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
	}
	return '1h';
}

/**
 * Decide which chart (if any) an alert should carry.
 *
 * @returns {{category: string, symbol: string, timeframe: string, bars: Array, entry?: number, target?: number, stop?: number, rangeKey: string}|null}
 */
function resolveChartRequest(alert = {}) {
	if (!alert || typeof alert !== 'object') return null;
	const bars = Array.isArray(alert.chartBars) ? alert.chartBars : null;
	const symbol = pickSymbol(alert);
	if (!bars || bars.length === 0 || !symbol) return null;

	const isSparkline = alert.chartCategory === 'sparkline' || (!alert.chartCategory && bars.length <= TIMEFRAME_BAR_COUNTS.default);
	const category = isSparkline ? 'sparkline' : 'candlestick';
	const timeframe = pickTimeframe(alert);

	// Round the price so successive renders inside a candle refresh share a key.
	const entry = alert.enriched?.invalidation_level;
	const target = alert.enriched?.target_level;
	const stop = alert.invalidation_level ?? alert.stopLoss ?? alert.stop_loss;
	const rangeKey = [
		category === 'candlestick' ? 'full' : 'spark',
		entry ?? '', target ?? '', stop ?? '', bars.length,
	].join(':');

	return {
		category,
		symbol,
		timeframe,
		bars,
		entry,
		target,
		stop,
		rangeKey,
	};
}

/**
 * Render the chart an alert asks for, or `null` when disabled/unavailable.
 * Never throws.
 */
async function renderAlertChart(alert = {}, options = {}) {
	try {
		const renderer = options.renderer || getChartRendererService();
		if (!renderer || typeof renderer.renderChart !== 'function' || !renderer.isEnabled()) return null;
		const request = options.request || resolveChartRequest(alert);
		if (!request) return null;
		return await renderer.renderChart(request);
	} catch (error) {
		console.warn('chart-attachments: unable to resolve chart request; using text-only delivery', {
			error: error?.message || 'unknown',
		});
		return null;
	}
}

module.exports = { resolveChartRequest, renderAlertChart, pickSymbol, pickTimeframe };
