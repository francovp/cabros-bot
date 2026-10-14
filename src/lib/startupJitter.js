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
	const runtimeKey = Object.prototype.hasOwnProperty.call(options, 'runtimeKey')
		? options.runtimeKey
		: envVar;
	const globalEnvVar = options.globalEnvVar || null;
	const globalRuntimeKey = Object.prototype.hasOwnProperty.call(options, 'globalRuntimeKey')
		? options.globalRuntimeKey
		: globalEnvVar;
	const defaultValue = Number.isFinite(options.defaultValue)
		? options.defaultValue
		: DEFAULT_JITTER_MS;

	const readEnvValue = (key) => {
		if (!key || typeof process.env[key] !== 'string' || process.env[key].trim() === '') {
			return null;
		}
		const parsed = Number(process.env[key].trim());
		return Number.isSafeInteger(parsed) ? clampJitter(parsed) : null;
	};
	const globalEnvValue = globalEnvVar === envVar ? null : readEnvValue(globalEnvVar);
	// An explicit global zero is the operator's kill switch for jitter.
	if (globalEnvValue === 0) {
		return 0;
	}
	const workerEnvValue = readEnvValue(envVar);
	if (workerEnvValue !== null) {
		return workerEnvValue;
	}

	if (runtimeKey) {
		try {
			const { getRemoteOverride } = require('../services/remoteConfig/RemoteConfigService');
			const runtimeValue = getRemoteOverride(runtimeKey);
			if (Number.isFinite(runtimeValue)) {
				return clampJitter(runtimeValue);
			}
		} catch (error) {
			// Remote Config unavailable - fall back to the global env / default.
		}
	}

	if (globalRuntimeKey && globalRuntimeKey !== runtimeKey) {
		try {
			const { getRemoteOverride } = require('../services/remoteConfig/RemoteConfigService');
			const runtimeValue = getRemoteOverride(globalRuntimeKey);
			if (Number.isFinite(runtimeValue)) {
				return clampJitter(runtimeValue);
			}
		} catch (error) {
			// Remote Config unavailable - use the supplied default.
		}
	}
	if (globalEnvValue !== null && !options.ignoreGlobalEnvFallback) {
		return globalEnvValue;
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

function getStartupJitterDelayMs(maxJitterMs) {
	const upper = clampJitter(maxJitterMs);
	return upper > 0 ? crypto.randomInt(0, upper + 1) : 0;
}

/**
 * Wait for a per-in-random delay inside `[0, maxJitterMs]`. Returns 0 when
 * jitter is disabled (`maxJitterMs <= 0`) so callers can `await` it without
 * an extra branch. The timer is unref'd by default; callers that must keep a
 * standalone process alive can request a referenced timer and cancel it with
 * an AbortSignal during shutdown.
 *
 * @param {number} maxJitterMs upper bound in milliseconds (clamped to `[0, 30000]`)
 * @param {object} [options]
 * @param {boolean} [options.unref=true] whether to unref the timer
 * @param {AbortSignal} [options.signal] cancels the wait when aborted
 * @returns {Promise<number>} the actual jitter applied, in milliseconds
 */
async function applyStartupJitter(maxJitterMs, options = {}) {
	const delay = getStartupJitterDelayMs(maxJitterMs);
	if (delay === 0) {
		return 0;
	}
	const unref = options.unref !== false;
	const signal = options.signal;
	const createAbortError = () => {
		const error = new Error('Startup jitter aborted');
		error.name = 'AbortError';
		return error;
	};
	if (signal?.aborted) {
		throw createAbortError();
	}
	await new Promise((resolve, reject) => {
		let timer;
		const cleanup = () => {
			signal?.removeEventListener('abort', onAbort);
		};
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(createAbortError());
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, delay);
		if (unref && typeof timer.unref === 'function') {
			timer.unref();
		}
		if (signal) {
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
			}
		}
	});
	return delay;
}

module.exports = {
	applyStartupJitter,
	getStartupJitterDelayMs,
	resolveStartupJitterMs,
	clampJitter,
	MIN_JITTER_MS,
	MAX_JITTER_MS,
	DEFAULT_JITTER_MS,
};
