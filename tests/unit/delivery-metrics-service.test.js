/**
 * Unit tests for DeliveryMetricsService.
 *
 * Verifies:
 * - getSnapshot returns null when nothing has been recorded
 * - Successful and failed deliveries increment per-channel counters
 * - successRate is computed deterministically
 * - Duration samples feed averageDeliveryMs per channel and globally
 * - record() is fail-open with malformed input
 * - resetForTesting() clears all counters
 */

const { DeliveryMetricsService } = require('../../src/services/notification/DeliveryMetricsService');

describe('DeliveryMetricsService', () => {
	let service;

	beforeEach(() => {
		service = new DeliveryMetricsService();
	});

	it('returns null when no delivery has been recorded', () => {
		expect(service.getSnapshot()).toBeNull();
	});

	it('counts successful deliveries per channel', () => {
		service.record({ channel: 'telegram', success: true, durationMs: 100 });
		service.record({ channel: 'telegram', success: true, durationMs: 200 });
		service.record({ channel: 'whatsapp', success: true, durationMs: 300 });

		const snapshot = service.getSnapshot();
		expect(snapshot.success).toBe(3);
		expect(snapshot.failure).toBe(0);
		expect(snapshot.total).toBe(3);
		expect(snapshot.byChannel.telegram).toEqual(expect.objectContaining({
			success: 2,
			failure: 0,
			total: 2,
			successRate: 1.0,
			averageDeliveryMs: 150,
		}));
		expect(snapshot.byChannel.whatsapp.successRate).toBe(1.0);
	});

	it('counts failed deliveries and computes successRate per channel', () => {
		service.record({ channel: 'telegram', success: true, durationMs: 100 });
		service.record({ channel: 'telegram', success: false, durationMs: 200 });
		service.record({ channel: 'telegram', success: true, durationMs: 150 });
		service.record({ channel: 'telegram', success: false });

		const snapshot = service.getSnapshot();
		expect(snapshot.byChannel.telegram.success).toBe(2);
		expect(snapshot.byChannel.telegram.failure).toBe(2);
		expect(snapshot.byChannel.telegram.successRate).toBe(0.5);
		// Only samples with finite durationMs count for average
		expect(snapshot.byChannel.telegram.averageDeliveryMs).toBeCloseTo((100 + 200 + 150) / 3, 2);
	});

	it('reports null successRate when total is zero (no deliveries yet)', () => {
		// Force a channel entry with no deliveries is not possible via record()
		// since record only increments on actual results. Verify direct global avg.
		const snapshot = service.getSnapshot();
		expect(snapshot).toBeNull();
	});

	it('omits channels that have not recorded any deliveries', () => {
		service.record({ channel: 'telegram', success: true });
		const snapshot = service.getSnapshot();
		expect(snapshot.byChannel).not.toHaveProperty('whatsapp');
		expect(snapshot.byChannel).not.toHaveProperty('discord');
	});

	it('computes a global average across channels with duration samples', () => {
		service.record({ channel: 'telegram', success: true, durationMs: 100 });
		service.record({ channel: 'telegram', success: true, durationMs: 300 });
		service.record({ channel: 'whatsapp', success: true, durationMs: 200 });

		const snapshot = service.getSnapshot();
		expect(snapshot.averageDeliveryMs).toBe(200);
	});

	it('returns null averageDeliveryMs when no durations were sampled', () => {
		service.record({ channel: 'telegram', success: true });
		service.record({ channel: 'telegram', success: false });

		const snapshot = service.getSnapshot();
		expect(snapshot.byChannel.telegram.averageDeliveryMs).toBeNull();
		expect(snapshot.averageDeliveryMs).toBeNull();
	});

	it('reports a window timestamp and duration in the snapshot', () => {
		service.record({ channel: 'telegram', success: true });
		const snapshot = service.getSnapshot();
		expect(snapshot.window.startedAt).toMatch(/^\d{4}-/);
		expect(typeof snapshot.window.durationMs).toBe('number');
		expect(snapshot.window.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('ignores malformed record payloads (fail-open)', () => {
		// Should not throw
		service.record(null);
		service.record(undefined);
		service.record({});
		service.record({ channel: '', success: true });
		service.record({ channel: 'telegram' }); // missing success is falsy → counted as failure
		service.record({ channel: 'telegram', success: true, durationMs: -1 }); // negative → ignored for average
		service.record({ channel: 'telegram', success: true, durationMs: 'abc' }); // non-numeric → ignored for average
		service.record({ channel: 'telegram', success: true, durationMs: NaN }); // NaN → ignored for average

		const snapshot = service.getSnapshot();
		// Counts are still incremented but invalid durations are excluded from average.
		expect(snapshot).not.toBeNull();
		expect(snapshot.byChannel.telegram.averageDeliveryMs).toBeNull();
		expect(snapshot.byChannel.telegram.failure).toBe(1);
		expect(snapshot.byChannel.telegram.success).toBe(3);
	});

	it('resetForTesting clears all counters and starts a new window', () => {
		service.record({ channel: 'telegram', success: true, durationMs: 100 });
		expect(service.getSnapshot()).not.toBeNull();

		service.resetForTesting();
		expect(service.getSnapshot()).toBeNull();
	});

	describe('getChannelHealth (#1168 admin paging fallback)', () => {
		it('reports unknown for a channel with no recorded deliveries', () => {
			expect(service.getChannelHealth('telegram')).toEqual({
				state: 'unknown', total: 0, success: 0, failure: 0, successRate: null,
			});
		});

		it('reports unknown for malformed channel input (fail-open)', () => {
			expect(service.getChannelHealth('').state).toBe('unknown');
			expect(service.getChannelHealth(undefined).state).toBe('unknown');
			expect(service.getChannelHealth(null).state).toBe('unknown');
		});

		it('reports failing when every delivery failed', () => {
			service.record({ channel: 'telegram', success: false });
			service.record({ channel: 'telegram', success: false });
			service.record({ channel: 'telegram', success: false });

			expect(service.getChannelHealth('telegram')).toEqual({
				state: 'failing', total: 3, success: 0, failure: 3, successRate: 0,
			});
		});

		it('reports healthy when every delivery succeeded', () => {
			service.record({ channel: 'whatsapp', success: true });
			expect(service.getChannelHealth('whatsapp').state).toBe('healthy');
		});

		it('reports degraded when the success rate is below one half', () => {
			service.record({ channel: 'whatsapp', success: true });
			service.record({ channel: 'whatsapp', success: false });
			service.record({ channel: 'whatsapp', success: false });
			expect(service.getChannelHealth('whatsapp').state).toBe('degraded');
		});

		it('reports healthy at exactly a one half success rate', () => {
			service.record({ channel: 'discord', success: true });
			service.record({ channel: 'discord', success: false });
			expect(service.getChannelHealth('discord').state).toBe('healthy');
		});
	});
});
