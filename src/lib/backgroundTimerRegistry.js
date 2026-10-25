'use strict';

const registeredTimers = new Map();
let nextTimerId = 1;
let drainedTimers = 0;
let failedTimers = 0;
const DEFAULT_TIMER_DRAIN_TIMEOUT_MS = 2000;

function getBackgroundTimerStats() {
	return {
		registered: registeredTimers.size,
		drained: drainedTimers,
		failed: failedTimers,
	};
}

function reportTimerFailure(name, error) {
	console.error('[BackgroundTimerRegistry] Managed timer failed', {
		timer: name,
		error,
	});
}

function registerBackgroundTimer({ name, interval, intervalMs, stop, clear, hasPending, drain }) {
	const id = nextTimerId++;
	const timerName = typeof name === 'string' && name.trim() ? name : `background-timer-${id}`;
	let stopPromise;
	let cleared = false;
	let didRecordResult = false;
	let recordedResult;
	let entry;

	const recordResult = (result) => {
		if (didRecordResult) return recordedResult;
		didRecordResult = true;
		recordedResult = result;
		registeredTimers.delete(id);
		if (result.status === 'drained') {
			drainedTimers += 1;
		} else {
			failedTimers += 1;
			reportTimerFailure(timerName, result.timedOut
				? new Error('Timer drain budget exceeded')
				: result.error);
		}
		return result;
	};

	const clearTimer = () => {
		if (cleared || didRecordResult) return;
		try {
			if (typeof clear === 'function') clear({ interval, intervalMs });
			else clearInterval(interval);
			cleared = true;
			if (!hasPending?.() && typeof stop !== 'function') {
				recordResult({ status: 'drained' });
			}
		} catch (error) {
			recordResult({ status: 'failed', error });
			throw error;
		}
	};

	entry = {
		name: timerName,
		interval,
		intervalMs,
		clear: clearTimer,
		complete: () => {
			if (cleared && !hasPending?.()) return recordResult({ status: 'drained' });
			return { status: 'pending' };
		},
		stop: ({ timeoutMs } = {}) => {
			if (stopPromise) return stopPromise;
			clearTimer();
			if (didRecordResult) return Promise.resolve(recordedResult);
			const drainTimeoutMs = timeoutMs === undefined
				? DEFAULT_TIMER_DRAIN_TIMEOUT_MS
				: timeoutMs;

			const operations = [];
			try {
				if (typeof stop === 'function') operations.push(Promise.resolve(stop({ timeoutMs: drainTimeoutMs })));
				if (typeof drain === 'function') operations.push(Promise.resolve(drain()));
			} catch (error) {
				operations.push(Promise.reject(error));
			}

			const stopOperation = Promise.all(operations).then(
				() => ({ status: 'drained' }),
				(error) => ({ status: 'failed', error }),
			);
			const bounded = Number.isFinite(drainTimeoutMs) && drainTimeoutMs > 0
				? new Promise((resolve) => {
					const timeoutHandle = setTimeout(() => {
						resolve({ status: 'failed', timedOut: true });
					}, drainTimeoutMs);
					stopOperation.then((result) => {
						clearTimeout(timeoutHandle);
						resolve(result);
					});
				})
				: stopOperation;

			stopPromise = bounded.then(recordResult);
			return stopPromise;
		},
	};

	registeredTimers.set(id, entry);
	return entry;
}

function createManagedInterval(name, callback, intervalMs) {
	if (typeof callback !== 'function') {
		throw new TypeError('Managed interval callback must be a function');
	}

	const activeCallbacks = new Set();
	let stopping = false;
	let managedTimer;
	const completeIfDrained = () => {
		if (stopping && activeCallbacks.size === 0) managedTimer?.complete();
	};
	const interval = setInterval(() => {
		if (stopping) return;

		let callbackResult;
		try {
			callbackResult = callback();
		} catch (error) {
			reportTimerFailure(name, error);
			return;
		}
		if (!callbackResult || typeof callbackResult.then !== 'function') return;

		const callbackPromise = Promise.resolve(callbackResult);
		activeCallbacks.add(callbackPromise);
		callbackPromise.then(
			() => {
				activeCallbacks.delete(callbackPromise);
				completeIfDrained();
			},
			(error) => {
				activeCallbacks.delete(callbackPromise);
				reportTimerFailure(name, error);
				completeIfDrained();
			},
		);
	}, intervalMs);

	managedTimer = registerBackgroundTimer({
		name,
		interval,
		intervalMs,
		clear: () => {
			stopping = true;
			clearInterval(interval);
		},
		hasPending: () => activeCallbacks.size > 0,
		drain: () => Promise.allSettled([...activeCallbacks]),
	});

	managedTimer.unref = () => {
		interval.unref?.();
		return managedTimer;
	};
	managedTimer.ref = () => {
		interval.ref?.();
		return managedTimer;
	};

	return managedTimer;
}

async function stopAllBackgroundTimers({ timeoutMs } = {}) {
	const entries = [...registeredTimers.values()];
	const results = await Promise.all(entries.map(async (entry) => {
		try {
			return await entry.stop({ timeoutMs });
		} catch (error) {
			return { status: 'failed', error };
		}
	}));
	return {
		registered: entries.length,
		drained: results.filter((result) => result.status === 'drained').length,
		failed: results.filter((result) => result.status === 'failed').length,
	};
}

function resetBackgroundTimersForTesting() {
	for (const entry of registeredTimers.values()) {
		clearInterval(entry.interval);
	}
	registeredTimers.clear();
	nextTimerId = 1;
	drainedTimers = 0;
	failedTimers = 0;
}

module.exports = {
	createManagedInterval,
	registerBackgroundTimer,
	stopAllBackgroundTimers,
	getBackgroundTimerStats,
	resetBackgroundTimersForTesting,
};
