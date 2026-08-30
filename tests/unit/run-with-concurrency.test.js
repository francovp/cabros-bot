'use strict';

const { runWithConcurrency } = require('../../src/lib/runWithConcurrency');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runWithConcurrency', () => {
	it('executes tasks respecting the concurrency limit', async () => {
		const items = [1, 2, 3, 4, 5];
		let activeWorkers = 0;
		let maxActiveWorkers = 0;

		const worker = async (item) => {
			activeWorkers++;
			maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
			await delay(20);
			activeWorkers--;
			return item * 2;
		};

		const { results, stopped } = await runWithConcurrency(items, 2, worker);

		expect(results).toEqual([2, 4, 6, 8, 10]);
		expect(stopped).toBe(false);
		expect(maxActiveWorkers).toBeLessThanOrEqual(2);
	});

	it('preserves index order even if items finish out of order', async () => {
		const items = [50, 10, 30];

		const worker = async (delayMs, index) => {
			await delay(delayMs);
			return `item-${index}`;
		};

		const { results } = await runWithConcurrency(items, 3, worker);
		expect(results).toEqual(['item-0', 'item-1', 'item-2']);
	});

	it('stops launching new items when shouldContinue returns false', async () => {
		const items = [1, 2, 3, 4, 5, 6];
		const processed = [];
		let shouldStop = false;

		const worker = async (item) => {
			processed.push(item);
			if (item === 2) {
				shouldStop = true;
			}
			await delay(10);
			return item;
		};

		const { stopped } = await runWithConcurrency(items, 1, worker, {
			shouldContinue: () => !shouldStop,
		});

		expect(stopped).toBe(true);
		expect(processed).toEqual([1, 2]);
	});

	it('drains peer workers when one worker rejects and rethrows the first error', async () => {
		const items = [1, 2, 3, 4];
		const workerStarted = [];
		const workerFinished = [];

		const worker = async (item) => {
			workerStarted.push(item);
			if (item === 1) {
				await delay(10);
				throw new Error('Worker 1 failed');
			}
			await delay(30);
			workerFinished.push(item);
			return item;
		};

		await expect(runWithConcurrency(items, 2, worker)).rejects.toThrow('Worker 1 failed');

		// Peer worker for item 2 had started and was drained before the error propagated
		expect(workerStarted).toContain(1);
		expect(workerStarted).toContain(2);
		expect(workerFinished).toContain(2);
		// Items 3 and 4 were never started
		expect(workerStarted).not.toContain(3);
		expect(workerStarted).not.toContain(4);
	});

	it('safely defaults concurrency to 1 for invalid or zero values', async () => {
		const items = [1, 2];
		let activeWorkers = 0;
		let maxActiveWorkers = 0;

		const worker = async (item) => {
			activeWorkers++;
			maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
			await delay(10);
			activeWorkers--;
			return item;
		};

		const { results } = await runWithConcurrency(items, 0, worker);
		expect(results).toEqual([1, 2]);
		expect(maxActiveWorkers).toBe(1);
	});

	it('handles empty items array gracefully', async () => {
		const worker = jest.fn();
		const { results, stopped } = await runWithConcurrency([], 3, worker);
		expect(results).toEqual([]);
		expect(stopped).toBe(false);
		expect(worker).not.toHaveBeenCalled();
	});
});
