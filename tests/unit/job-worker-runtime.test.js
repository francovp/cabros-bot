'use strict';

const {
	FINAL_FAILURE_MAX_ATTEMPTS,
	FINAL_FAILURE_RETRY_DELAY_MS,
	JOB_QUEUE_RECONCILIATION_INTERVAL_MS,
	startJobWorker,
} = require('../../src/services/jobs/jobWorker');

describe('job worker runtime', () => {
	it('routes queue jobs through JobService and drains the worker once', async () => {
		const processor = jest.fn();
		const closeWorker = jest.fn().mockResolvedValue(undefined);
		const queue = {
			isEnabled: () => true,
			createWorker: jest.fn((handler, options) => {
				processor.mockImplementation(handler);
				expect(options.onFailed).toEqual(expect.any(Function));
				return { id: 'worker-1' };
			}),
			closeWorker,
		};
		const service = {
			processQueuedJob: jest.fn().mockResolvedValue(undefined),
			releaseQueuedJob: jest.fn().mockResolvedValue(true),
		};

		const runtime = await startJobWorker({ queue, service, workerId: 'worker-1' });
		await processor('job-123');
		await runtime.stop();
		await runtime.stop();

		expect(service.processQueuedJob).toHaveBeenCalledWith('job-123', null, 'worker-1');
		expect(closeWorker).toHaveBeenCalledTimes(1);
	});

	it('schedules durable queued-job reconciliation while the worker is running', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		process.env.WORKER_STARTUP_JITTER_MS = '0';
		jest.useFakeTimers();
		try {
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn(() => ({ id: 'worker-1' })),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = {
				processQueuedJob: jest.fn(),
				reconcileQueuedJobs: jest.fn().mockResolvedValue(1),
			};

			const runtime = await startJobWorker({ queue, service, workerId: 'worker-1' });
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(1);

			await jest.advanceTimersByTimeAsync(JOB_QUEUE_RECONCILIATION_INTERVAL_MS);
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(2);

			await runtime.stop();
			await jest.advanceTimersByTimeAsync(JOB_QUEUE_RECONCILIATION_INTERVAL_MS);
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(2);
		} finally {
			jest.useRealTimers();
			if (previousJitter === undefined) {
				delete process.env.WORKER_STARTUP_JITTER_MS;
			} else {
				process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			}
		}
	});

	it('releases retryable claims and fails the job after the final attempt', async () => {
		let onFailed;
		const queue = {
			isEnabled: () => true,
			createWorker: jest.fn((handler, options) => {
				onFailed = options.onFailed;
				return { id: 'worker-1' };
			}),
			closeWorker: jest.fn().mockResolvedValue(undefined),
		};
		const service = {
			processQueuedJob: jest.fn(),
			releaseQueuedJob: jest.fn().mockResolvedValue(true),
			failQueuedJob: jest.fn().mockResolvedValue(true),
		};
		const runtime = await startJobWorker({ queue, service, workerId: 'worker-1' });
		const retryableJob = { data: { jobId: 'job-123' }, attemptsMade: 1, opts: { attempts: 3 } };
		const finalJob = { data: { jobId: 'job-456' }, attemptsMade: 3, opts: { attempts: 3 } };
		const retryError = Object.assign(new Error('transient failure'), {
			code: 'TEMPORARY_FAILURE',
			claimAttempt: 1,
		});
		const finalError = Object.assign(new Error('permanent failure'), {
			code: 'PERMANENT_FAILURE',
			claimAttempt: 3,
		});

		await onFailed(retryableJob, retryError);
		await onFailed(finalJob, finalError);
		await runtime.stop();

		expect(service.releaseQueuedJob).toHaveBeenCalledWith('job-123', 'worker-1', retryError, 1);
		expect(service.failQueuedJob).toHaveBeenCalledWith('job-456', 'worker-1', finalError, 3);
	});

	it('does not release a claim for a failure before claim acquisition', async () => {
		let onFailed;
		const queue = {
			isEnabled: () => true,
			createWorker: jest.fn((handler, options) => {
				onFailed = options.onFailed;
				return { id: 'worker-1' };
			}),
			closeWorker: jest.fn().mockResolvedValue(undefined),
		};
		const service = {
			processQueuedJob: jest.fn(),
			releaseQueuedJob: jest.fn().mockResolvedValue(true),
		};
		await startJobWorker({ queue, service, workerId: 'worker-1' });

		const retryableJob = { data: { jobId: 'job-123' }, attemptsMade: 1, opts: { attempts: 3 } };
		const preClaimError = Object.assign(new Error('claim unavailable'), {
			code: 'JOB_CLAIM_UNAVAILABLE',
		});

		expect(onFailed(retryableJob, preClaimError)).toBeUndefined();

		expect(service.releaseQueuedJob).not.toHaveBeenCalled();
	});

	it('retries final failure persistence after a transient storage error', async () => {
		jest.useFakeTimers();
		try {
			let onFailed;
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn((handler, options) => {
					onFailed = options.onFailed;
					return { id: 'worker-1' };
				}),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = {
				processQueuedJob: jest.fn(),
				releaseQueuedJob: jest.fn(),
				failQueuedJob: jest.fn()
					.mockRejectedValueOnce(new Error('Firestore unavailable'))
					.mockResolvedValueOnce(true),
			};
			await startJobWorker({ queue, service, workerId: 'worker-1' });
			const finalJob = { data: { jobId: 'job-123' }, attemptsMade: 3, opts: { attempts: 3 } };
			const finalError = Object.assign(new Error('permanent failure'), {
				code: 'PERMANENT_FAILURE',
				claimAttempt: 3,
			});
			const finalization = onFailed(finalJob, finalError);

			await jest.advanceTimersByTimeAsync(FINAL_FAILURE_RETRY_DELAY_MS);
			await expect(finalization).resolves.toBe(true);
			expect(service.failQueuedJob).toHaveBeenCalledTimes(2);
		} finally {
			jest.useRealTimers();
		}
	});

	it('bounds terminal failure persistence retries', async () => {
		jest.useFakeTimers();
		try {
			let onFailed;
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn((handler, options) => {
					onFailed = options.onFailed;
					return { id: 'worker-1' };
				}),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = {
				processQueuedJob: jest.fn(),
				failQueuedJob: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
			};
			await startJobWorker({ queue, service, workerId: 'worker-1' });
			const finalJob = { data: { jobId: 'job-123' }, attemptsMade: 3, opts: { attempts: 3 } };
			const finalError = Object.assign(new Error('permanent failure'), {
				code: 'PERMANENT_FAILURE',
				claimAttempt: 3,
			});
			const finalization = onFailed(finalJob, finalError);

			for (let retry = 1; retry < FINAL_FAILURE_MAX_ATTEMPTS; retry++) {
				await jest.advanceTimersByTimeAsync(FINAL_FAILURE_RETRY_DELAY_MS);
			}

			await expect(finalization).resolves.toBe(false);
			expect(service.failQueuedJob).toHaveBeenCalledTimes(FINAL_FAILURE_MAX_ATTEMPTS);
		} finally {
			jest.useRealTimers();
		}
	});

	it('requeues final failures that never acquired a Firestore claim', async () => {
		let onFailed;
		const queue = {
			isEnabled: () => true,
			createWorker: jest.fn((handler, options) => {
				onFailed = options.onFailed;
				return { id: 'worker-1' };
			}),
			closeWorker: jest.fn().mockResolvedValue(undefined),
		};
		const service = {
			processQueuedJob: jest.fn(),
			failQueuedJob: jest.fn().mockResolvedValue(false),
		};
		await startJobWorker({ queue, service, workerId: 'worker-1' });
		const retry = jest.fn().mockResolvedValue(undefined);
		const finalJob = {
			data: { jobId: 'job-123' },
			attemptsMade: 3,
			opts: { attempts: 3 },
			retry,
		};
		const finalError = Object.assign(new Error('Firestore unavailable'), {
			code: 'JOB_CLAIM_UNAVAILABLE',
		});

		await expect(onFailed(finalJob, finalError)).resolves.toEqual({ requeued: true });
		expect(service.failQueuedJob).not.toHaveBeenCalled();
		expect(retry).toHaveBeenCalledWith('failed');
	});

	it('waits for pending callback deliveries before stopping', async () => {
		const queue = {
			isEnabled: () => true,
			createWorker: jest.fn(() => ({ id: 'worker-1' })),
			closeWorker: jest.fn().mockResolvedValue(undefined),
		};
		const service = {
			processQueuedJob: jest.fn(),
			releaseQueuedJob: jest.fn(),
			waitForCallbacks: jest.fn().mockResolvedValue(undefined),
		};

		const runtime = await startJobWorker({ queue, service, workerId: 'worker-1' });
		await runtime.stop();

		expect(queue.closeWorker).toHaveBeenCalledTimes(1);
		expect(service.waitForCallbacks).toHaveBeenCalledTimes(1);
	});

	describe('firestore-poller mode', () => {
		const originalMode = process.env.JOB_EXECUTION_MODE;

		beforeEach(() => {
			process.env.JOB_EXECUTION_MODE = 'firestore-poller';
		});

		afterEach(() => {
			if (originalMode !== undefined) {
				process.env.JOB_EXECUTION_MODE = originalMode;
			} else {
				delete process.env.JOB_EXECUTION_MODE;
			}
		});

		it('polls and processes queued jobs without initializing Redis or BullMQ', async () => {
			const queue = {
				isEnabled: jest.fn(() => false),
				createWorker: jest.fn(),
			};
			const repository = {
				list: jest.fn().mockResolvedValue([
					{
						jobId: 'job-1',
						status: 'processing',
						execution: { mode: 'firestore-poller', status: 'queued' },
					},
					{
						jobId: 'job-other',
						status: 'processing',
						execution: { mode: 'render-worker', status: 'queued' },
					},
				]),
			};
			const service = {
				repository,
				processQueuedJob: jest.fn().mockResolvedValue(undefined),
				releaseQueuedJob: jest.fn(),
				failQueuedJob: jest.fn(),
				waitForCallbacks: jest.fn().mockResolvedValue(undefined),
			};

			const runtime = await startJobWorker({ queue, service, workerId: 'worker-fp-1' });
			await runtime.pollOnce();
			await runtime.stop();

			expect(queue.createWorker).not.toHaveBeenCalled();
			expect(repository.list).toHaveBeenCalledWith({ status: 'processing', limit: 50 });
			expect(service.processQueuedJob).toHaveBeenCalledWith('job-1', null, 'worker-fp-1');
			expect(service.processQueuedJob).not.toHaveBeenCalledWith('job-other', expect.anything(), expect.anything());
			expect(service.waitForCallbacks).toHaveBeenCalledTimes(1);
		});

		it('polls expired claims and handles race conditions safely', async () => {
			const repository = {
				list: jest.fn().mockResolvedValue([
					{
						jobId: 'job-expired',
						status: 'processing',
						execution: {
							mode: 'firestore-poller',
							status: 'running',
							leaseUntil: new Date(Date.now() - 5000).toISOString(),
						},
					},
					{
						jobId: 'job-active-claim',
						status: 'processing',
						execution: {
							mode: 'firestore-poller',
							status: 'running',
							leaseUntil: new Date(Date.now() + 60000).toISOString(),
						},
					},
				]),
			};
			const raceError = Object.assign(new Error('Job claim is active'), { code: 'JOB_CLAIM_ACTIVE' });
			const service = {
				repository,
				processQueuedJob: jest.fn().mockRejectedValue(raceError),
				releaseQueuedJob: jest.fn(),
				failQueuedJob: jest.fn(),
				waitForCallbacks: jest.fn().mockResolvedValue(undefined),
			};

			const runtime = await startJobWorker({ service, workerId: 'worker-fp-1' });
			await runtime.pollOnce();
			await runtime.stop();

			expect(service.processQueuedJob).toHaveBeenCalledWith('job-expired', null, 'worker-fp-1');
			expect(service.processQueuedJob).not.toHaveBeenCalledWith('job-active-claim', expect.anything(), expect.anything());
			expect(service.releaseQueuedJob).not.toHaveBeenCalled();
			expect(service.failQueuedJob).not.toHaveBeenCalled();
		});

		it('releases retryable claims when attempts remain and fails when max attempts reached', async () => {
			const repository = {
				list: jest.fn().mockResolvedValue([
					{
						jobId: 'job-retryable',
						status: 'processing',
						execution: { mode: 'firestore-poller', status: 'queued' },
					},
					{
						jobId: 'job-final-fail',
						status: 'processing',
						execution: { mode: 'firestore-poller', status: 'queued' },
					},
				]),
			};
			const retryError = Object.assign(new Error('transient network glitch'), {
				claimAttempt: 2,
				code: 'NETWORK_ERROR',
			});
			const finalError = Object.assign(new Error('fatal error'), {
				claimAttempt: 5,
				code: 'FATAL_ERROR',
			});
			const service = {
				repository,
				processQueuedJob: jest.fn()
					.mockRejectedValueOnce(retryError)
					.mockRejectedValueOnce(finalError),
				releaseQueuedJob: jest.fn().mockResolvedValue(true),
				failQueuedJob: jest.fn().mockResolvedValue(true),
				waitForCallbacks: jest.fn().mockResolvedValue(undefined),
			};

			const runtime = await startJobWorker({ service, workerId: 'worker-fp-1' });
			await runtime.pollOnce();
			await runtime.stop();

			expect(service.releaseQueuedJob).toHaveBeenCalledWith('job-retryable', 'worker-fp-1', retryError, 2);
			expect(service.failQueuedJob).toHaveBeenCalledWith('job-final-fail', 'worker-fp-1', finalError, 5);
		});
	});
});
