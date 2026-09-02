/**
 * Unit tests for the chart renderer service (GH-799).
 *
 * Verifies:
 * - Sparkline rendering produces a valid PNG buffer (magic signature).
 * - Cache hits reuse the same buffer and increment cacheHitCount.
 * - Fail-open paths (disabled flag, invalid input, single value) return null.
 * - Status snapshot exposes only non-sensitive counters.
 */

const ChartRenderer = require('../../src/services/notification/charts/chartRenderer');
const pngEncoder = require('../../src/services/notification/charts/pngEncoder');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('chartRenderer', () => {
	let renderer;
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.ENABLE_CHART_ATTACHMENTS;
		process.env.ENABLE_CHART_ATTACHMENTS = 'true';
		renderer = new ChartRenderer();
	});

	afterEach(() => {
		process.env.ENABLE_CHART_ATTACHMENTS = originalEnv;
	});

	it('returns a valid PNG buffer with the standard PNG signature', async () => {
		const buffer = await renderer.renderSparkline({
			values: [10, 12, 11, 14, 13, 15, 16, 14, 17, 18],
			symbol: 'BTCUSDT',
			timeframe: '1h',
			rangeKey: 'last-10',
		});
		expect(buffer).not.toBeNull();
		expect(Buffer.isBuffer(buffer)).toBe(true);
		expect(buffer.slice(0, 8).equals(PNG_SIGNATURE)).toBe(true);
	});

	it('increments successCount and lastRenderedAt on successful render', async () => {
		await renderer.renderSparkline({ values: [1, 2, 3, 4, 5] });
		const status = renderer.getStatus();
		expect(status.successCount).toBe(1);
		expect(status.failureCount).toBe(0);
		expect(status.lastRenderedAt).not.toBeNull();
	});

	it('caches identical sparkline requests and reuses the buffer', async () => {
		const params = {
			values: [5, 6, 4, 7, 8, 6, 9, 10],
			symbol: 'ETHUSDT',
			timeframe: '1h',
			rangeKey: 'last-8',
			width: 200,
			height: 60,
		};
		const first = await renderer.renderSparkline(params);
		const second = await renderer.renderSparkline(params);
		expect(first).toBe(second);
		const status = renderer.getStatus();
		expect(status.cacheHitCount).toBe(1);
		expect(status.cacheMissCount).toBe(1);
		expect(status.renderCount).toBe(1);
	});

	it('returns null when the feature flag is disabled', async () => {
		process.env.ENABLE_CHART_ATTACHMENTS = 'false';
		const buffer = await renderer.renderSparkline({ values: [1, 2, 3, 4, 5] });
		expect(buffer).toBeNull();
	});

	it('returns null for non-array values and short series', async () => {
		expect(await renderer.renderSparkline({ values: 'not array' })).toBeNull();
		expect(await renderer.renderSparkline({ values: [] })).toBeNull();
		expect(await renderer.renderSparkline({ values: [42] })).toBeNull();
		expect(await renderer.renderSparkline({ values: [1, NaN, 3] })).toBeNull();
	});

	it('records INVALID_INPUT failure category on bad input', async () => {
		await renderer.renderSparkline({ values: [] });
		const status = renderer.getStatus();
		expect(status.failureCount).toBe(1);
		expect(status.lastFailureCategory).toBe('INVALID_INPUT');
	});

	it('handles a flat (zero range) series without dividing by zero', async () => {
		const buffer = await renderer.renderSparkline({ values: [5, 5, 5, 5, 5] });
		expect(buffer).not.toBeNull();
		expect(buffer.slice(0, 8).equals(PNG_SIGNATURE)).toBe(true);
	});

	it('exposes a redacted status snapshot', () => {
		const status = renderer.getStatus();
		expect(status).toEqual(expect.objectContaining({
			enabled: true,
			renderCount: 0,
			cacheHitCount: 0,
			cacheMissCount: 0,
			successCount: 0,
			failureCount: 0,
			cacheSize: 0,
		}));
		expect(status).not.toHaveProperty('buffer');
		expect(status).not.toHaveProperty('pixels');
		expect(status).not.toHaveProperty('cache');
	});
});

describe('pngEncoder', () => {
	it('encodes a 2x2 RGBA buffer into a valid PNG', () => {
		const pixels = Buffer.alloc(2 * 2 * 4, 0xff);
		const png = pngEncoder.encodeRgba({ width: 2, height: 2, pixels });
		expect(png).not.toBeNull();
		expect(png.slice(0, 8).equals(PNG_SIGNATURE)).toBe(true);
	});

	it('encodes a 2x2 grayscale buffer into a valid PNG', () => {
		const pixels = Buffer.alloc(2 * 2, 0x80);
		const png = pngEncoder.encodeGrayscale({ width: 2, height: 2, pixels });
		expect(png).not.toBeNull();
		expect(png.slice(0, 8).equals(PNG_SIGNATURE)).toBe(true);
	});

	it('returns null for invalid dimensions', () => {
		expect(pngEncoder.encodeRgba({ width: 0, height: 10, pixels: Buffer.alloc(0) })).toBeNull();
		expect(pngEncoder.encodeRgba({ width: 10, height: 0, pixels: Buffer.alloc(0) })).toBeNull();
		expect(pngEncoder.encodeRgba({ width: -1, height: 10, pixels: Buffer.alloc(0) })).toBeNull();
	});

	it('returns null for mismatched pixel buffer length', () => {
		expect(pngEncoder.encodeRgba({ width: 4, height: 4, pixels: Buffer.alloc(10) })).toBeNull();
		expect(pngEncoder.encodeGrayscale({ width: 4, height: 4, pixels: Buffer.alloc(10) })).toBeNull();
	});

	it('returns null when dimensions exceed MAX_DIMENSION', () => {
		const oversized = pngEncoder.MAX_DIMENSION + 1;
		expect(pngEncoder.encodeRgba({ width: oversized, height: 1, pixels: Buffer.alloc(4) })).toBeNull();
	});

	it('returns null for non-Buffer pixel input', () => {
		expect(pngEncoder.encodeRgba({ width: 2, height: 2, pixels: 'not a buffer' })).toBeNull();
	});
});
