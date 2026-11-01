const sleepWithSignal = require('../../src/lib/sleepWithSignal');

describe('sleepWithSignal', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('resolves after the requested delay without a signal', async () => {
		const sleep = sleepWithSignal(250);
		let settled = false;
		sleep.then(() => {
			settled = true;
		});

		await jest.advanceTimersByTimeAsync(249);
		expect(settled).toBe(false);

		await jest.advanceTimersByTimeAsync(1);
		await expect(sleep).resolves.toBeUndefined();
	});

	it('resolves after the requested delay with a live signal', async () => {
		const controller = new AbortController();
		const sleep = sleepWithSignal(100, controller.signal);

		await jest.advanceTimersByTimeAsync(100);
		await expect(sleep).resolves.toBeUndefined();
	});

	it('rejects when the signal aborts before the delay completes', async () => {
		const controller = new AbortController();
		const sleep = sleepWithSignal(100, controller.signal);

		await jest.advanceTimersByTimeAsync(25);
		controller.abort(new Error('delivery cancelled'));

		await expect(sleep).rejects.toThrow('delivery cancelled');
		expect(jest.getTimerCount()).toBe(0);
	});

	it('rejects immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort('already cancelled');

		await expect(sleepWithSignal(100, controller.signal)).rejects.toThrow('already cancelled');
		expect(jest.getTimerCount()).toBe(0);
	});
});
