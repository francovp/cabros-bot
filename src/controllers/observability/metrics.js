'use strict';

const sentryService = require('../../services/monitoring/SentryService');

const EVENT_LOOP_SAMPLE_COUNT = 5;
const MAX_SAFE_LAG_MS = 60000;
const MAX_SAFE_UPTIME_MS = 2_592_000_000;
const EVENT_LOOP_SAMPLE_TIMEOUT_MS = 1000;

function toFiniteNumber(value, fallback) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return typeof fallback === 'number' ? fallback : 0;
	}
	return value;
}

function toFiniteMillis(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (value < 0 || value > MAX_SAFE_LAG_MS) return null;
	return Number(value.toFixed(3));
}

function toFiniteSeconds(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (value < 0 || value > MAX_SAFE_UPTIME_MS) return null;
	return Number((value / 1000).toFixed(3));
}

function collectMemory() {
	let usage;
	try {
		usage = process.memoryUsage();
	} catch (_) {
		return null;
	}
	if (!usage || typeof usage !== 'object') return null;
	return {
		rss: toFiniteNumber(usage.rss),
		heapUsed: toFiniteNumber(usage.heapUsed),
		heapTotal: toFiniteNumber(usage.heapTotal),
		external: toFiniteNumber(usage.external),
		arrayBuffers: toFiniteNumber(usage.arrayBuffers),
	};
}

function collectCpu() {
	let usageInfo;
	try {
		usageInfo = process.cpuUsage();
	} catch (_) {
		return null;
	}
	if (!usageInfo || typeof usageInfo !== 'object') return null;
	return {
		user: toFiniteNumber(usageInfo.user),
		system: toFiniteNumber(usageInfo.system),
	};
}

function collectProcess() {
	let activeHandles = 0;
	let activeRequests = 0;
	try {
		if (typeof process._getActiveHandles === 'function') {
			activeHandles = process._getActiveHandles().length;
		}
		if (typeof process._getActiveRequests === 'function') {
			activeRequests = process._getActiveRequests().length;
		}
	} catch (_) {
		// node internals may not be available in some sandboxes
	}
	return {
		pid: typeof process.pid === 'number' ? process.pid : null,
		uptime: toFiniteSeconds(process.uptime()),
		nodeVersion: typeof process.version === 'string' ? process.version : null,
		platform: typeof process.platform === 'string' ? process.platform : null,
		activeHandles: toFiniteNumber(activeHandles),
		activeRequests: toFiniteNumber(activeRequests),
	};
}

function measureEventLoopLag() {
	return new Promise((resolve) => {
		const samples = [];
		let resolved = false;

		const finish = () => {
			if (resolved) return;
			resolved = true;
			if (samples.length === 0) {
				resolve({ lagMs: null, maxLagMs: null, samples: 0 });
				return;
			}
			const sorted = samples.slice().sort((a, b) => a - b);
			const sum = sorted.reduce((acc, n) => acc + n, 0);
			const mean = sum / sorted.length;
			const max = sorted[sorted.length - 1];
			resolve({
				lagMs: toFiniteMillis(mean),
				maxLagMs: toFiniteMillis(max),
				samples: sorted.length,
			});
		};

		const safetyTimer = setTimeout(finish, EVENT_LOOP_SAMPLE_TIMEOUT_MS);
		if (safetyTimer && typeof safetyTimer.unref === 'function') {
			safetyTimer.unref();
		}

		const sample = (start) => {
			let delta = 0;
			try {
				if (process.hrtime && process.hrtime.bigint) {
					delta = Number(process.hrtime.bigint() - start) / 1e6;
				}
			} catch (_) {
				delta = 0;
			}
			samples.push(delta);
			if (samples.length >= EVENT_LOOP_SAMPLE_COUNT) {
				finish();
				return;
			}
			setImmediate(() => sample(process.hrtime.bigint()));
		};

		try {
			setImmediate(() => sample(process.hrtime.bigint()));
		} catch (_) {
			finish();
		}
	});
}

async function collectMetrics() {
	const memory = collectMemory();
	const cpu = collectCpu();
	const processInfo = collectProcess();
	let eventLoop = { lagMs: null, maxLagMs: null, samples: 0 };
	try {
		eventLoop = await measureEventLoopLag();
	} catch (_) {
		// keep neutral defaults
	}
	return {
		uptime: processInfo.uptime,
		memory,
		cpu,
		eventLoop,
		process: processInfo,
		node: processInfo.nodeVersion,
	};
}

async function getMetrics(req, res) {
	try {
		const metrics = await collectMetrics();
		return res.status(200).json({ success: true, ...metrics });
	} catch (error) {
		console.error('[MetricsController] Failed to collect process metrics:', error.message);
		try {
			sentryService.captureRuntimeError({
				channel: 'metrics-controller',
				feature: 'observability',
				error,
				http: {
					endpoint: '/api/metrics',
					method: req.method,
					statusCode: 500,
				},
			});
		} catch (_) {
			// fail-safe
		}
		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

module.exports = {
	getMetrics,
	collectMetrics,
	collectMemory,
	collectCpu,
	collectProcess,
	measureEventLoopLag,
	toFiniteNumber,
	toFiniteMillis,
	toFiniteSeconds,
};
