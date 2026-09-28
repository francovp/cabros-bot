'use strict';

const { encodePng } = require('../../src/services/notification/charts/pngEncoder');
const { RasterCanvas, PALETTE } = require('../../src/services/notification/charts/rasterCanvas');
const {
	ChartRendererService,
	getChartRendererService,
	resetChartRendererService,
	CATEGORIES,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_CACHE_TTL_SECONDS,
} = require('../../src/services/notification/charts/chartRenderer');
const { resolveChartRequest, renderAlertChart, pickSymbol, pickTimeframe } = require('../../src/services/notification/charts/chartAttachment');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeBars(count, { start = 100, step = 1, volume = 1000 } = {}) {
	const bars = [];
	for (let i = 0; i < count; i += 1) {
		const open = start + i * step;
		const close = open + step / 2;
		bars.push({
			open,
			high: Math.max(open, close) + 0.4,
			low: Math.min(open, close) - 0.4,
			close,
			volume: volume + i,
		});
	}
	return bars;
}

function enabledRenderer(overrides = {}) {
	return new ChartRendererService({
		env: {},
		config: { enabled: true, renderTimeoutMs: 2000, cacheTtlSeconds: 60, ...overrides },
	});
}

describe('pngEncoder', () => {
	it('produces a valid PNG signature and terminates with IEND', () => {
		const canvas = new RasterCanvas(4, 4, [1, 2, 3, 255]);
		const png = encodePng(canvas.pixels, 4, 4);
		expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
		expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
	});

	it('writes IHDR with the requested dimensions', () => {
		const canvas = new RasterCanvas(9, 5);
		const png = encodePng(canvas.pixels, 9, 5);
		expect(png.readUInt32BE(16)).toBe(9);
		expect(png.readUInt32BE(20)).toBe(5);
		expect(png.readUInt8(24)).toBe(8); // bit depth
		expect(png.readUInt8(25)).toBe(6); // RGBA colour type
	});

	it('rejects mismatched buffer lengths and non-positive dimensions', () => {
		expect(() => encodePng(Buffer.alloc(10), 2, 2)).toThrow(RangeError);
		expect(() => encodePng(Buffer.alloc(16), 0, 2)).toThrow(RangeError);
		expect(() => encodePng('not-a-buffer', 2, 2)).toThrow(TypeError);
	});
});

describe('RasterCanvas', () => {
	it('clips drawing operations to the canvas bounds', () => {
		const canvas = new RasterCanvas(4, 4, [0, 0, 0, 255]);
		canvas.fillRect(-10, -10, 100, 100, [255, 0, 0, 255]);
		expect(canvas.pixels.subarray(0, 4)).toEqual(Buffer.from([255, 0, 0, 255]));
		expect(() => canvas.line(-50, -50, 50, 50, [1, 2, 3, 255], 1)).not.toThrow();
	});

	it('blends semi-transparent colours instead of overwriting', () => {
		const opaque = new RasterCanvas(1, 1, [0, 0, 0, 255]);
		opaque.setPixel(0, 0, [255, 255, 255, 128]);
		const [r, g, b] = [opaque.pixels[0], opaque.pixels[1], opaque.pixels[2]];
		expect(r).toBeGreaterThan(0);
		expect(r).toBeLessThan(255);
		expect(g).toBe(b);
	});

	it('measures and draws text with the built-in font', () => {
		const canvas = new RasterCanvas(120, 20);
		const advance = canvas.text('BTC 42.1%', 2, 2, PALETTE.text, 1);
		expect(advance).toBeGreaterThan(0);
		expect(RasterCanvas.measureText('ABC', 2)).toBe(3 * 6 * 2 - 2);
	});
});

describe('ChartRendererService config parsing', () => {
	it('is disabled unless ENABLE_CHART_ATTACHMENTS is exactly "true"', () => {
		expect(new ChartRendererService({ env: {} }).isEnabled()).toBe(false);
		expect(new ChartRendererService({ env: { ENABLE_CHART_ATTACHMENTS: 'false' } }).isEnabled()).toBe(false);
		expect(new ChartRendererService({ env: { ENABLE_CHART_ATTACHMENTS: 'TRUE' } }).isEnabled()).toBe(false);
		expect(new ChartRendererService({ env: { ENABLE_CHART_ATTACHMENTS: 'true' } }).isEnabled()).toBe(true);
	});

	it('falls back to documented defaults for malformed tuning values', () => {
		const service = new ChartRendererService({
			env: { ENABLE_CHART_ATTACHMENTS: 'true', CHART_RENDER_TIMEOUT_MS: 'abc', CHART_CACHE_TTL_SECONDS: '-5' },
		});
		expect(service.config.renderTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);
		expect(service.config.cacheTtlSeconds).toBe(DEFAULT_CACHE_TTL_SECONDS);
	});

	it('accepts in-range tuning values and rejects out-of-range ones', () => {
		const ok = new ChartRendererService({
			env: { CHART_RENDER_TIMEOUT_MS: '2500', CHART_CACHE_TTL_SECONDS: '0' },
		});
		expect(ok.config.renderTimeoutMs).toBe(2500);
		expect(ok.config.cacheTtlSeconds).toBe(0);

		const outOfRange = new ChartRendererService({ env: { CHART_RENDER_TIMEOUT_MS: '10' } });
		expect(outOfRange.config.renderTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);
	});
});

describe('ChartRendererService rendering', () => {
	it('exposes only the closed category enum', () => {
		expect(CATEGORIES).toEqual(['sparkline', 'candlestick']);
	});

	it('returns null and records a skip when the feature is disabled', async () => {
		const service = new ChartRendererService({ env: {} });
		await expect(service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(5) })).resolves.toBeNull();
		expect(service.getStatus().skippedDisabled).toBe(1);
	});

	it('renders a sparkline PNG when enabled', async () => {
		const service = enabledRenderer();
		const result = await service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(8), category: 'sparkline' });
		expect(result.buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
		expect(result.category).toBe('sparkline');
		expect(result.cacheHit).toBe(false);
	});

	it('renders a larger candlestick PNG with the risk overlay', async () => {
		const service = enabledRenderer();
		const result = await service.renderChart({
			symbol: 'BINANCE:BTCUSDT', bars: makeBars(30), category: 'candlestick',
			entry: 100, target: 140, stop: 95,
		});
		expect(result.category).toBe('candlestick');
		const sparkline = await service.renderChart({ symbol: 'ETHUSDT', bars: makeBars(5), category: 'sparkline' });
		expect(result.buffer.length).toBeGreaterThan(sparkline.buffer.length);
	});

	it('handles a flat price series without dividing by zero', async () => {
		const service = enabledRenderer();
		const flat = Array.from({ length: 6 }, () => ({ open: 5, high: 5, low: 5, close: 5, volume: 3 }));
		const result = await service.renderChart({ symbol: 'FLAT', bars: flat, category: 'sparkline' });
		expect(result.buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
	});

	it('returns null (fail-open) for unusable data instead of throwing', async () => {
		const service = enabledRenderer();
		await expect(service.renderChart({ symbol: 'BTCUSDT', bars: [] })).resolves.toBeNull();
		await expect(service.renderChart({ symbol: 'BTCUSDT', bars: 'nope' })).resolves.toBeNull();
		await expect(service.renderChart({ symbol: 'BTCUSDT', bars: [{ open: 1 }] })).resolves.toBeNull();
		expect(service.getStatus().failures).toBe(3);
		expect(service.getStatus().lastErrorCategory).toBe('insufficient_data');
	});

	it('drops bars with inconsistent OHLC relationships', async () => {
		const service = enabledRenderer();
		const bars = makeBars(6);
		bars.push({ open: 10, high: 1, low: 20, close: 10, volume: 1 });
		const result = await service.renderChart({ symbol: 'BTCUSDT', bars, category: 'sparkline' });
		expect(result.buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
	});

	it('records a timeout category and returns null when the cooperative budget elapses', async () => {
		const service = enabledRenderer({ renderTimeoutMs: 100 });
		// A zero-width chart makes every fill degenerate but the budget is what
		// must stop the loop, so simulate a render that outruns its allowance.
		const drawSpy = jest.spyOn(service, '_drawCandlestick').mockImplementation(
			(bars, request, isOverBudget) => {
				const until = Date.now() + 300;
				while (Date.now() < until) { /* simulate a slow draw */ }
				service._abortIfOverBudget(isOverBudget);
				return Buffer.from('late');
			},
		);
		await expect(service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(30), category: 'candlestick' }))
			.resolves.toBeNull();
		expect(service.getStatus().timeouts).toBe(1);
		expect(service.getStatus().lastErrorCategory).toBe('timeout');
		drawSpy.mockRestore();
	});

	it('aborts a real candlestick draw once the budget is exhausted', async () => {
		const service = enabledRenderer({ renderTimeoutMs: 100 });
		// Simulate elapsed time without actually sleeping.
		jest.spyOn(Date, 'now')
			.mockReturnValueOnce(0)
			.mockReturnValue(10_000);
		await expect(service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(30), category: 'candlestick' }))
			.resolves.toBeNull();
		expect(service.getStatus().lastErrorCategory).toBe('timeout');
		Date.now.mockRestore();
	});

	it('records a render_error category when drawing throws', async () => {
		const service = enabledRenderer();
		jest.spyOn(service, '_drawChart').mockImplementation(() => { throw new Error('boom'); });
		await expect(service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(5) })).resolves.toBeNull();
		expect(service.getStatus().lastErrorCategory).toBe('render_error');
	});
});

describe('ChartRendererService caching', () => {
	it('serves a cache hit for the same (symbol, timeframe, rangeKey)', async () => {
		const service = enabledRenderer();
		const request = { symbol: 'BTCUSDT', timeframe: '1h', bars: makeBars(10), rangeKey: 'full' };
		const first = await service.renderChart(request);
		const second = await service.renderChart({ ...request, bars: makeBars(10) });
		expect(first.cacheHit).toBe(false);
		expect(second.cacheHit).toBe(true);
		expect(second.buffer).toBe(first.buffer);
		expect(service.getStatus().renders).toBe(1);
		expect(service.getStatus().cacheHits).toBe(1);
	});

	it('keys the cache per symbol, timeframe and rangeKey', async () => {
		const service = enabledRenderer();
		await service.renderChart({ symbol: 'BTCUSDT', timeframe: '1h', bars: makeBars(5), rangeKey: 'a' });
		await service.renderChart({ symbol: 'ETHUSDT', timeframe: '1h', bars: makeBars(5), rangeKey: 'a' });
		await service.renderChart({ symbol: 'BTCUSDT', timeframe: '4h', bars: makeBars(5), rangeKey: 'a' });
		await service.renderChart({ symbol: 'BTCUSDT', timeframe: '1h', bars: makeBars(5), rangeKey: 'b' });
		expect(service.getStatus().renders).toBe(4);
		expect(service.getStatus().cacheHits).toBe(0);
	});

	it('does not cache when the TTL is zero', async () => {
		const service = enabledRenderer({ cacheTtlSeconds: 0 });
		await service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(5) });
		await service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(5) });
		expect(service.getStatus().cacheHits).toBe(0);
		expect(service.getStatus().renders).toBe(2);
	});

	it('bounds the cache size', async () => {
		const service = enabledRenderer();
		for (let i = 0; i < 260; i += 1) {
			await service.renderChart({ symbol: `SYM${i}`, bars: makeBars(4) });
		}
		expect(service.getStatus().cacheEntries).toBeLessThanOrEqual(200);
	});

	it('clears and resets counters', async () => {
		const service = enabledRenderer();
		await service.renderChart({ symbol: 'BTCUSDT', bars: makeBars(5) });
		service.clearCache();
		expect(service.getStatus().cacheEntries).toBe(0);
		service.reset();
		expect(service.getStatus().renders).toBe(0);
	});
});

describe('chartAttachment', () => {
	it('extracts a symbol and timeframe from an alert', () => {
		expect(pickSymbol({ symbol: 'btcusdt' })).toBe('BTCUSDT');
		expect(pickSymbol({ enriched: { symbol: 'ETHUSDT' } })).toBe('ETHUSDT');
		expect(pickSymbol({})).toBeNull();
		expect(pickTimeframe({ timeframe: '4h' })).toBe('4h');
		expect(pickTimeframe({})).toBe('1h');
	});

	it('picks a sparkline for short series and a candlestick for longer ones', () => {
		expect(resolveChartRequest({ symbol: 'BTCUSDT', chartBars: makeBars(5) }).category).toBe('sparkline');
		expect(resolveChartRequest({ symbol: 'BTCUSDT', chartBars: makeBars(30) }).category).toBe('candlestick');
	});

	it('returns null when the alert carries no renderable bars', () => {
		expect(resolveChartRequest({ symbol: 'BTCUSDT' })).toBeNull();
		expect(resolveChartRequest({ chartBars: makeBars(5) })).toBeNull();
		expect(resolveChartRequest(null)).toBeNull();
	});

	it('folds risk levels into the cache range key', () => {
		const base = { symbol: 'BTCUSDT', chartBars: makeBars(30) };
		const a = resolveChartRequest({ ...base, enriched: { target_level: 140 } });
		const b = resolveChartRequest({ ...base, enriched: { target_level: 150 } });
		expect(a.rangeKey).not.toBe(b.rangeKey);
		expect(a.target).toBe(140);
	});

	it('resolves to null when the renderer is disabled', async () => {
		const disabled = new ChartRendererService({ env: {} });
		await expect(renderAlertChart({ symbol: 'BTCUSDT', chartBars: makeBars(5) }, { renderer: disabled }))
			.resolves.toBeNull();
	});

	it('never throws when the renderer blows up', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const broken = { isEnabled: () => true, renderChart: () => { throw new Error('kaboom'); } };
		await expect(renderAlertChart({ symbol: 'BTCUSDT', chartBars: makeBars(5) }, { renderer: broken }))
			.resolves.toBeNull();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('chart renderer singleton', () => {
	afterEach(() => { resetChartRendererService(); });

	it('returns the same instance until reset', () => {
		const first = getChartRendererService();
		expect(getChartRendererService()).toBe(first);
		resetChartRendererService();
		expect(getChartRendererService()).not.toBe(first);
	});
});
