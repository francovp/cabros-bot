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

const JOB_POLL_DEFAULT_INTERVAL_MS = 15000;

function getPollIntervalMs() {
	try {
		const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
		const config = getRuntimeConfig();
		if (config && Number.isInteger(config.JOB_POLL_INTERVAL_MS) && config.JOB_POLL_INTERVAL_MS >= 1000) {
			return config.JOB_POLL_INTERVAL_MS;
		}
	} catch {
		// ignore
	}
	const raw = Number(process.env.JOB_POLL_INTERVAL_MS);
	if (Number.isInteger(raw) && raw >= 1000 && raw <= 300000) {
		return raw;
	}
	return JOB_POLL_DEFAULT_INTERVAL_MS;
}

async function startJobWorker({
	queue = jobQueue,
	service = new JobService(),
	botOrGetter = null,
	workerId = getWorkerId(),
} = {}) {
	const isQueueMode = typeof queue?.isEnabled === 'function' && queue.isEnabled();
	const mode = isQueueMode ? 'render-worker' : (process.env.JOB_EXECUTION_MODE || 'local');
	if (mode !== 'render-worker' && mode !== 'firestore-poller') {
		const error = new Error('JOB_EXECUTION_MODE must be render-worker or firestore-poller for the job worker.');
		error.code = 'JOB_WORKER_DISABLED';
		throw error;
	}

	if (mode === 'render-worker') {
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

	// firestore-poller mode
	let stopped = false;
	let pollingTimer = null;
	let activePollPromise = null;
	const inFlightJobs = new Set();
	const maxAttempts = Number(process.env.JOB_QUEUE_ATTEMPTS) > 0
		? Math.min(Number(process.env.JOB_QUEUE_ATTEMPTS), 20)
		: 5;

	const pollOnce = async () => {
		if (stopped) {
			return;
		}
		if (activePollPromise) {
			return activePollPromise;
		}

		activePollPromise = (async () => {
			try {
				if (!service.repository || typeof service.repository.list !== 'function') {
					return;
				}
				const jobs = await service.repository.list({ status: 'processing', limit: 50 });
				if (stopped) return;
				const jobList = Array.isArray(jobs) ? jobs : (jobs instanceof Map ? Array.from(jobs.values()) : []);
				const now = Date.now();

				for (const job of jobList) {
					if (stopped) break;
					const execution = job && job.execution ? job.execution : {};
					const leaseUntilMs = Date.parse(execution.leaseUntil || '');
					const expiredClaim = ['claimed', 'running'].includes(execution.status)
						&& Number.isFinite(leaseUntilMs)
						&& leaseUntilMs <= now;
					const isEligible = job
						&& typeof job.jobId === 'string'
						&& execution.mode === 'firestore-poller'
						&& (execution.status === 'queued' || expiredClaim);

					if (!isEligible) {
						continue;
					}

					const jobId = job.jobId;
					const jobPromise = (async () => {
						try {
							await service.processQueuedJob(jobId, botOrGetter, workerId);
						} catch (error) {
							if (error && error.code === 'JOB_CLAIM_ACTIVE') {
								return;
							}
							const claimAttempt = Number(error && error.claimAttempt);
							const attempt = Number.isFinite(claimAttempt) ? claimAttempt : null;
							if (attempt !== null && attempt < maxAttempts) {
								try {
									await service.releaseQueuedJob(jobId, workerId, error, attempt);
								} catch (releaseErr) {
									console.warn(`[JobWorker] Failed to release queued job ${jobId}:`, releaseErr.message);
								}
							} else {
								await finalizeFailedJob(service, { data: { jobId } }, workerId, error, attempt);
							}
						}
					})();

					inFlightJobs.add(jobPromise);
					jobPromise.finally(() => {
						inFlightJobs.delete(jobPromise);
					});

					await jobPromise;
				}
			} catch (pollError) {
				console.warn('[JobWorker] Firestore job poller error:', pollError.message);
			} finally {
				activePollPromise = null;
			}
		})();

		return activePollPromise;
	};

	const scheduleNextPoll = () => {
		if (stopped) return;
		const intervalMs = getPollIntervalMs();
		pollingTimer = globalThis.setTimeout(async () => {
			await pollOnce();
			scheduleNextPoll();
		}, intervalMs);
		if (typeof pollingTimer.unref === 'function') {
			pollingTimer.unref();
		}
	};
	scheduleNextPoll();

	return {
		worker: null,
		workerId,
		pollOnce,
		stop: async () => {
			if (stopped) {
				return;
			}
			stopped = true;
			if (pollingTimer) {
				globalThis.clearTimeout(pollingTimer);
				pollingTimer = null;
			}
			if (inFlightJobs.size > 0) {
				await Promise.allSettled([...inFlightJobs]);
			}
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
	JOB_POLL_DEFAULT_INTERVAL_MS,
	getPollIntervalMs,
	startJobWorker,
};
