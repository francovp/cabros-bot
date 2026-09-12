'use strict';

const {
	NewsAlertVolumeTracker,
	getVolumeTracker,
	resetVolumeTrackerForTesting,
	parseNewsMaxAlertsPerBatch,
	parseNewsMaxAlertsPerWindow,
	parseNewsMaxAlertsPerWindowMs,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/volumeTracker');

describe('NewsAlertVolumeTracker', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.NEWS_MAX_ALERTS_PER_BATCH;
		delete process.env.NEWS_MAX_ALERTS_PER_WINDOW;
		delete process.env.NEWS_MAX_ALERTS_PER_WINDOW_MS;
		resetVolumeTrackerForTesting();
	});

	afterEach(() => {
		Object.keys(process.env).forEach((k) => delete process.env[k]);
		Object.assign(process.env, originalEnv);
	});

	describe('default behavior and initialization', () => {
		it('initializes with zero delivered, zero throttled, and valid reset time', () => {
			const now = 1700000000000;
			const tracker = new NewsAlertVolumeTracker();
			tracker.resetForTesting(now);

			const usage = tracker.getWindowUsage(now);
			expect(usage.alertsDelivered).toBe(0);
			expect(usage.alertsThrottled).toBe(0);
			expect(usage.windowResetsAt).toBe(new Date(now + 300000).toISOString());
			expect(tracker.getMaxAlertsPerBatch()).toBe(10);
			expect(tracker.getMaxAlertsPerWindow()).toBe(20);
			expect(tracker.getWindowMs()).toBe(300000);
		});

		it('calculates available quota correctly', () => {
			const tracker = new NewsAlertVolumeTracker();
			expect(tracker.getRemainingWindowQuota()).toBe(20);
			expect(tracker.getEffectiveBatchCapacity()).toBe(10);

			tracker.recordDelivered(3);
			expect(tracker.getRemainingWindowQuota()).toBe(17);
			expect(tracker.getEffectiveBatchCapacity()).toBe(10);

			tracker.recordDelivered(12); // total 15
			expect(tracker.getRemainingWindowQuota()).toBe(5);
			expect(tracker.getEffectiveBatchCapacity()).toBe(5); // capped by remaining window quota

			tracker.recordDelivered(5); // total 20 (exhausted)
			expect(tracker.getRemainingWindowQuota()).toBe(0);
			expect(tracker.getEffectiveBatchCapacity()).toBe(0);
		});

		it('records throttled alerts without consuming window quota', () => {
			const tracker = new NewsAlertVolumeTracker();
			tracker.recordThrottled(5);

			const usage = tracker.getWindowUsage();
			expect(usage.alertsDelivered).toBe(0);
			expect(usage.alertsThrottled).toBe(5);
			expect(tracker.getRemainingWindowQuota()).toBe(20);
		});

		it('resets window counts and windowResetsAt when time expires per sliding window', () => {
			const start = 1700000000000;
			const tracker = new NewsAlertVolumeTracker({ windowMs: 60000 });
			tracker.resetForTesting(start);

			tracker.recordDelivered(8, start + 1000);
			tracker.recordThrottled(4, start + 2000);

			const usageMid = tracker.getWindowUsage(start + 5000);
			expect(usageMid.alertsDelivered).toBe(8);
			expect(usageMid.alertsThrottled).toBe(4);
			expect(usageMid.windowResetsAt).toBe(new Date(start + 1000 + 60000).toISOString());

			// After first delivery expires (start + 61001)
			const usageDeliveredExpired = tracker.getWindowUsage(start + 61001);
			expect(usageDeliveredExpired.alertsDelivered).toBe(0);
			expect(usageDeliveredExpired.alertsThrottled).toBe(4); // throttled at start + 2000 expires at start + 62000

			// After throttled alerts also expire (start + 62001)
			const usageAllExpired = tracker.getWindowUsage(start + 62001);
			expect(usageAllExpired.alertsDelivered).toBe(0);
			expect(usageAllExpired.alertsThrottled).toBe(0);
			expect(usageAllExpired.windowResetsAt).toBe(new Date(start + 62001 + 60000).toISOString());
		});

		it('enforces sliding window limits across window boundaries', () => {
			const start = 1700000000000;
			const tracker = new NewsAlertVolumeTracker({ maxAlertsPerWindow: 20, maxAlertsPerBatch: 20, windowMs: 60000 });
			tracker.resetForTesting(start);

			// Deliver 10 at T=10s
			tracker.recordDelivered(10, start + 10000);
			expect(tracker.getRemainingWindowQuota(start + 15000)).toBe(10);

			// Deliver 10 at T=50s (quota is now full: 20 delivered in last 60s)
			tracker.recordDelivered(10, start + 50000);
			expect(tracker.getRemainingWindowQuota(start + 55000)).toBe(0);

			// At T=65s (5s after fixed 60s boundary):
			// Old 10 from T=10s are not yet expired (< 60s since 10s: expires at 70s).
			expect(tracker.getRemainingWindowQuota(start + 65000)).toBe(0);

			// At T=71s:
			// The 10 from T=10s have expired (> 60s). Only 10 from T=50s remain in window!
			expect(tracker.getRemainingWindowQuota(start + 71000)).toBe(10);
			expect(tracker.getWindowUsage(start + 71000).alertsDelivered).toBe(10);
		});

		describe('capacity reservations', () => {
			it('synchronously reserves capacity and reduces available quota', () => {
				const tracker = new NewsAlertVolumeTracker({ maxAlertsPerWindow: 20 });
				expect(tracker.getRemainingWindowQuota()).toBe(20);

				const reservation = tracker.reserveCapacity(5);
				expect(reservation).toBeDefined();
				expect(reservation.count).toBe(5);
				expect(tracker.getRemainingWindowQuota()).toBe(15);

				// Committing converts reservation into actual deliveries
				tracker.commitReservation(reservation, 3);
				expect(tracker.getRemainingWindowQuota()).toBe(17);
				expect(tracker.getWindowUsage().alertsDelivered).toBe(3);
			});

			it('releases capacity when delivery is cancelled or fails', () => {
				const tracker = new NewsAlertVolumeTracker({ maxAlertsPerWindow: 20 });
				const reservation = tracker.reserveCapacity(5);
				expect(tracker.getRemainingWindowQuota()).toBe(15);

				tracker.releaseReservation(reservation);
				expect(tracker.getRemainingWindowQuota()).toBe(20);
			});

			it('caps reservation at remaining window quota', () => {
				const tracker = new NewsAlertVolumeTracker({ maxAlertsPerWindow: 5 });
				tracker.recordDelivered(3);
				expect(tracker.getRemainingWindowQuota()).toBe(2);

				const reservation = tracker.reserveCapacity(10);
				expect(reservation.count).toBe(2);
				expect(tracker.getRemainingWindowQuota()).toBe(0);

				const secondReservation = tracker.reserveCapacity(5);
				expect(secondReservation).toBeNull();
			});
		});
	});

	describe('configuration parsing', () => {
		describe('parseNewsMaxAlertsPerBatch', () => {
			it('parses valid integer strings within 1-50', () => {
				expect(parseNewsMaxAlertsPerBatch('1')).toBe(1);
				expect(parseNewsMaxAlertsPerBatch('10')).toBe(10);
				expect(parseNewsMaxAlertsPerBatch('50')).toBe(50);
				expect(parseNewsMaxAlertsPerBatch('  25  ')).toBe(25);
			});

			it('returns fallback for out of range or invalid inputs', () => {
				expect(parseNewsMaxAlertsPerBatch('0')).toBe(10);
				expect(parseNewsMaxAlertsPerBatch('51')).toBe(10);
				expect(parseNewsMaxAlertsPerBatch('-5')).toBe(10);
				expect(parseNewsMaxAlertsPerBatch('abc')).toBe(10);
				expect(parseNewsMaxAlertsPerBatch('')).toBe(10);
				expect(parseNewsMaxAlertsPerBatch(undefined)).toBe(10);
			});
		});

		describe('parseNewsMaxAlertsPerWindow', () => {
			it('parses valid integer strings within 1-200', () => {
				expect(parseNewsMaxAlertsPerWindow('1')).toBe(1);
				expect(parseNewsMaxAlertsPerWindow('20')).toBe(20);
				expect(parseNewsMaxAlertsPerWindow('200')).toBe(200);
			});

			it('returns fallback for out of range or invalid inputs', () => {
				expect(parseNewsMaxAlertsPerWindow('0')).toBe(20);
				expect(parseNewsMaxAlertsPerWindow('201')).toBe(20);
				expect(parseNewsMaxAlertsPerWindow('xyz')).toBe(20);
				expect(parseNewsMaxAlertsPerWindow(undefined)).toBe(20);
			});
		});

		describe('parseNewsMaxAlertsPerWindowMs', () => {
			it('parses valid integer strings within 1000-3600000', () => {
				expect(parseNewsMaxAlertsPerWindowMs('1000')).toBe(1000);
				expect(parseNewsMaxAlertsPerWindowMs('300000')).toBe(300000);
				expect(parseNewsMaxAlertsPerWindowMs('3600000')).toBe(3600000);
			});

			it('returns fallback for out of range or invalid inputs', () => {
				expect(parseNewsMaxAlertsPerWindowMs('500')).toBe(300000);
				expect(parseNewsMaxAlertsPerWindowMs('4000000')).toBe(300000);
				expect(parseNewsMaxAlertsPerWindowMs('foo')).toBe(300000);
				expect(parseNewsMaxAlertsPerWindowMs(undefined)).toBe(300000);
			});
		});
	});
});
