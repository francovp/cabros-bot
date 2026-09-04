'use strict';

const metrics = require('../../src/services/grounding/metrics');

describe('grounding metrics', () => {
	beforeEach(() => {
		metrics.resetForTesting?.();
	});

	afterEach(() => {
		metrics.resetForTesting?.();
	});

	it('returns initial zero counts on getSnapshot', () => {
		const snapshot = metrics.getSnapshot();
		expect(snapshot).toEqual({
			totalRequests: 0,
			successRequests: 0,
			failureRequests: 0,
			timeoutRequests: 0,
		});
	});

	it('returns operational metrics including successRate and uptimeSince on getMetrics', () => {
		const result = metrics.getMetrics();
		expect(result).toEqual({
			totalRequests: 0,
			successRequests: 0,
			failureRequests: 0,
			timeoutRequests: 0,
			successRate: 0,
			uptimeSince: expect.any(String),
		});
		expect(new Date(result.uptimeSince).toISOString()).toBe(result.uptimeSince);
	});

	it('calculates successRate accurately on getMetrics with rounded 3 decimal places', () => {
		// 1180 successes out of 1234 total requests = 0.956
		for (let i = 0; i < 1180; i++) {
			metrics.recordSuccess(50, 'ALERT_ENRICHMENT');
		}
		for (let i = 0; i < 40; i++) {
			metrics.recordFailure('error', new Error('fail'), 'ALERT_ENRICHMENT');
		}
		for (let i = 0; i < 14; i++) {
			metrics.recordFailure('timeout', new Error('timeout'), 'ALERT_ENRICHMENT');
		}

		const result = metrics.getMetrics();
		expect(result.totalRequests).toBe(1234);
		expect(result.successRequests).toBe(1180);
		expect(result.failureRequests).toBe(40);
		expect(result.timeoutRequests).toBe(14);
		expect(result.successRate).toBe(0.956);
	});

	it('increments total and success counters on recordSuccess', () => {
		metrics.recordSuccess(120, 'ALERT_ENRICHMENT');
		expect(metrics.getSnapshot()).toEqual({
			totalRequests: 1,
			successRequests: 1,
			failureRequests: 0,
			timeoutRequests: 0,
		});

		metrics.recordSuccess(250, 'NEWS_ANALYSIS');
		expect(metrics.getSnapshot()).toEqual({
			totalRequests: 2,
			successRequests: 2,
			failureRequests: 0,
			timeoutRequests: 0,
		});
	});

	it('increments total and failure counters on recordFailure for general errors', () => {
		metrics.recordFailure('error', new Error('API connection failed'), 'ALERT_ENRICHMENT');
		expect(metrics.getSnapshot()).toEqual({
			totalRequests: 1,
			successRequests: 0,
			failureRequests: 1,
			timeoutRequests: 0,
		});
	});

	it('increments total and timeout counters on recordFailure for timeout errors', () => {
		metrics.recordFailure('timeout', new Error('Grounding timeout'), 'ALERT_ENRICHMENT');
		expect(metrics.getSnapshot()).toEqual({
			totalRequests: 1,
			successRequests: 0,
			failureRequests: 0,
			timeoutRequests: 1,
		});
	});

	it('resets all counters on resetForTesting', () => {
		metrics.recordSuccess(100, 'ALERT_ENRICHMENT');
		metrics.recordFailure('timeout', new Error('timeout'), 'ALERT_ENRICHMENT');
		metrics.recordFailure('error', new Error('fail'), 'ALERT_ENRICHMENT');

		metrics.resetForTesting();
		expect(metrics.getSnapshot()).toEqual({
			totalRequests: 0,
			successRequests: 0,
			failureRequests: 0,
			timeoutRequests: 0,
		});
	});

	it('tracks search coalescing counters separately from grounding request metrics', () => {
		metrics.recordCoalescingMiss();
		metrics.recordCoalescingHit();
		metrics.recordCoalescingFailure();

		expect(metrics.getSnapshot()).toEqual({
			totalRequests: 0,
			successRequests: 0,
			failureRequests: 0,
			timeoutRequests: 0,
		});
		expect(metrics.getCoalescingSnapshot()).toEqual({ hits: 1, misses: 1, failures: 1 });
	});
});
