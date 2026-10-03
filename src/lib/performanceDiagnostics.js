'use strict';

const { monitorEventLoopDelay } = require('node:perf_hooks');

function createPerformanceDiagnostics({ resolution = 20 } = {}) {
	const histogram = monitorEventLoopDelay({ resolution });
	histogram.enable();

	return {
		snapshot() {
			const memory = process.memoryUsage();
			const mean = histogram.mean / 1e6;
			const p99 = histogram.percentile(99) / 1e6;
			return {
				eventLoopLagMs: Number((Number.isFinite(mean) ? mean : 0).toFixed(3)),
				eventLoopLagP99Ms: Number((Number.isFinite(p99) ? p99 : 0).toFixed(3)),
				heapUsedBytes: memory.heapUsed,
				rssBytes: memory.rss,
			};
		},
		close() {
			histogram.disable();
		},
	};
}

const performanceDiagnostics = createPerformanceDiagnostics();

function performanceDiagnosticsHandler(req, res) {
	return res.status(200).json({ success: true, ...performanceDiagnostics.snapshot() });
}

module.exports = { createPerformanceDiagnostics, performanceDiagnosticsHandler };
