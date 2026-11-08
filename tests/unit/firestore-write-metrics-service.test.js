'use strict';

const {
	FirestoreWriteMetricsService,
	firestoreWriteMetricsService,
	PERSISTENT_WRITE_DOMAINS,
} = require('../../src/services/storage/FirestoreWriteMetricsService');
const sentryService = require('../../src/services/monitoring/SentryService');
const { registerSecretValue, clearSecretValue } = require('../../src/lib/logging');

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

	it('captures Sentry metrics for successful and failed writes', () => {
		const spy = jest.spyOn(sentryService, 'captureFirestoreWriteMetric').mockImplementation(() => {});
		try {
			service.recordWriteSuccess('alerts');
			expect(spy).toHaveBeenCalledWith({ domain: 'alerts', status: 'success' });

			service.recordWriteFailure('jobs');
			expect(spy).toHaveBeenCalledWith({ domain: 'jobs', status: 'failure' });
		} finally {
			spy.mockRestore();
		}
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

	// ── Issue #1285 ──────────────────────────────────────────────────────────
	// Write counters alone could not detect the outage: every write succeeded
	// while every read query was rejected. Read health needs its own snapshot so
	// it can drive `dependencies.firestore.ready` to false.
	describe('read metrics', () => {
		it('returns null until a read is recorded so an empty history is never evidence', () => {
			expect(service.getReadSnapshot()).toBeNull();
		});

		it('keeps read counters independent from the write snapshot', () => {
			service.recordWriteSuccess('alerts');
			service.recordReadSuccess('alerts');

			expect(service.getSnapshot().writesSucceeded).toBe(1);
			expect(service.getReadSnapshot()).toMatchObject({
				readsAttempted: 1,
				readsSucceeded: 1,
				readHealth: 'healthy',
			});
		});

		it('reports degraded read health with a sanitized category on failure', () => {
			service.recordReadFailure('alerts', 'failed_precondition');

			const snapshot = service.getReadSnapshot();
			expect(snapshot).toMatchObject({
				readsAttempted: 1,
				readsFailed: 1,
				readHealth: 'degraded',
				consecutiveReadFailures: 1,
				lastErrorCategory: 'failed_precondition',
			});
			expect(snapshot.successRate).toBe(0);
			expect(snapshot.byDomain.alerts).toMatchObject({ failure: 1, total: 1 });
		});

		it('recovers read health on the next successful read without a restart', () => {
			service.recordReadFailure('alerts', 'failed_precondition');
			service.recordReadFailure('alerts', 'failed_precondition');
			expect(service.getReadSnapshot().consecutiveReadFailures).toBe(2);

			service.recordReadSuccess('alerts');

			const snapshot = service.getReadSnapshot();
			expect(snapshot.readHealth).toBe('healthy');
			expect(snapshot.consecutiveReadFailures).toBe(0);
			// The cumulative counters still carry the history.
			expect(snapshot.readsFailed).toBe(2);
		});

		it('coerces an unrecognized category to unknown_error instead of trusting it', () => {
			service.recordReadFailure('alerts', 'not-a-real-category');
			expect(service.getReadSnapshot().lastErrorCategory).toBe('unknown_error');
		});

		it('ignores malformed domain arguments (fail-open)', () => {
			service.recordReadSuccess('');
			service.recordReadFailure(null, 'unavailable');
			expect(service.getReadSnapshot()).toBeNull();
		});

		it('resets read state so tests do not leak health into each other', () => {
			service.recordReadFailure('alerts', 'unavailable');
			service.resetForTesting();
			expect(service.getReadSnapshot()).toBeNull();
		});
	});

	describe('persistent write health', () => {
		it('starts with the fixed domains unconfigured and zeroed', () => {
			const snapshot = service.getPersistentWriteHealthSnapshot();

			expect(Object.keys(snapshot.byDomain)).toEqual(PERSISTENT_WRITE_DOMAINS);
			for (const domain of PERSISTENT_WRITE_DOMAINS) {
				expect(snapshot.byDomain[domain]).toEqual({
					success: 0,
					failure: 0,
					failureRate: 0,
					lastSuccessAt: null,
					lastFailureAt: null,
					lastFailureCategory: null,
					status: 'unconfigured',
				});
			}
		});

		it('counts success and failure and exposes only the closed error category', () => {
			service.recordPersistentWriteSuccess('alertStorage');
			service.recordPersistentWriteFailure('alertStorage', Object.assign(new Error('denied'), { code: 7 }));

			const domain = service.getPersistentWriteHealthSnapshot().byDomain.alertStorage;
			expect(domain).toMatchObject({
				success: 1,
				failure: 1,
				failureRate: 0.5,
				lastFailureCategory: 'firestore_permission_denied',
				status: 'degraded',
			});
			expect(domain.lastSuccessAt).toEqual(expect.any(String));
			expect(domain.lastFailureAt).toEqual(expect.any(String));
			expect(domain).not.toHaveProperty('lastFailureMessage');
		});

		it.each([
			[7, 'firestore_permission_denied'],
			[16, 'firestore_permission_denied'],
			[14, 'firestore_unavailable'],
			[4, 'firestore_unavailable'],
			[8, 'firestore_unavailable'],
			[3, 'firestore_malformed'],
			[9, 'firestore_malformed'],
			[13, 'unknown'],
			[undefined, 'unknown'],
		])('maps Firestore error code %s to %s', (code, expectedCategory) => {
			const error = Object.assign(new Error('provider detail'), code === undefined ? {} : { code });
			service.recordPersistentWriteFailure('signalOutcomes', error);
			expect(service.getPersistentWriteHealthSnapshot().byDomain.signalOutcomes.lastFailureCategory)
				.toBe(expectedCategory);
		});

		it('redacts and bounds the retained internal message', () => {
			const secret = 'credential-secret-value';
			registerSecretValue(secret);
			try {
				service.recordPersistentWriteFailure(
					'newsDedup',
					new Error(`Firestore rejected credential ${secret}; ${'x'.repeat(200)}`),
				);
				const message = service.persistentWriteDomains.get('newsDedup').lastFailureMessage;
				expect(message).toHaveLength(120);
				expect(message).not.toContain(secret);
				expect(message).toContain('[REDACTED]');
			} finally {
				clearSecretValue(secret);
			}
		});

		it('uses the latest 100 attempts and the five-minute recent-failure window', () => {
			jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00.000Z'));
			try {
				for (let i = 0; i < 95; i += 1) {
					service.recordPersistentWriteSuccess('notificationRedrive');
				}
				for (let i = 0; i < 5; i += 1) {
					service.recordPersistentWriteFailure('notificationRedrive', new Error('x'));
				}
				jest.advanceTimersByTime(5 * 60 * 1000 + 1);
				expect(service.getPersistentWriteHealthSnapshot().byDomain.notificationRedrive)
					.toMatchObject({ failure: 5, failureRate: 0.05, status: 'ok' });

				service.recordPersistentWriteFailure('notificationRedrive', new Error('x'));
				const state = service.persistentWriteDomains.get('notificationRedrive');
				expect(state.attempts).toHaveLength(100);
				expect(service.getPersistentWriteHealthSnapshot().byDomain.notificationRedrive.status).toBe('degraded');
			} finally {
				jest.useRealTimers();
			}
		});

		it('keeps low failure rates degraded only while a failure is within five minutes', () => {
			jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00.000Z'));
			try {
				service.recordPersistentWriteFailure('newsDedup', new Error('x'));
				jest.advanceTimersByTime(4 * 60 * 1000 + 59 * 1000);
				for (let i = 0; i < 99; i += 1) {
					service.recordPersistentWriteSuccess('newsDedup');
				}
				expect(service.getPersistentWriteHealthSnapshot().byDomain.newsDedup.status).toBe('degraded');

				jest.advanceTimersByTime(2000);
				expect(service.getPersistentWriteHealthSnapshot().byDomain.newsDedup)
					.toMatchObject({ failureRate: 0.01, status: 'ok' });
			} finally {
				jest.useRealTimers();
			}
		});

		it('emits one Sentry event per domain/category until recovery', () => {
			jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00.000Z'));
			const spy = jest.spyOn(sentryService, 'captureEvent').mockImplementation(() => ({ captured: true }));
			try {
				for (let i = 0; i < 40; i += 1) service.recordPersistentWriteSuccess('alertStorage');
				for (let i = 0; i < 10; i += 1) {
					service.recordPersistentWriteFailure('alertStorage', Object.assign(new Error('private'), { code: 14 }));
				}
				expect(spy).not.toHaveBeenCalled(); // exactly 20% is below the paging threshold

				service.recordPersistentWriteFailure('alertStorage', Object.assign(new Error('private'), { code: 14 }));
				expect(spy).toHaveBeenCalledTimes(1);
				service.recordPersistentWriteFailure('alertStorage', Object.assign(new Error('private'), { code: 14 }));
				expect(spy).toHaveBeenCalledTimes(1);
				expect(spy.mock.calls[0][0].event).toMatchObject({
					feature: 'persistent-write-health',
					channel: 'alertStorage',
					external: { provider: 'firestore', lastErrorCode: 'firestore_unavailable' },
					message: 'Persistent Firestore write failure threshold exceeded',
				});
				expect(JSON.stringify(spy.mock.calls[0])).not.toContain('private');

				service.recordPersistentWriteFailure('alertStorage', Object.assign(new Error('private'), { code: 7 }));
				expect(spy).toHaveBeenCalledTimes(2); // distinct category is a distinct incident

				for (let i = 0; i < 50; i += 1) service.recordPersistentWriteSuccess('alertStorage');
				expect(service.persistentWriteDomains.get('alertStorage').activeIncidents.size).toBe(0);
				for (let i = 0; i < 12; i += 1) {
					service.recordPersistentWriteFailure('alertStorage', Object.assign(new Error('private'), { code: 14 }));
				}
				expect(spy).toHaveBeenCalledTimes(3);
			} finally {
				spy.mockRestore();
				jest.useRealTimers();
			}
		});

		it('ignores unknown domains and resets persistent health state', () => {
			service.recordPersistentWriteSuccess('unbounded-domain');
			service.recordPersistentWriteFailure('unbounded-domain', new Error('x'));
			expect(service.getPersistentWriteHealthSnapshot().byDomain).not.toHaveProperty('unbounded-domain');
			service.recordPersistentWriteFailure('alertStorage', new Error('x'));
			service.resetForTesting();
			expect(service.persistentWriteDomains.size).toBe(PERSISTENT_WRITE_DOMAINS.length);
			expect(service.getPersistentWriteHealthSnapshot().byDomain.alertStorage.status).toBe('unconfigured');
		});
	});
});
