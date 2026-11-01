/* global jest, describe, it, expect, beforeEach, afterEach */

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
}));

const metrics = require('../../src/controllers/observability/metrics');

describe('MetricsController', () => {
	afterEach(() => { jest.restoreAllMocks(); });
	describe('toFiniteNumber', () => {
		it('returns the value when finite', () => {
			expect(metrics.toFiniteNumber(42)).toBe(42);
			expect(metrics.toFiniteNumber(0)).toBe(0);
			expect(metrics.toFiniteNumber(-3.5)).toBe(-3.5);
		});

		it('falls back when value is non-finite', () => {
			expect(metrics.toFiniteNumber(NaN, 7)).toBe(7);
			expect(metrics.toFiniteNumber(Infinity, 11)).toBe(11);
			expect(metrics.toFiniteNumber(-Infinity, 13)).toBe(13);
		});

		it('uses default 0 when no fallback supplied', () => {
			expect(metrics.toFiniteNumber(NaN)).toBe(0);
			expect(metrics.toFiniteNumber('not a number')).toBe(0);
			expect(metrics.toFiniteNumber(null)).toBe(0);
		});
	});

	describe('toFiniteMillis', () => {
		it('rounds finite positive values to 3 decimals', () => {
			expect(metrics.toFiniteMillis(2.3456789)).toBe(2.346);
			expect(metrics.toFiniteMillis(0)).toBe(0);
		});

		it('returns null for negative or out-of-range values', () => {
			expect(metrics.toFiniteMillis(-1)).toBeNull();
			expect(metrics.toFiniteMillis(200000)).toBeNull();
		});

		it('returns null for non-finite or non-numeric inputs', () => {
			expect(metrics.toFiniteMillis(NaN)).toBeNull();
			expect(metrics.toFiniteMillis('abc')).toBeNull();
		});
	});

	describe('toFiniteSeconds', () => {
		it('preserves uptime seconds rounded to 3 decimals', () => {
			expect(metrics.toFiniteSeconds(12345.678)).toBe(12345.678);
			expect(metrics.toFiniteSeconds(0)).toBe(0);
		});

		it('returns null for out-of-range values', () => {
			expect(metrics.toFiniteSeconds(-1000)).toBeNull();
			expect(metrics.toFiniteSeconds(Number.MAX_SAFE_INTEGER)).toBeNull();
		});
	});

	describe('collectMemory', () => {
		it('returns a structured memory snapshot with finite defaults', () => {
			const mem = metrics.collectMemory();
			expect(mem).toBeTruthy();
			expect(mem.rss).toBeGreaterThan(0);
			expect(mem.heapUsed).toBeGreaterThan(0);
			expect(mem.heapTotal).toBeGreaterThan(0);
			expect(typeof mem.arrayBuffers).toBe('number');
		});
	});

	describe('collectCpu', () => {
		it('returns a CPU usage snapshot', () => {
			const cpu = metrics.collectCpu();
			expect(cpu).toBeTruthy();
			expect(typeof cpu.user).toBe('number');
			expect(typeof cpu.system).toBe('number');
		});
	});

	describe('collectProcess', () => {
		it('returns process metadata with Node version and platform', () => {
			const proc = metrics.collectProcess();
			expect(proc.pid).toBe(process.pid);
			expect(proc.nodeVersion).toBe(process.version);
			expect(typeof proc.platform).toBe('string');
			expect(typeof proc.activeHandles).toBe('number');
			expect(typeof proc.activeRequests).toBe('number');
		});
	});

	describe('measureEventLoopLag', () => {
		it('measures time spent waiting for each callback and clears its deadline', async () => {
			let now = 0n;
			const callbacks = [];
			jest.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);
			jest.spyOn(global, 'setImmediate').mockImplementation((callback) => {
				callbacks.push(callback);
				return {};
			});
			const timer = { unref: jest.fn() };
			jest.spyOn(global, 'setTimeout').mockReturnValue(timer);
			const clear = jest.spyOn(global, 'clearTimeout');
			const pending = metrics.measureEventLoopLag();
			while (callbacks.length) {
				now += 20_000_000n;
				callbacks.shift()();
			}
			expect(await pending).toEqual({ lagMs: 20, maxLagMs: 20, samples: 5 });
			expect(clear).toHaveBeenCalledWith(timer);
		});
		it('returns neutral samples and cancels queued work at its deadline', async () => {
			let deadline;
			const immediate = {};
			jest.spyOn(global, 'setImmediate').mockReturnValue(immediate);
			jest.spyOn(global, 'setTimeout').mockImplementation((callback) => {
				deadline = callback;
				return { unref: jest.fn() };
			});
			const clear = jest.spyOn(global, 'clearImmediate');
			const pending = metrics.measureEventLoopLag();
			deadline();
			expect(await pending).toEqual({ lagMs: null, maxLagMs: null, samples: 0 });
			expect(clear).toHaveBeenCalledWith(immediate);
		});
		it('returns a bounded event-loop probe with non-negative samples', async () => {
			const result = await metrics.measureEventLoopLag();
			expect(result.samples).toBeGreaterThan(0);
			if (result.lagMs !== null) {
				expect(result.lagMs).toBeGreaterThanOrEqual(0);
			}
			if (result.maxLagMs !== null) {
				expect(result.maxLagMs).toBeGreaterThanOrEqual(0);
			}
		});
	});

	describe('collectMetrics', () => {
		it('returns the documented shape with lazy fields', async () => {
			const m = await metrics.collectMetrics();
			expect(m).toHaveProperty('uptime');
			expect(m).toHaveProperty('memory');
			expect(m).toHaveProperty('cpu');
			expect(m).toHaveProperty('eventLoop');
			expect(m).toHaveProperty('process');
			expect(m).toHaveProperty('node');
			expect(m.process.nodeVersion).toBe(process.version);
		});
	});

	describe('getMetrics', () => {
		let jsonMock;
		let statusMock;
		let res;

		beforeEach(() => {
			jsonMock = jest.fn();
			statusMock = jest.fn().mockReturnValue({ json: jsonMock });
			res = { status: statusMock, json: jsonMock };
		});

		it('returns 200 with a structured snapshot on success', async () => {
			await metrics.getMetrics({ method: 'GET' }, res);
			expect(statusMock).toHaveBeenCalledWith(200);
			expect(jsonMock).toHaveBeenCalledTimes(1);
			const payload = jsonMock.mock.calls[0][0];
			expect(payload.success).toBe(true);
			expect(payload).toHaveProperty('memory');
			expect(payload).toHaveProperty('cpu');
			expect(payload).toHaveProperty('eventLoop');
			expect(payload).toHaveProperty('process');
			expect(payload.node).toBe(process.version);
		});

		it('returns a standard 500 envelope when process collection throws', async () => {
			jest.spyOn(process, 'uptime').mockImplementation(() => { throw new Error('boom'); });
			await metrics.getMetrics({ method: 'GET' }, res);
			expect(statusMock).toHaveBeenCalledWith(500);
			expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR', retryable: true, requestId: expect.any(String) }));
		});
	});
});
