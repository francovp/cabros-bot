'use strict';

const {
	FINAL_FAILURE_RETRY_DELAY_MS,
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
		expect(service.failQueuedJob).toHaveBeenCalledWith('job-123', 'worker-1', finalError, null);
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
});
