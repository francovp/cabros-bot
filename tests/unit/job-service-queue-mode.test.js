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
});
