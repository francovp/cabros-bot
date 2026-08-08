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

const FINAL_FAILURE_RETRY_DELAY_MS = 1000;
const FINAL_FAILURE_MAX_ATTEMPTS = 5;
const JOB_QUEUE_RECONCILIATION_INTERVAL_MS = 30000;

async function finalizeFailedJob(service, job, workerId, error, attempt) {
	if (attempt === null) {
		if (typeof job.retry === 'function') {
			await job.retry('failed');
			return { requeued: true };
		}

		return false;
	}

	const jobId = job && job.data && job.data.jobId;
	for (let failureAttempt = 1; failureAttempt <= FINAL_FAILURE_MAX_ATTEMPTS; failureAttempt++) {
		try {
			const failed = await service.failQueuedJob(jobId, workerId, error, attempt);
			if (failed || attempt !== null) {
				return failed;
			}

			if (typeof job.retry === 'function') {
				await job.retry('failed');
				return { requeued: true };
			}

			return false;
		} catch (failure) {
			if (failureAttempt === FINAL_FAILURE_MAX_ATTEMPTS) {
				console.error('[JobWorker] Could not persist terminal queue failure after bounded retries:', failure.message);
				return false;
			}
			console.warn('[JobWorker] Failed to persist terminal queue failure; retrying:', failure.message);
			await new Promise((resolve) => setTimeout(resolve, FINAL_FAILURE_RETRY_DELAY_MS));
		}
	}

	return false;
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
				const claimAttempt = Number(error && error.claimAttempt);
				const attempt = Number.isFinite(claimAttempt) ? claimAttempt : null;
				if (!jobId) {
					return undefined;
				}

				if (hasAttemptsRemaining(job)) {
					if (attempt === null) {
						return undefined;
					}
					return service.releaseQueuedJob(jobId, workerId, error, attempt);
				}

				return finalizeFailedJob(service, job, workerId, error, attempt);
			},
		},
	);

	if (worker && typeof worker.waitUntilReady === 'function') {
		await worker.waitUntilReady();
	}

	let reconciliationTimer = null;
	if (service && typeof service.reconcileQueuedJobs === 'function') {
		const reconcileQueuedJobs = async () => {
			try {
				await service.reconcileQueuedJobs();
			} catch (error) {
				console.warn('[JobWorker] Queued-job reconciliation failed:', error.message);
			}
		};

		void reconcileQueuedJobs();
		reconciliationTimer = globalThis.setInterval(() => {
			void reconcileQueuedJobs();
		}, JOB_QUEUE_RECONCILIATION_INTERVAL_MS);
		if (typeof reconciliationTimer.unref === 'function') {
			reconciliationTimer.unref();
		}
	}

	return {
		worker,
		workerId,
		stop: async () => {
			if (stopped) {
				return;
			}
			stopped = true;
			if (reconciliationTimer) {
				globalThis.clearInterval(reconciliationTimer);
			}
			await queue.closeWorker(worker);
			if (service && typeof service.waitForCallbacks === 'function') {
				await service.waitForCallbacks();
			}
		},
	};
}

module.exports = {
	FINAL_FAILURE_MAX_ATTEMPTS,
	getWorkerId,
	FINAL_FAILURE_RETRY_DELAY_MS,
	JOB_QUEUE_RECONCILIATION_INTERVAL_MS,
	startJobWorker,
};
