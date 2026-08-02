'use strict';

const { JobService } = require('../../src/services/jobs/JobService');

describe('queued job execution', () => {
	it('claims a durable job before starting its domain work', async () => {
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			requestMetadata: {
				type: 'expanded-analysis',
				symbols: ['BINANCE:BTCUSDT'],
				timeframe: '1D',
				includeMultiTimeframe: false,
				analysisMode: 'standard',
			},
		};
		const repository = {
			claim: jest.fn().mockResolvedValue({ claimed: true, job }),
		};
		const service = new JobService(repository);
		service._runBackgroundJob = jest.fn().mockResolvedValue(undefined);

		await service.processQueuedJob('job-123', null, 'worker-1');

		expect(repository.claim).toHaveBeenCalledWith('job-123', 'worker-1');
		expect(service._runBackgroundJob).toHaveBeenCalledWith(
			'job-123',
			expect.objectContaining({
				symbols: [expect.objectContaining({ raw: 'BINANCE:BTCUSDT' })],
			}),
			job.requestMetadata,
			null,
		);
	});

	it('asks BullMQ to retry when another worker still owns the claim', async () => {
		const repository = {
			claim: jest.fn().mockResolvedValue({ claimed: false, reason: 'active' }),
		};
		const service = new JobService(repository);

		await expect(service.processQueuedJob('job-123', null, 'worker-2')).rejects.toMatchObject({
			code: 'JOB_CLAIM_ACTIVE',
		});
	});
});
