/**
 * chartRenderer - opt-in, fail-open chart attachment service.
 *
 * Renders small charts (sparklines, candlesticks) to PNG buffers for Telegram
 * sendPhoto delivery. The renderer is process-local and dependency-free; the
 * only external call is zlib via Node's built-in module. The service is
 * gated by ENABLE_CHART_ATTACHMENTS and degrades to a null buffer on any
 * input or render error so callers can fall back to text-only delivery
 * without surfacing the failure to operators or traders.
 *
 * Cache: in-process Map keyed by `${type}:${symbol}:${timeframe}:${rangeKey}`
 * with bounded TTL. Cache hit/miss/error counters are exposed via getStatus().
 *
 * Telemetry: getStatus() reports a redacted, non-sensitive snapshot for
 * /api/status. No chart content, user data, or alert text is logged or
 * persisted; only the cache key dimensions and counts.
 */

'use strict';

const { encodeRgba, encodeGrayscale } = require('./pngEncoder');

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 60;
const DEFAULT_PADDING = 4;
const DEFAULT_LINE_COLOR = { r: 56, g: 161, b: 105, a: 255 }; // emerald-500
const DEFAULT_BG_COLOR = { r: 17, g: 24, b: 39, a: 255 }; // slate-900
const DEFAULT_AXIS_COLOR = { r: 75, g: 85, b: 99, a: 255 }; // slate-600

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 256;

function clampInt(value, min, max, fallback) {
	if (!Number.isInteger(value)) {
		return fallback;
	}
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return value;
}

function isFiniteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

function resolveDimension(configValue, envValue, fallback) {
	const parsed = configValue !== undefined
		? configValue
		: (envValue !== undefined && envValue !== '' ? Number(envValue) : NaN);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}
	return clampInt(parsed, 16, 1024, fallback);
}

function resolveBoundedInt(value, min, max, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		return fallback;
	}
	return parsed;
}

class ChartRenderer {
	constructor(config = {}) {
		const env = process.env || {};
		this.timeoutMs = resolveBoundedInt(
			config.timeoutMs !== undefined ? config.timeoutMs : env.CHART_RENDER_TIMEOUT_MS,
			100,
			60000,
			DEFAULT_TIMEOUT_MS,
		);
		this.cacheTtlMs = resolveBoundedInt(
			config.cacheTtlMs !== undefined ? config.cacheTtlMs : env.CHART_CACHE_TTL_MS,
			1000,
			60 * 60 * 1000,
			DEFAULT_CACHE_TTL_MS,
		);
		this.cacheMaxEntries = resolveBoundedInt(
			config.cacheMaxEntries !== undefined ? config.cacheMaxEntries : env.CHART_CACHE_MAX_ENTRIES,
			1,
			10000,
			DEFAULT_CACHE_MAX_ENTRIES,
		);
		this.defaultWidth = resolveDimension(
			config.defaultWidth,
			env.CHART_DEFAULT_WIDTH,
			DEFAULT_WIDTH,
		);
		this.defaultHeight = resolveDimension(
			config.defaultHeight,
			env.CHART_DEFAULT_HEIGHT,
			DEFAULT_HEIGHT,
		);
		this.cache = new Map();
		this.counters = {
			renderCount: 0,
			cacheHitCount: 0,
			cacheMissCount: 0,
			successCount: 0,
			failureCount: 0,
			lastFailureCategory: null,
			lastRenderedAt: null,
		};
	}

	/**
	 * Whether the renderer is enabled. Always reports the current env value so
	 * /api/status reflects hot reloads without a process restart.
	 */
	isEnabled() {
		return process.env.ENABLE_CHART_ATTACHMENTS === 'true';
	}

	/**
	 * Render a sparkline PNG buffer for the given series.
	 *
	 * @param {Object} options
	 * @param {number[]} options.values Numeric series; must be non-empty and finite
	 * @param {string} options.symbol Used in cache key only
	 * @param {string} options.timeframe Used in cache key only (e.g. '1h')
	 * @param {string} options.rangeKey Used in cache key only (e.g. 'last-24h')
	 * @param {number} [options.width]
	 * @param {number} [options.height]
	 * @returns {Promise<Buffer|null>} PNG buffer or null on failure
	 */
	async renderSparkline({ values, symbol = '', timeframe = '', rangeKey = '', width, height } = {}) {
		if (!this.isEnabled()) {
			return null;
		}
		if (!Array.isArray(values) || values.length < 2) {
			this._recordFailure('INVALID_INPUT');
			return null;
		}
		const finiteValues = values.every(isFiniteNumber);
		if (!finiteValues) {
			this._recordFailure('INVALID_INPUT');
			return null;
		}
		const renderWidth = resolveDimension(width, undefined, this.defaultWidth);
		const renderHeight = resolveDimension(height, undefined, this.defaultHeight);

		const cacheKey = buildCacheKey({
			type: 'sparkline',
			symbol,
			timeframe,
			rangeKey,
			width: renderWidth,
			height: renderHeight,
			values,
		});

		const cached = this._getFromCache(cacheKey);
		if (cached) {
			return cached;
		}

		this.counters.renderCount += 1;
		this.counters.cacheMissCount += 1;

		const buffer = await withTimeout(
			Promise.resolve(renderSparklinePixels({
				values,
				width: renderWidth,
				height: renderHeight,
			})),
			this.timeoutMs,
			() => this._recordFailure('TIMEOUT'),
		);
		if (!buffer) {
			return null;
		}
		this._setInCache(cacheKey, buffer);
		this.counters.successCount += 1;
		this.counters.lastRenderedAt = new Date().toISOString();
		return buffer;
	}

	_recordFailure(category) {
		this.counters.failureCount += 1;
		this.counters.lastFailureCategory = category;
	}

	_getFromCache(key) {
		const entry = this.cache.get(key);
		if (!entry) {
			return null;
		}
		if (entry.expiresAt <= Date.now()) {
			this.cache.delete(key);
			return null;
		}
		this.counters.cacheHitCount += 1;
		return entry.buffer;
	}

	_setInCache(key, buffer) {
		if (this.cache.size >= this.cacheMaxEntries) {
			// Evict the oldest entry to keep the cache bounded.
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}
		this.cache.set(key, {
			buffer,
			expiresAt: Date.now() + this.cacheTtlMs,
		});
	}

	/**
	 * Public read-only status snapshot for /api/status. Never includes chart
	 * pixel data, alert text, or any user content.
	 */
	getStatus() {
		return {
			enabled: this.isEnabled(),
			renderCount: this.counters.renderCount,
			cacheHitCount: this.counters.cacheHitCount,
			cacheMissCount: this.counters.cacheMissCount,
			successCount: this.counters.successCount,
			failureCount: this.counters.failureCount,
			lastFailureCategory: this.counters.lastFailureCategory,
			lastRenderedAt: this.counters.lastRenderedAt,
			cacheSize: this.cache.size,
			cacheMaxEntries: this.cacheMaxEntries,
			timeoutMs: this.timeoutMs,
			cacheTtlMs: this.cacheTtlMs,
		};
	}

	/**
	 * Test-only helper. Resets counters and clears the cache.
	 */
	_reset() {
		this.cache.clear();
		this.counters = {
			renderCount: 0,
			cacheHitCount: 0,
			cacheMissCount: 0,
			successCount: 0,
			failureCount: 0,
			lastFailureCategory: null,
			lastRenderedAt: null,
		};
	}
}

function withTimeout(promise, timeoutMs, onTimeout) {
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			try {
				onTimeout();
			} catch (error) {
				console.warn('[chartRenderer] timeout handler failed:', error.message);
			}
			resolve(null);
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				console.warn('[chartRenderer] render failed:', error?.message || error);
				resolve(null);
			},
		);
	});
}

function buildCacheKey({ type, symbol, timeframe, rangeKey, width, height, values }) {
	const first = values[0];
	const last = values[values.length - 1];
	const min = values.reduce((acc, v) => (v < acc ? v : acc), values[0]);
	const max = values.reduce((acc, v) => (v > acc ? v : acc), values[0]);
	return [
		type,
		String(symbol || '').toLowerCase(),
		String(timeframe || ''),
		String(rangeKey || ''),
		width,
		height,
		values.length,
		first,
		last,
		min,
		max,
	].join('|');
}

function renderSparklinePixels({ values, width, height }) {
	const padding = DEFAULT_PADDING;
	const drawableWidth = width - padding * 2;
	const drawableHeight = height - padding * 2;
	if (drawableWidth < 2 || drawableHeight < 2) {
		return null;
	}

	const min = values.reduce((acc, v) => (v < acc ? v : acc), values[0]);
	const max = values.reduce((acc, v) => (v > acc ? v : acc), values[0]);
	const range = max - min;
	const pixels = Buffer.alloc(width * height * 4, 0);
	fillBackground(pixels, width, height, DEFAULT_BG_COLOR);
	drawFrame(pixels, width, height, padding, DEFAULT_AXIS_COLOR);

	if (range === 0) {
		// Flat series: draw a single horizontal line at midheight.
		const y = Math.floor(height / 2);
		for (let x = padding; x < width - padding; x += 1) {
			plotRgba(pixels, width, x, y, DEFAULT_LINE_COLOR);
		}
	} else {
		const stepX = drawableWidth / (values.length - 1);
		for (let i = 0; i < values.length - 1; i += 1) {
			const x0 = Math.round(padding + i * stepX);
			const x1 = Math.round(padding + (i + 1) * stepX);
			const y0 = Math.round(padding + (1 - (values[i] - min) / range) * drawableHeight);
			const y1 = Math.round(padding + (1 - (values[i + 1] - min) / range) * drawableHeight);
			drawLine(pixels, width, height, x0, y0, x1, y1, DEFAULT_LINE_COLOR);
		}
	}

	return encodeRgba({ width, height, pixels });
}

function fillBackground(pixels, width, height, color) {
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			plotRgba(pixels, width, x, y, color);
		}
	}
}

function drawFrame(pixels, width, height, padding, color) {
	for (let x = padding; x < width - padding; x += 1) {
		plotRgba(pixels, width, x, padding, color);
		plotRgba(pixels, width, x, height - padding - 1, color);
	}
	for (let y = padding; y < height - padding; y += 1) {
		plotRgba(pixels, width, padding, y, color);
		plotRgba(pixels, width, width - padding - 1, y, color);
	}
}

function plotRgba(pixels, width, x, y, color) {
	if (x < 0 || y < 0 || x >= width) {
		return;
	}
	const index = (y * width + x) * 4;
	if (index + 3 >= pixels.length) {
		return;
	}
	pixels[index] = color.r;
	pixels[index + 1] = color.g;
	pixels[index + 2] = color.b;
	pixels[index + 3] = color.a;
}

function drawLine(pixels, width, height, x0, y0, x1, y1, color) {
	const dx = Math.abs(x1 - x0);
	const dy = Math.abs(y1 - y0);
	const sx = x0 < x1 ? 1 : -1;
	const sy = y0 < y1 ? 1 : -1;
	let err = dx - dy;
	let x = x0;
	let y = y0;
	while (true) {
		plotRgba(pixels, width, x, y, color);
		if (x === x1 && y === y1) {
			break;
		}
		const e2 = 2 * err;
		if (e2 > -dy) {
			err -= dy;
			x += sx;
		}
		if (e2 < dx) {
			err += dx;
			y += sy;
		}
	}
}

module.exports = ChartRenderer;
