'use strict';

const { startJobWorker } = require('../../src/services/jobs/jobWorker');

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
});
