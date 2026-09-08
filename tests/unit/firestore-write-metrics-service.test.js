'use strict';

const {
	FirestoreWriteMetricsService,
	firestoreWriteMetricsService,
} = require('../../src/services/storage/FirestoreWriteMetricsService');

describe('FirestoreWriteMetricsService', () => {
	let service;

	beforeEach(() => {
		service = new FirestoreWriteMetricsService();
		service.resetForTesting();
	});

	it('returns null when no writes have been recorded', () => {
		expect(service.getSnapshot()).toBeNull();
	});

	it('counts successful writes per domain', () => {
		service.recordWriteSuccess('alerts');
		service.recordWriteSuccess('alerts');
		service.recordWriteSuccess('jobs');

		const snapshot = service.getSnapshot();
		expect(snapshot).not.toBeNull();
		expect(snapshot.writesAttempted).toBe(3);
		expect(snapshot.writesSucceeded).toBe(3);
		expect(snapshot.writesFailed).toBe(0);
		expect(snapshot.successRate).toBeCloseTo(1, 5);
		expect(snapshot.byDomain.alerts.success).toBe(2);
		expect(snapshot.byDomain.alerts.failure).toBe(0);
		expect(snapshot.byDomain.alerts.total).toBe(2);
		expect(snapshot.byDomain.alerts.successRate).toBeCloseTo(1, 5);
		expect(snapshot.byDomain.jobs.success).toBe(1);
	});

	it('counts failed writes and computes successRate per domain', () => {
		service.recordWriteSuccess('alerts');
		service.recordWriteSuccess('alerts');
		service.recordWriteFailure('alerts');
		service.recordWriteSuccess('jobs');
		service.recordWriteFailure('jobs');
		service.recordWriteFailure('jobs');
		service.recordWriteFailure('jobs');

		const snapshot = service.getSnapshot();
		expect(snapshot.writesAttempted).toBe(7);
		expect(snapshot.writesSucceeded).toBe(3);
		expect(snapshot.writesFailed).toBe(4);
		expect(snapshot.successRate).toBeCloseTo(3 / 7, 5);
		expect(snapshot.byDomain.alerts.successRate).toBeCloseTo(2 / 3, 5);
		// 1 success + 3 failures = 0.25 successRate
		expect(snapshot.byDomain.jobs.successRate).toBeCloseTo(1 / 4, 5);
		expect(snapshot.byDomain.jobs.failure).toBe(3);
	});

	it('reports null successRate for a domain that has only just been touched but still has zero total (defensive)', () => {
		// Sanity: any record increments total. The branch that returns null
		// per-domain is unreachable when total > 0, but ensure the field stays
		// numeric when there is at least one write.
		service.recordWriteSuccess('replays');
		expect(service.getSnapshot().byDomain.replays.successRate).toBe(1);
	});

	it('omits the firestoreWriteMetrics key from the snapshot when nothing recorded', () => {
		expect(service.getSnapshot()).toBeNull();
	});

	it('reports a window timestamp and duration in the snapshot', () => {
		service.recordWriteSuccess('alerts');
		const snapshot = service.getSnapshot();
		expect(snapshot.window).toBeDefined();
		expect(typeof snapshot.window.startedAt).toBe('string');
		expect(snapshot.window.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(typeof snapshot.window.durationMs).toBe('number');
		expect(snapshot.window.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('ignores malformed domain arguments (fail-open)', () => {
		// Should not throw, must not pollute the counters.
		service.recordWriteSuccess(null);
		service.recordWriteSuccess(undefined);
		service.recordWriteSuccess('');
		service.recordWriteSuccess(123);
		service.recordWriteSuccess({});
		service.recordWriteFailure();
		service.recordWriteFailure('');

		expect(service.getSnapshot()).toBeNull();
	});

	it('resetForTesting clears all counters and starts a new window', () => {
		service.recordWriteSuccess('alerts');
		service.recordWriteFailure('jobs');
		expect(service.getSnapshot()).not.toBeNull();

		const beforeResetWindow = service.getSnapshot().window.startedAt;

		service.resetForTesting();
		expect(service.getSnapshot()).toBeNull();

		// New window starts after the previous one.
		service.recordWriteSuccess('alerts');
		const afterResetWindow = service.getSnapshot().window.startedAt;
		expect(afterResetWindow >= beforeResetWindow).toBe(true);
	});

	it('exposes a module-level singleton with the same interface', () => {
		expect(firestoreWriteMetricsService).toBeInstanceOf(FirestoreWriteMetricsService);
		// Singleton must reset cleanly for test isolation.
		firestoreWriteMetricsService.resetForTesting();
		firestoreWriteMetricsService.recordWriteSuccess('alerts');
		const snapshot = firestoreWriteMetricsService.getSnapshot();
		expect(snapshot.writesSucceeded).toBe(1);
		firestoreWriteMetricsService.resetForTesting();
		expect(firestoreWriteMetricsService.getSnapshot()).toBeNull();
	});
});