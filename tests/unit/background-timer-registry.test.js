'use strict';

let registry = null;
try {
	registry = require('../../src/lib/backgroundTimerRegistry');
} catch (_error) {
	// Keep the RED run as an assertion failure when the production module is absent.
}

function getRegistry() {
	expect(registry).not.toBeNull();
	return registry;
}

describe('background timer registry', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		if (registry) registry.resetBackgroundTimersForTesting();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('stops each timer once when stop is called repeatedly', async () => {
		const { registerBackgroundTimer, getBackgroundTimerStats } = getRegistry();
		const interval = setInterval(() => undefined, 1000);
		const stop = jest.fn(() => clearInterval(interval));
		const timer = registerBackgroundTimer({ name: 'duplicate-stop', interval, intervalMs: 1000, stop });

		await Promise.all([timer.stop(), timer.stop()]);

		expect(stop).toHaveBeenCalledTimes(1);
		expect(getBackgroundTimerStats()).toEqual({ registered: 0, drained: 1, failed: 0 });
		expect(jest.getTimerCount()).toBe(0);
	});

	it('stops timers concurrently and waits for active callbacks to finish', async () => {
		const { createManagedInterval, stopAllBackgroundTimers } = getRegistry();
		let releaseCallback;
		const callback = jest.fn(() => new Promise((resolve) => { releaseCallback = resolve; }));
		createManagedInterval('slow-callback', callback, 100);

		jest.advanceTimersByTime(100);
		expect(callback).toHaveBeenCalledTimes(1);
		let drained = false;
		const draining = stopAllBackgroundTimers({ timeoutMs: 500 }).then((result) => {
			drained = true;
			return result;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		releaseCallback();
		await expect(draining).resolves.toEqual({ registered: 1, drained: 1, failed: 0 });
	});

	it('keeps an active callback drainable after clear stops future interval fires', async () => {
		const { createManagedInterval, stopAllBackgroundTimers, getBackgroundTimerStats } = getRegistry();
		let releaseCallback;
		const callback = jest.fn(() => new Promise((resolve) => { releaseCallback = resolve; }));
		const timer = createManagedInterval('cleared-with-callback-active', callback, 10);

		jest.advanceTimersByTime(10);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(typeof timer.clear).toBe('function');
		timer.clear();
		jest.advanceTimersByTime(30);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
		expect(getBackgroundTimerStats()).toEqual({ registered: 1, drained: 0, failed: 0 });
		const draining = stopAllBackgroundTimers({ timeoutMs: 100 });
		releaseCallback();
		await expect(draining).resolves.toEqual({ registered: 1, drained: 1, failed: 0 });
	});

	it('records a callback that exceeds the drain budget as failed', async () => {
		const { createManagedInterval, stopAllBackgroundTimers, getBackgroundTimerStats } = getRegistry();
		const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		createManagedInterval('blocked-callback', () => new Promise(() => undefined), 10);

		jest.advanceTimersByTime(10);
		const draining = stopAllBackgroundTimers({ timeoutMs: 25 });
		await jest.advanceTimersByTimeAsync(25);

		await expect(draining).resolves.toEqual({ registered: 1, drained: 0, failed: 1 });
		expect(getBackgroundTimerStats()).toEqual({ registered: 0, drained: 0, failed: 1 });
		expect(errorLog).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('clears a registered interval with clearInterval when no stopper is supplied', async () => {
		const { registerBackgroundTimer, getBackgroundTimerStats } = getRegistry();
		const interval = setInterval(() => undefined, 1000);
		registerBackgroundTimer({ name: 'fallback-stop', interval, intervalMs: 1000 });

		await expect(getRegistry().stopAllBackgroundTimers({ timeoutMs: 100 })).resolves.toEqual({
			registered: 1,
			drained: 1,
			failed: 0,
		});
		expect(getBackgroundTimerStats()).toEqual({ registered: 0, drained: 1, failed: 0 });
		expect(jest.getTimerCount()).toBe(0);
	});

	it('removes successfully drained timers from the registry', async () => {
		const { createManagedInterval, stopAllBackgroundTimers, getBackgroundTimerStats } = getRegistry();
		createManagedInterval('cleared-after-drain', () => undefined, 1000);

		await stopAllBackgroundTimers({ timeoutMs: 100 });

		expect(getBackgroundTimerStats()).toEqual({ registered: 0, drained: 1, failed: 0 });
	});
});
