'use strict';

const { TradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('TradingViewMcpService toolMetrics', () => {
	let service;

	beforeEach(() => {
		service = new TradingViewMcpService({
			url: 'https://tradingview-mcp-test.com/mcp',
		});
		service._resetForTesting();
	});

	it('initializes with empty toolMetrics', () => {
		expect(service.getToolMetrics()).toEqual({});
	});

	it('records successful tool calls and computes averageDurationMs', () => {
		service._recordToolSuccess('coin_analysis', 100);
		service._recordToolSuccess('coin_analysis', 200);

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis).toEqual({
			callCount: 2,
			successCount: 2,
			failureCount: 0,
			timeoutCount: 0,
			totalDurationMs: 300,
			averageDurationMs: 150,
			lastCallAt: expect.any(String),
			lastErrorCategory: null,
		});
	});

	it('records failed tool calls with categorized lastErrorCategory', () => {
		service._recordToolSuccess('coin_analysis', 100);
		service._recordToolFailure('coin_analysis', 200, new Error('HTTP 502 Bad Gateway'));

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis).toEqual({
			callCount: 2,
			successCount: 1,
			failureCount: 1,
			timeoutCount: 0,
			totalDurationMs: 300,
			averageDurationMs: 150,
			lastCallAt: expect.any(String),
			lastErrorCategory: 'http_5xx',
		});
	});

	it('increments timeoutCount when failure is a timeout error', () => {
		const timeoutError = new Error('request aborted: timeout');
		service._recordToolFailure('volume_confirmation_analysis', 500, timeoutError);

		const metrics = service.getToolMetrics();
		expect(metrics.volume_confirmation_analysis).toEqual({
			callCount: 1,
			successCount: 0,
			failureCount: 1,
			timeoutCount: 1,
			totalDurationMs: 500,
			averageDurationMs: 500,
			lastCallAt: expect.any(String),
			lastErrorCategory: 'timeout',
		});
	});

	it('detects timeout from AbortError name', () => {
		const abortError = new Error('The operation was aborted');
		abortError.name = 'AbortError';
		service._recordToolFailure('multi_agent_analysis', 400, abortError);

		const metrics = service.getToolMetrics();
		expect(metrics.multi_agent_analysis.timeoutCount).toBe(1);
		expect(metrics.multi_agent_analysis.lastErrorCategory).toBe('timeout');
	});

	it('tracks metrics separately per tool name', () => {
		service._recordToolSuccess('coin_analysis', 100);
		service._recordToolSuccess('combined_analysis', 250);
		service._recordToolFailure('scan_top_gainers', 300, new Error('HTTP 404 Not Found'));

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis.callCount).toBe(1);
		expect(metrics.combined_analysis.callCount).toBe(1);
		expect(metrics.scan_top_gainers.callCount).toBe(1);
		expect(metrics.scan_top_gainers.lastErrorCategory).toBe('http_4xx');
	});

	it('instruments tool operations via _instrumentToolCall on success', async () => {
		const operation = jest.fn().mockResolvedValue({ result: 'ok' });
		const result = await service._instrumentToolCall('coin_analysis', operation);

		expect(result).toEqual({ result: 'ok' });
		expect(operation).toHaveBeenCalledTimes(1);

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis.callCount).toBe(1);
		expect(metrics.coin_analysis.successCount).toBe(1);
		expect(metrics.coin_analysis.failureCount).toBe(0);
		expect(metrics.coin_analysis.lastCallAt).not.toBeNull();
	});

	it('instruments tool operations via _instrumentToolCall on failure', async () => {
		const operation = jest.fn().mockRejectedValue(new Error('HTTP 500 Internal Server Error'));

		await expect(service._instrumentToolCall('coin_analysis', operation)).rejects.toThrow('HTTP 500');

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis.callCount).toBe(1);
		expect(metrics.coin_analysis.successCount).toBe(0);
		expect(metrics.coin_analysis.failureCount).toBe(1);
		expect(metrics.coin_analysis.lastErrorCategory).toBe('http_5xx');
	});

	it('does not record failure metrics when signal was aborted with user cancellation', async () => {
		const controller = new AbortController();
		controller.abort('Job cancelled by user');

		const operation = jest.fn().mockRejectedValue(new Error('Job cancelled by user'));

		await expect(
			service._instrumentToolCall('coin_analysis', operation, { signal: controller.signal })
		).rejects.toThrow('Job cancelled by user');

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis).toBeUndefined();
	});

	it('resets lastErrorCategory to null when circuit breaker transitions to half-open', () => {
		service._recordToolFailure('coin_analysis', 100, new Error('HTTP 500'));
		service._recordToolFailure('volume_confirmation_analysis', 200, new Error('timeout'));

		expect(service.getToolMetrics().coin_analysis.lastErrorCategory).toBe('http_5xx');
		expect(service.getToolMetrics().volume_confirmation_analysis.lastErrorCategory).toBe('timeout');

		// Force breaker open and simulate cooldown expiry
		service.breakerState = 'open';
		service.breakerOpenedAt = new Date(Date.now() - 700000).toISOString();

		const state = service.getBreakerState();
		expect(state).toBe('half-open');

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis.lastErrorCategory).toBeNull();
		expect(metrics.volume_confirmation_analysis.lastErrorCategory).toBeNull();
		// Counts and durations remain preserved
		expect(metrics.coin_analysis.callCount).toBe(1);
		expect(metrics.coin_analysis.failureCount).toBe(1);
		expect(metrics.volume_confirmation_analysis.timeoutCount).toBe(1);
	});

	it('returns shallow copy of metrics preventing external mutation', () => {
		service._recordToolSuccess('coin_analysis', 100);
		const metrics = service.getToolMetrics();
		metrics.coin_analysis.callCount = 999;

		expect(service.getToolMetrics().coin_analysis.callCount).toBe(1);
	});

	it('instruments concurrent tool calls accurately without race conditions', async () => {
		service._executeCallTool = jest.fn().mockImplementation(async (toolName) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { ok: true, tool: toolName };
		});

		await Promise.all([
			service._callTool('coin_analysis', {}),
			service._callTool('coin_analysis', {}),
			service._callTool('combined_analysis', {}),
		]);

		const metrics = service.getToolMetrics();
		expect(metrics.coin_analysis.callCount).toBe(2);
		expect(metrics.coin_analysis.successCount).toBe(2);
		expect(metrics.combined_analysis.callCount).toBe(1);
		expect(metrics.combined_analysis.successCount).toBe(1);
	});

	it('includes toolMetrics in getStatus() when enabled and matching runtimeStatus', () => {
		service._recordToolSuccess('coin_analysis', 120);

		const status = service.getStatus({ enabled: true });
		expect(status.toolMetrics).toBeDefined();
		expect(status.toolMetrics.coin_analysis.callCount).toBe(1);
	});

	it('omits toolMetrics in getStatus() when enabled is false', () => {
		service._recordToolSuccess('coin_analysis', 120);

		const status = service.getStatus({ enabled: false });
		expect(status.toolMetrics).toBeUndefined();
	});
	it('does not pollute Object.prototype for inherited tool names', () => {
		service._recordToolSuccess('toString', 100);
		service._recordToolFailure('constructor', 50, new Error('boom'));

		expect(Object.prototype.toString.callCount).toBeUndefined();
		expect(Object.prototype.constructor.callCount).toBeUndefined();
		expect(({}).valueOf.callCount).toBeUndefined();

		const metrics = service.getToolMetrics();
		expect(metrics.toString.callCount).toBe(1);
		expect(metrics.toString.successCount).toBe(1);
		expect(metrics.constructor.failureCount).toBe(1);
	});

	it('clears lastErrorCategory once the tool recovers', () => {
		service._recordToolFailure('coin_analysis', 100, new Error('ETIMEDOUT: request timed out'));
		expect(service.getToolMetrics().coin_analysis.lastErrorCategory).toBe('timeout');

		service._recordToolSuccess('coin_analysis', 100);
		const metric = service.getToolMetrics().coin_analysis;
		expect(metric.lastErrorCategory).toBeNull();
		expect(metric.successCount).toBe(1);
	});

	it('bounds the toolMetrics map and evicts the least recently called tool', () => {
		for (let i = 0; i < 60; i += 1) {
			service._recordToolSuccess(`tool_${i}`, 10);
		}

		const metrics = service.getToolMetrics();
		expect(Object.keys(metrics).length).toBeLessThanOrEqual(50);
		expect(metrics.tool_59).toBeDefined();
		// the oldest entry is evicted first
		expect(metrics.tool_0).toBeUndefined();
	});
});
