'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const { sendErrorFrom } = require('../../lib/errorEnvelope');

const EVENT_LOOP_SAMPLE_COUNT = 5;
const MAX_SAFE_LAG_MS = 60000;
const MAX_SAFE_UPTIME_SECONDS = 2_592_000_000;
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
	if (value < 0 || value > MAX_SAFE_UPTIME_SECONDS) return null;
	return Number(value.toFixed(3));
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
		let immediate;
		const finish = () => {
			if (resolved) return;
			resolved = true;
			clearTimeout(safetyTimer);
			clearImmediate(immediate);
			resolve({
				lagMs: samples.length ? toFiniteMillis(samples.reduce((sum, n) => sum + n, 0) / samples.length) : null,
				maxLagMs: samples.length ? toFiniteMillis(Math.max(...samples)) : null,
				samples: samples.length,
			});
		};
		const schedule = () => {
			try {
				const start = process.hrtime.bigint();
				immediate = setImmediate(() => {
					if (resolved) return;
					try {
						samples.push(Number(process.hrtime.bigint() - start) / 1e6);
						if (samples.length >= EVENT_LOOP_SAMPLE_COUNT) finish();
						else schedule();
					} catch (_) {
						finish();
					}
				});
			} catch (_) {
				finish();
			}
		};
		const safetyTimer = setTimeout(finish, EVENT_LOOP_SAMPLE_TIMEOUT_MS);
		safetyTimer.unref?.();
		schedule();
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
		return sendErrorFrom(res, 500, {
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		}, { req });
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
