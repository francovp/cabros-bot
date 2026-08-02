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
});
