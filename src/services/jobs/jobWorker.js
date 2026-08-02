'use strict';

const { jobQueue } = require('./JobQueue');
const { JobService } = require('./JobService');

function getWorkerId() {
	return process.env.RENDER_INSTANCE_ID
		|| process.env.RENDER_SERVICE_ID
		|| `worker-${process.pid}`;
}

function hasAttemptsRemaining(job) {
	const attemptsMade = Number(job && job.attemptsMade);
	const attempts = Number(job && job.opts && job.opts.attempts);
	return Number.isFinite(attemptsMade) && Number.isFinite(attempts) && attemptsMade < attempts;
}

async function startJobWorker({
	queue = jobQueue,
	service = new JobService(),
	botOrGetter = null,
	workerId = getWorkerId(),
} = {}) {
	if (!queue.isEnabled()) {
		const error = new Error('JOB_EXECUTION_MODE must be render-worker for the job worker.');
		error.code = 'JOB_WORKER_DISABLED';
		throw error;
	}

	let stopped = false;
	const worker = queue.createWorker(
		(jobId) => service.processQueuedJob(jobId, botOrGetter, workerId),
		{
			onFailed: (job, error) => {
				const jobId = job && job.data && job.data.jobId;
				if (!jobId) {
					return undefined;
				}

				if (hasAttemptsRemaining(job)) {
					return service.releaseQueuedJob(jobId, workerId, error);
				}

				return service.failQueuedJob(jobId, workerId, error);
			},
		},
	);

	if (worker && typeof worker.waitUntilReady === 'function') {
		await worker.waitUntilReady();
	}

	return {
		worker,
		workerId,
		stop: async () => {
			if (stopped) {
				return;
			}
			stopped = true;
			await queue.closeWorker(worker);
			if (service && typeof service.waitForCallbacks === 'function') {
				await service.waitForCallbacks();
			}
		},
	};
}

module.exports = {
	getWorkerId,
	startJobWorker,
};
