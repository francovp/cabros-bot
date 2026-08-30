'use strict';

async function runWithConcurrency(items, concurrency, worker, { shouldContinue = () => true } = {}) {
	const results = new Array(items.length);
	let nextIndex = 0;
	let stopped = false;
	let firstError = null;
	const workerCount = Math.min(items.length, Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1);

	const run = async () => {
		while (!stopped) {
			const index = nextIndex++;
			if (index >= items.length) {
				return;
			}

			try {
				if (!await shouldContinue()) {
					stopped = true;
					return;
				}
			} catch (error) {
				stopped = true;
				if (!firstError) {
					firstError = error;
				}
				return;
			}

			if (stopped) {
				return;
			}

			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				stopped = true;
				if (!firstError) {
					firstError = error;
				}
				return;
			}

			try {
				if (!await shouldContinue()) {
					stopped = true;
				}
			} catch (error) {
				stopped = true;
				if (!firstError) {
					firstError = error;
				}
			}
		}
	};

	const workers = Array.from({ length: workerCount }, () => run());
	await Promise.allSettled(workers);

	if (firstError) {
		throw firstError;
	}

	return { results, stopped };
}

module.exports = { runWithConcurrency };
