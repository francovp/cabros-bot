'use strict';

const { JobService } = require('../../src/services/jobs/JobService');

describe('JobService Render worker mode', () => {
	it('persists and enqueues a job without executing it in the web process', async () => {
		const repository = {
			entries: () => [],
			isDurable: jest.fn(() => true),
			save: jest.fn().mockResolvedValue('job-123'),
		};
		const queue = {
			isEnabled: () => true,
			enqueue: jest.fn().mockResolvedValue({ queued: true, jobId: 'job-123' }),
		};
		const service = new JobService(repository, queue);
		service._triggerCallbackIfConfigured = jest.fn().mockResolvedValue(undefined);
		service._runBackgroundJob = jest.fn();

		const result = await service.createJob('expanded-analysis', {
			type: 'expanded-analysis',
			symbols: ['BINANCE:BTCUSDT'],
		});

		expect(result).toMatchObject({ success: true, jobId: expect.any(String), status: 'processing' });
		expect(repository.save).toHaveBeenCalledWith(
			expect.objectContaining({
				execution: expect.objectContaining({ mode: 'render-worker', status: 'queued' }),
			}),
			{ required: true },
		);
		expect(queue.enqueue).toHaveBeenCalledWith(result.jobId);
		expect(service._runBackgroundJob).not.toHaveBeenCalled();
	});

	it('requires durable reconciliation when enqueue fails', async () => {
		const repository = {
			entries: () => [],
			isDurable: jest.fn(() => true),
			save: jest.fn()
				.mockResolvedValueOnce('job-123')
				.mockResolvedValueOnce('job-123'),
		};
		const queueError = Object.assign(new Error('Redis unavailable'), {
			code: 'JOB_QUEUE_UNAVAILABLE',
			statusCode: 503,
		});
		const queue = {
			isEnabled: () => true,
			enqueue: jest.fn().mockRejectedValue(queueError),
		};
		const service = new JobService(repository, queue);

		await expect(service.createJob('expanded-analysis', {
			type: 'expanded-analysis',
			symbols: ['BINANCE:BTCUSDT'],
		})).rejects.toBe(queueError);

		expect(repository.save).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				status: 'failed',
				execution: expect.objectContaining({ status: 'failed' }),
			}),
			{ required: true },
		);
	});

	it('preserves the queued record when enqueue acceptance is indeterminate', async () => {
		const repository = {
			entries: () => [],
			isDurable: jest.fn(() => true),
			save: jest.fn().mockResolvedValue('job-123'),
			delete: jest.fn().mockResolvedValue(true),
		};
		const queueError = Object.assign(new Error('Redis acceptance unknown'), {
			code: 'JOB_QUEUE_ACCEPTANCE_UNKNOWN',
			statusCode: 503,
		});
		const queue = {
			isEnabled: () => true,
			enqueue: jest.fn().mockRejectedValue(queueError),
		};
		const service = new JobService(repository, queue);

		await expect(service.createJob('expanded-analysis', {
			type: 'expanded-analysis',
			symbols: ['BINANCE:BTCUSDT'],
		})).rejects.toBe(queueError);

		expect(repository.save).toHaveBeenCalledTimes(1);
		expect(repository.delete).not.toHaveBeenCalled();
	});

	it('re-enqueues durable queued jobs during reconciliation', async () => {
		const repository = {
			entries: () => [],
			list: jest.fn().mockResolvedValue([
				{
					jobId: 'lost-queue-job',
					status: 'processing',
					execution: { mode: 'render-worker', status: 'queued' },
				},
				{
					jobId: 'active-job',
					status: 'processing',
					execution: {
						mode: 'render-worker',
						status: 'running',
						leaseUntil: new Date(Date.now() + 60000).toISOString(),
					},
				},
				{
					jobId: 'expired-claim-job',
					status: 'processing',
					execution: {
						mode: 'render-worker',
						status: 'running',
						leaseUntil: new Date(Date.now() - 1000).toISOString(),
					},
				},
			]),
		};
		const queue = {
			isEnabled: () => true,
			enqueue: jest.fn().mockResolvedValue({ queued: true }),
			retryFailed: jest.fn().mockImplementation(async (jobId) => jobId === 'expired-claim-job'),
		};
		const service = new JobService(repository, queue);

		await expect(service.reconcileQueuedJobs()).resolves.toBe(2);

		expect(repository.list).toHaveBeenCalledWith({ status: 'processing', limit: expect.any(Number) });
		expect(queue.enqueue).toHaveBeenCalledWith('lost-queue-job');
		expect(queue.retryFailed).toHaveBeenCalledWith('expired-claim-job');
		expect(queue.enqueue).not.toHaveBeenCalledWith('expired-claim-job');
		expect(queue.enqueue).not.toHaveBeenCalledWith('active-job');
	});

	it('removes the durable record when queue-failure reconciliation cannot be persisted', async () => {
		const persistenceError = Object.assign(new Error('Firestore unavailable'), {
			code: 'JOB_STORAGE_UNAVAILABLE',
		});
		const repository = {
			entries: () => [],
			isDurable: jest.fn(() => true),
			save: jest.fn()
				.mockResolvedValueOnce('job-123')
				.mockRejectedValueOnce(persistenceError),
			delete: jest.fn().mockResolvedValue(true),
		};
		const queueError = Object.assign(new Error('Redis unavailable'), {
			code: 'JOB_QUEUE_UNAVAILABLE',
			statusCode: 503,
		});
		const queue = {
			isEnabled: () => true,
			enqueue: jest.fn().mockRejectedValue(queueError),
		};
		const service = new JobService(repository, queue);

		await expect(service.createJob('expanded-analysis', {
			type: 'expanded-analysis',
			symbols: ['BINANCE:BTCUSDT'],
		})).rejects.toBe(queueError);

		expect(repository.delete).toHaveBeenCalledWith(expect.any(String));
	});
});
