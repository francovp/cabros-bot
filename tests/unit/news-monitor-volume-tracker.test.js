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

		it('resets window counts and windowResetsAt when time expires', () => {
			const start = 1700000000000;
			const tracker = new NewsAlertVolumeTracker({ windowMs: 60000 });
			tracker.resetForTesting(start);

			tracker.recordDelivered(8, start + 1000);
			tracker.recordThrottled(4, start + 2000);

			const usageMid = tracker.getWindowUsage(start + 5000);
			expect(usageMid.alertsDelivered).toBe(8);
			expect(usageMid.alertsThrottled).toBe(4);
			expect(usageMid.windowResetsAt).toBe(new Date(start + 60000).toISOString());

			// After window expires (start + 60001)
			const usageExpired = tracker.getWindowUsage(start + 60001);
			expect(usageExpired.alertsDelivered).toBe(0);
			expect(usageExpired.alertsThrottled).toBe(0);
			expect(usageExpired.windowResetsAt).toBe(new Date(start + 60001 + 60000).toISOString());
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
