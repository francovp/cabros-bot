'use strict';

const activeTasks = new Set();

function trackBackgroundTask(task) {
	const promise = Promise.resolve(task);
	activeTasks.add(promise);
	promise.then(
		() => activeTasks.delete(promise),
		() => activeTasks.delete(promise),
	);
	return promise;
}

async function waitForBackgroundTasks() {
	while (activeTasks.size > 0) {
		await Promise.allSettled([...activeTasks]);
	}
}

function resetForTesting() {
	activeTasks.clear();
}

module.exports = {
	trackBackgroundTask,
	waitForBackgroundTasks,
	resetForTesting,
};
