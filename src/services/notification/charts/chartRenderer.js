'use strict';

const { RasterCanvas, PALETTE } = require('./rasterCanvas');
const { encodePng } = require('./pngEncoder');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_SECONDS = 300;
const MAX_CACHE_ENTRIES = 200;
const MAX_BARS = 60;
const MIN_BARS = 2;
const CATEGORIES = Object.freeze(['sparkline', 'candlestick']);
const TIMEOUT_CATEGORY = 'timeout';
const ERROR_CATEGORY = 'render_error';

const SPARKLINE_SIZE = Object.freeze({ width: 220, height: 60 });
const CANDLESTICK_SIZE = Object.freeze({ width: 600, height: 400 });

/** Raised when the cooperative render budget is exhausted mid-draw. */
class ChartRenderTimeoutError extends Error {
	constructor(message = 'Chart render budget exceeded') {
		super(message);
		this.name = 'ChartRenderTimeoutError';
	}
}

/**
 * Parse the documented environment/Remote Config inputs for the chart renderer.
 * Invalid values fall back to the documented defaults instead of throwing, so a
 * typo in deployment config can never break alert delivery.
 */
function resolveConfig(env = process.env) {
	const parseBoundedInt = (raw, fallback, min, max) => {
		if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
		const parsed = Number(String(raw).trim());
		if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
		if (parsed < min || parsed > max) return fallback;
		return parsed;
	};
	return {
		enabled: env.ENABLE_CHART_ATTACHMENTS === 'true',
		renderTimeoutMs: parseBoundedInt(env.CHART_RENDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 60000),
		cacheTtlSeconds: parseBoundedInt(env.CHART_CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS, 0, 86400),
	};
}

/**
 * Normalize an OHLCV bar list into finite, renderable candles.
 * Non-finite or out-of-order-inconsistent bars are dropped rather than drawn,
 * so a malformed provider payload degrades to "fewer bars" instead of a broken
 * axis or a thrown render.
 */
function normalizeBars(bars) {
	if (!Array.isArray(bars)) return [];
	const normalized = [];
	for (const bar of bars) {
		if (!bar || typeof bar !== 'object') continue;
		const open = Number(bar.open);
		const high = Number(bar.high);
		const low = Number(bar.low);
		const close = Number(bar.close);
		const volume = Number(bar.volume);
		if (![open, high, low, close].every((value) => Number.isFinite(value))) continue;
		if (high < low) continue;
		if (high < Math.max(open, close) || low > Math.min(open, close)) continue;
		normalized.push({
			open,
			high,
			low,
			close,
			volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
		});
	}
	return normalized.slice(-MAX_BARS);
}

function buildCacheKey({ symbol, timeframe, category, rangeKey }) {
	return [category, String(symbol || '').toUpperCase(), String(timeframe || ''), String(rangeKey || '')].join('|');
}

function formatPriceLabel(value) {
	const absolute = Math.abs(value);
	if (!Number.isFinite(absolute)) return '-';
	if (absolute >= 1000) return value.toFixed(0);
	if (absolute >= 1) return value.toFixed(2);
	return value.toFixed(4);
}

function isFiniteNumber(value) {
	return typeof value === 'number' ? Number.isFinite(value) : value !== undefined && value !== null && Number.isFinite(Number(value));
}

function toFiniteNumber(value) {
	if (value === undefined || value === null || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Chart attachment renderer.
 *
 * Design constraints (all fail-open):
 *  - Rendering is pure/synchronous CPU work; a wall-clock budget is enforced with
 *    `setImmediate` yield points so a pathological payload cannot block the
 *    event loop past `renderTimeoutMs`.
 *  - Every failure resolves to `null` and is recorded as a counter, so callers
 *    always fall through to the existing text-only delivery path.
 */
class ChartRendererService {
	constructor(options = {}) {
		const env = options.env || process.env;
		this.config = { ...resolveConfig(env), ...(options.config || {}) };
		this.cache = new Map();
		this.stats = {
			renders: 0,
			cacheHits: 0,
			cacheMisses: 0,
			failures: 0,
			timeouts: 0,
			skippedDisabled: 0,
			lastErrorCategory: null,
			lastRenderedAt: null,
		};
	}

	isEnabled() {
		return this.config.enabled === true;
	}

	/**
	 * Resolve a chart PNG for the request, or `null` when the feature is off,
	 * data is unusable, or rendering fails.
	 *
	 * @returns {Promise<{buffer: Buffer, category: string, cacheHit: boolean}|null>}
	 */
	async renderChart(request = {}) {
		if (!this.isEnabled()) {
			this.stats.skippedDisabled += 1;
			return null;
		}
		const category = CATEGORIES.includes(request.category) ? request.category : 'sparkline';
		const bars = normalizeBars(request.bars);
		if (bars.length < MIN_BARS) {
			this.stats.failures += 1;
			this.stats.lastErrorCategory = 'insufficient_data';
			return null;
		}

		const key = buildCacheKey({
			symbol: request.symbol,
			timeframe: request.timeframe,
			category,
			rangeKey: request.rangeKey,
		});

		const cached = this._getFromCache(key);
		if (cached) {
			this.stats.cacheHits += 1;
			return { buffer: cached, category, cacheHit: true };
		}
		this.stats.cacheMisses += 1;

		const timeoutMs = this.config.renderTimeoutMs;
		// Rendering is CPU-bound, so a `setTimeout` alone cannot preempt it: the
		// event loop is blocked until `_drawChart` returns. The timer therefore
		// only covers the async gaps, and the drawing loops additionally poll this
		// cooperative deadline between bars so the budget is actually enforced.
		const deadlineAt = Date.now() + timeoutMs;
		const isOverBudget = () => Date.now() >= deadlineAt;
		let timeoutHandle;
		try {
			const buffer = await Promise.race([
				new Promise((resolve) => {
					// Yield once so the deadline is installed before rendering starts.
					setImmediate(() => {
						try {
							resolve(this._drawChart(bars, request, category, isOverBudget));
						} catch (error) {
							resolve({ error });
						}
					});
				}),
				new Promise((resolve) => {
					timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs);
					if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
				}),
			]);

			if (buffer && buffer.timeout) {
				this.stats.timeouts += 1;
				this.stats.failures += 1;
				this.stats.lastErrorCategory = TIMEOUT_CATEGORY;
				console.warn('chart-attachments: render timed out; falling back to text-only delivery', {
					symbol: request.symbol, category, timeoutMs,
				});
				return null;
			}
			if (!buffer || buffer.error) {
				const isTimeout = buffer?.error instanceof ChartRenderTimeoutError;
				this.stats.failures += 1;
				if (isTimeout) this.stats.timeouts += 1;
				this.stats.lastErrorCategory = isTimeout ? TIMEOUT_CATEGORY : ERROR_CATEGORY;
				console.warn('chart-attachments: render failed; falling back to text-only delivery', {
					symbol: request.symbol,
					category,
					errorCategory: isTimeout ? TIMEOUT_CATEGORY : ERROR_CATEGORY,
					error: buffer?.error?.message || 'unknown',
				});
				return null;
			}
			if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
				this.stats.failures += 1;
				this.stats.lastErrorCategory = ERROR_CATEGORY;
				return null;
			}

			this.stats.renders += 1;
			this.stats.lastRenderedAt = new Date().toISOString();
			this._setInCache(key, buffer);
			return { buffer, category, cacheHit: false };
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
	}

	_drawChart(bars, request, category, isOverBudget) {
		if (category === 'candlestick') {
			return this._drawCandlestick(bars, request, isOverBudget);
		}
		return this._drawSparkline(bars, request, isOverBudget);
	}

	/**
	 * Abort the draw when the cooperative budget is exhausted. Bars already
	 * drawn are discarded by returning `null`, so the caller falls back to
	 * text-only delivery rather than emitting a truncated chart.
	 */
	_abortIfOverBudget(isOverBudget) {
		if (typeof isOverBudget === 'function' && isOverBudget()) {
			throw new ChartRenderTimeoutError('chart render budget exceeded');
		}
	}

	_drawSparkline(bars, request, isOverBudget) {
		this._abortIfOverBudget(isOverBudget);
		const { width, height } = SPARKLINE_SIZE;
		const canvas = new RasterCanvas(width, height, PALETTE.background);
		const padding = 4;
		const plotWidth = width - padding * 2;
		const plotHeight = height - padding * 2;
		const closes = bars.map((bar) => bar.close);
		const min = Math.min(...closes);
		const max = Math.max(...closes);
		const span = max - min;
		const first = bars[0].close;
		const last = bars[bars.length - 1].close;
		const rising = last >= first;
		const lineColor = rising ? PALETTE.up : PALETTE.down;

		// A flat series would divide by zero; draw a centred baseline instead.
		const toY = (value) => {
			if (span === 0) return padding + plotHeight / 2;
			return padding + plotHeight - ((value - min) / span) * plotHeight;
		};
		const toX = (index) => padding + (bars.length === 1 ? plotWidth / 2 : (index / (bars.length - 1)) * plotWidth);

		const points = closes.map((value, index) => [toX(index), toY(value)]);
		if (points.length > 1) canvas.polyline(points, lineColor, 2);

		// Mark the latest close so the sparkline reads as "where it is now".
		const lastPoint = points[points.length - 1];
		canvas.fillRect(lastPoint[0] - 2, lastPoint[1] - 2, 4, 4, lineColor);

		if (request.symbol) {
			canvas.text(String(request.symbol), padding, 2, PALETTE.text, 1);
		}
		canvas.strokeRect(0, 0, width, height, PALETTE.border, 1);
		return encodePng(canvas.pixels, width, height);
	}

	_drawCandlestick(bars, request, isOverBudget) {
		this._abortIfOverBudget(isOverBudget);
		const { width, height } = CANDLESTICK_SIZE;
		const canvas = new RasterCanvas(width, height, PALETTE.background);

		const marginLeft = 8;
		const marginRight = 64; // room for the price axis
		const marginTop = 24; // room for the header
		const volumeHeight = Math.round(height * 0.18);
		const marginBottom = 20;
		const plotWidth = width - marginLeft - marginRight;
		const priceHeight = height - marginTop - marginBottom - volumeHeight;
		if (plotWidth <= 0 || priceHeight <= 0) {
			throw new Error('candlestick chart area collapsed to zero size');
		}

		const highs = bars.map((bar) => bar.high);
		const lows = bars.map((bar) => bar.low);
		const levels = {
			entry: toFiniteNumber(request.entry),
			target: toFiniteNumber(request.target),
			stop: toFiniteNumber(request.stop),
		};
		const annotated = Object.values(levels).filter(isFiniteNumber);
		let priceMin = Math.min(...lows, ...annotated);
		let priceMax = Math.max(...highs, ...annotated);
		// Inflate a flat range so a single price still renders a readable axis.
		if (priceMax - priceMin < 1e-9) {
			priceMin -= Math.max(Math.abs(priceMin) * 0.01, 0.5);
			priceMax += Math.max(Math.abs(priceMax) * 0.01, 0.5);
		}
		const span = priceMax - priceMin;
		const toY = (price) => marginTop + priceHeight - ((price - priceMin) / span) * priceHeight;
		const slotWidth = plotWidth / bars.length;
		const bodyWidth = Math.max(1, Math.floor(slotWidth * 0.6));
		const volumeMax = Math.max(...bars.map((bar) => bar.volume), Number.EPSILON);

		// Horizontal grid + right-hand price axis (4 lines).
		for (let i = 0; i <= 4; i += 1) {
			const ratio = i / 4;
			const y = Math.round(marginTop + priceHeight - ratio * priceHeight);
			canvas.fillRect(marginLeft, y, plotWidth, 1, PALETTE.gridLine);
			const price = priceMin + ratio * span;
			canvas.text(formatPriceLabel(price), marginLeft + plotWidth + 4, y - 3, PALETTE.neutral, 1);
		}

		// Volume strip along the bottom of the price area.
		const volumeTop = marginTop + priceHeight;
		bars.forEach((bar, index) => {
			// Poll the cooperative budget so a large series cannot run unbounded.
			if (index % 8 === 0) this._abortIfOverBudget(isOverBudget);
			const barHeight = Math.max(1, Math.round((bar.volume / volumeMax) * (volumeHeight - 2)));
			const x = Math.round(marginLeft + index * slotWidth + (slotWidth - bodyWidth) / 2);
			canvas.fillRect(x, volumeTop + volumeHeight - barHeight, bodyWidth, barHeight,
				bar.close >= bar.open ? PALETTE.volumeUp : PALETTE.volumeDown);
		});

		// Candles: wick then body.
		bars.forEach((bar, index) => {
			if (index % 8 === 0) this._abortIfOverBudget(isOverBudget);
			const x = Math.round(marginLeft + index * slotWidth + (slotWidth - bodyWidth) / 2);
			const centerX = x + Math.floor(bodyWidth / 2);
			const color = bar.close >= bar.open ? PALETTE.up : PALETTE.down;
			canvas.line(centerX, toY(bar.high), centerX, toY(bar.low), color, 1);
			const top = toY(Math.max(bar.open, bar.close));
			const bottom = toY(Math.min(bar.open, bar.close));
			// A doji would otherwise have zero height and vanish.
			canvas.fillRect(x, Math.round(top), bodyWidth, Math.max(1, Math.round(bottom - top)), color);
		});

		// Risk overlays: entry (solid), target and stop (dashed) with right-edge labels.
		this._drawLevel(canvas, levels.entry, toY, marginLeft, plotWidth, PALETTE.entry, 'E', false);
		this._drawLevel(canvas, levels.target, toY, marginLeft, plotWidth, PALETTE.target, 'T', true);
		this._drawLevel(canvas, levels.stop, toY, marginLeft, plotWidth, PALETTE.stop, 'S', true);

		const headerParts = [
			request.symbol,
			request.timeframe ? `TF ${request.timeframe}` : null,
			`${bars.length} BARS`,
		].filter(Boolean);
		canvas.text(headerParts.join('  '), marginLeft, 6, PALETTE.text, 1);
		canvas.strokeRect(0, 0, width, height, PALETTE.border, 1);
		return encodePng(canvas.pixels, width, height);
	}

	_drawLevel(canvas, price, toY, marginLeft, plotWidth, color, label, dashed) {
		if (!isFiniteNumber(price)) return;
		const y = toY(price);
		if (!Number.isFinite(y)) return;
		if (dashed) {
			canvas.dashedLine(marginLeft, y, marginLeft + plotWidth, y, color, 1, 5);
		} else {
			canvas.fillRect(marginLeft, y, plotWidth, 1, color);
		}
		canvas.text(label, marginLeft + 2, y - 8, color, 1);
	}

	_getFromCache(key) {
		if (!(this.config.cacheTtlSeconds > 0)) return null;
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}
		// Refresh LRU recency.
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.buffer;
	}

	_setInCache(key, buffer) {
		if (!(this.config.cacheTtlSeconds > 0)) return;
		if (this.cache.size >= MAX_CACHE_ENTRIES) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) this.cache.delete(oldestKey);
		}
		this.cache.set(key, { buffer, expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000 });
	}

	/**
	 * Non-sensitive status block for `/api/status` and `/api/capabilities`.
	 */
	getStatus() {
		return {
			enabled: this.isEnabled(),
			ready: this.isEnabled() && this.stats.lastErrorCategory !== ERROR_CATEGORY,
			provider: 'builtin-raster',
			timeoutMs: this.config.renderTimeoutMs,
			cacheTtlSeconds: this.config.cacheTtlSeconds,
			cacheEntries: this.cache.size,
			renders: this.stats.renders,
			cacheHits: this.stats.cacheHits,
			cacheMisses: this.stats.cacheMisses,
			failures: this.stats.failures,
			timeouts: this.stats.timeouts,
			skippedDisabled: this.stats.skippedDisabled,
			lastErrorCategory: this.stats.lastErrorCategory,
			lastRenderedAt: this.stats.lastRenderedAt,
		};
	}

	clearCache() {
		this.cache.clear();
	}

	reset() {
		this.cache.clear();
		this.stats = {
			renders: 0, cacheHits: 0, cacheMisses: 0, failures: 0,
			timeouts: 0, skippedDisabled: 0, lastErrorCategory: null, lastRenderedAt: null,
		};
	}
}

let singleton = null;

/** Lazily-created process-wide renderer. */
function getChartRendererService() {
	if (!singleton) singleton = new ChartRendererService();
	return singleton;
}

function resetChartRendererService() {
	singleton = null;
}

module.exports = {
	ChartRendererService,
	ChartRenderTimeoutError,
	getChartRendererService,
	resetChartRendererService,
	CATEGORIES,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_CACHE_TTL_SECONDS,
};
