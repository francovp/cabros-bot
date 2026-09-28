/**
 * DeliveryMetricsService - tracks in-memory per-channel delivery counters
 * and latencies for the alert delivery SLA exposed through /api/status.
 *
 * Counters reset on process restart (acceptable for operational monitoring).
 * Fail-open: all methods swallow errors so metric tracking never blocks delivery.
 */

class DeliveryMetricsService {
	constructor() {
		this.windowStartedAt = Date.now();
		// Map<channel, { success: number, failure: number, totalDurationMs: number, samples: number }>
		this.channelCounters = new Map();
	}

	_ensureChannel(channel) {
		if (!this.channelCounters.has(channel)) {
			this.channelCounters.set(channel, {
				success: 0,
				failure: 0,
				totalDurationMs: 0,
				samples: 0,
			});
		}
		return this.channelCounters.get(channel);
	}

	record(result) {
		try {
			if (!result || typeof result !== 'object') {
				return;
			}
			const { channel, success, durationMs } = result;
			if (typeof channel !== 'string' || channel.length === 0) {
				return;
			}
			const counters = this._ensureChannel(channel);
			if (success === true) {
				counters.success += 1;
			} else {
				counters.failure += 1;
			}
			if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
				counters.totalDurationMs += durationMs;
				counters.samples += 1;
			}
		} catch (error) {
			// Fail-open: metric recording must never throw
			console.warn('[DeliveryMetricsService] record failed:', error.message);
		}
	}

	getSnapshot() {
		let totalSuccess = 0;
		let totalFailure = 0;
		const byChannel = {};

		for (const [channel, counters] of this.channelCounters.entries()) {
			if (counters.success === 0 && counters.failure === 0) {
				continue;
			}
			const total = counters.success + counters.failure;
			const averageDeliveryMs = counters.samples > 0
				? Number((counters.totalDurationMs / counters.samples).toFixed(2))
				: null;
			byChannel[channel] = {
				success: counters.success,
				failure: counters.failure,
				total,
				successRate: total > 0 ? Number((counters.success / total).toFixed(4)) : null,
				averageDeliveryMs,
			};
			totalSuccess += counters.success;
			totalFailure += counters.failure;
		}

		if (totalSuccess === 0 && totalFailure === 0) {
			return null;
		}

		const totalDeliveries = totalSuccess + totalFailure;
		return {
			window: {
				startedAt: new Date(this.windowStartedAt).toISOString(),
				durationMs: Date.now() - this.windowStartedAt,
			},
			success: totalSuccess,
			failure: totalFailure,
			total: totalDeliveries,
			successRate: totalDeliveries > 0
				? Number((totalSuccess / totalDeliveries).toFixed(4))
				: null,
			averageDeliveryMs: this._globalAverage(),
			byChannel,
		};
	}

	_globalAverage() {
		let totalDuration = 0;
		let totalSamples = 0;
		for (const counters of this.channelCounters.values()) {
			totalDuration += counters.totalDurationMs;
			totalSamples += counters.samples;
		}
		return totalSamples > 0
			? Number((totalDuration / totalSamples).toFixed(2))
			: null;
	}

	resetForTesting() {
		this.windowStartedAt = Date.now();
		this.channelCounters.clear();
	}
}

const deliveryMetricsService = new DeliveryMetricsService();

module.exports = {
	DeliveryMetricsService,
	deliveryMetricsService,
};
