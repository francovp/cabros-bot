'use strict';

const { jobQueue } = require('./JobQueue');
const { JobService } = require('./JobService');

function getWorkerId() {
	return process.env.RENDER_INSTANCE_ID
		|| process.env.RENDER_SERVICE_ID
		|| `worker-${process.pid}`;
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
				return jobId ? service.releaseQueuedJob(jobId, workerId, error) : undefined;
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
		},
	};
}

module.exports = {
	getWorkerId,
	startJobWorker,
};
