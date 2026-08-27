'use strict';

async function runWithConcurrency(items, concurrency, worker, { shouldContinue = () => true } = {}) {
	const results = new Array(items.length);
	let nextIndex = 0;
	let stopped = false;
	const workerCount = Math.min(items.length, Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1);

	const run = async () => {
		while (!stopped) {
			const index = nextIndex++;
			if (index >= items.length) {
				return;
			}

			if (!await shouldContinue()) {
				stopped = true;
				return;
			}

			if (stopped) {
				return;
			}

			results[index] = await worker(items[index], index);
			if (!await shouldContinue()) {
				stopped = true;
			}
		}
	};

	await Promise.all(Array.from({ length: workerCount }, run));
	return { results, stopped };
}

module.exports = { runWithConcurrency };
