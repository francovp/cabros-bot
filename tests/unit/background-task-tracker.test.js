'use strict';

const {
	trackBackgroundTask,
	waitForBackgroundTasks,
	resetForTesting,
} = require('../../src/lib/backgroundTaskTracker');

describe('background task tracker', () => {
	afterEach(() => {
		resetForTesting();
	});

	it('waits for tracked persistence tasks to settle', async () => {
		let release;
		const task = new Promise((resolve) => { release = resolve; });
		trackBackgroundTask(task);

		const drain = waitForBackgroundTasks();
		let drained = false;
		drain.then(() => { drained = true; });
		await Promise.resolve();

		expect(drained).toBe(false);

		release();
		await drain;
		expect(drained).toBe(true);
	});
});
