'use strict';

const crypto = require('crypto');

const MIN_JITTER_MS = 0;
const MAX_JITTER_MS = 30000;
const DEFAULT_JITTER_MS = 5000;

/**
 * Resolve a bounded startup-jitter value from the optional env override,
 * runtime remote-config override, or hard-coded default. Out-of-range and
 * non-finite inputs fall back to the default without throwing, mirroring
 * the fail-open contract used elsewhere in the runtime config layer.
 *
 * @param {object} options
 * @param {string} [options.envVar] env var name (e.g. "WORKER_STARTUP_JITTER_MS")
 * @param {string} [options.runtimeKey] runtime config key (e.g. "WORKER_STARTUP_JITTER_MS")
 * @param {number} [options.defaultValue=5000] value used when env and runtime are absent
 * @returns {number} integer jitter in `[0, 30000]` milliseconds
 */
function resolveStartupJitterMs(options = {}) {
	const envVar = options.envVar || null;
	const runtimeKey = options.runtimeKey || envVar;
	const defaultValue = Number.isFinite(options.defaultValue)
		? options.defaultValue
		: DEFAULT_JITTER_MS;

	if (envVar && typeof process.env[envVar] === 'string' && process.env[envVar].trim() !== '') {
		const parsed = Number.parseInt(process.env[envVar], 10);
		if (Number.isFinite(parsed)) {
			return clampJitter(parsed);
		}
	}

	if (runtimeKey) {
		try {
			const { getRuntimeConfig } = require('../services/remoteConfig/RemoteConfigService');
			const runtimeValue = getRuntimeConfig()[runtimeKey];
			if (Number.isFinite(runtimeValue)) {
				return clampJitter(runtimeValue);
			}
		} catch (error) {
			// Remote config unavailable - fall back to env / default.
		}
	}

	return clampJitter(defaultValue);
}

function clampJitter(value) {
	if (!Number.isFinite(value) || value < MIN_JITTER_MS) {
		return MIN_JITTER_MS;
	}
	if (value > MAX_JITTER_MS) {
		return MAX_JITTER_MS;
	}
	return Math.floor(value);
}

/**
 * Wait for a per-in-random delay inside `[0, maxJitterMs]`. Returns 0 when
 * jitter is disabled (`maxJitterMs <= 0`) so callers can `await` it without
 * an extra branch. The delay is unref'd so it never blocks shutdown.
 *
 * @param {number} maxJitterMs upper bound in milliseconds (clamped to `[0, 30000]`)
 * @returns {Promise<number>} the actual jitter applied, in milliseconds
 */
async function applyStartupJitter(maxJitterMs) {
	const upper = clampJitter(maxJitterMs);
	if (upper <= 0) {
		return 0;
	}
	const delay = crypto.randomInt(0, upper + 1);
	if (delay === 0) {
		return 0;
	}
	await new Promise((resolve) => {
		const timer = setTimeout(resolve, delay);
		if (typeof timer.unref === 'function') {
			timer.unref();
		}
	});
	return delay;
}

module.exports = {
	applyStartupJitter,
	resolveStartupJitterMs,
	clampJitter,
	MIN_JITTER_MS,
	MAX_JITTER_MS,
	DEFAULT_JITTER_MS,
};