'use strict';

const { JobRepository } = require('../../src/services/jobs/JobRepository');

describe('JobRepository durable claims', () => {
	it('atomically claims a queued job and rejects an active duplicate claim', async () => {
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'queued' },
			requestMetadata: { type: 'expanded-analysis', symbols: ['BINANCE:BTCUSDT'] },
		};
		const docRef = {};
		const snapshot = { exists: true, id: job.jobId, data: () => job };
		const transaction = {
			get: jest.fn().mockResolvedValue(snapshot),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		const firstClaim = await repository.claim('job-123', 'worker-1');

		expect(firstClaim).toMatchObject({ claimed: true, job: { jobId: 'job-123' } });
		expect(transaction.set).toHaveBeenCalledWith(
			docRef,
			expect.objectContaining({
				execution: expect.objectContaining({
					status: 'claimed',
					workerId: 'worker-1',
				}),
			}),
		);

		const activeJob = {
			...job,
			execution: {
				...job.execution,
				status: 'claimed',
				claimedAt: new Date().toISOString(),
			},
		};
		transaction.get.mockResolvedValueOnce({ exists: true, id: job.jobId, data: () => activeJob });
		transaction.set.mockClear();

		const duplicateClaim = await repository.claim('job-123', 'worker-2');

		expect(duplicateClaim).toEqual({ claimed: false, reason: 'active' });
		expect(transaction.set).not.toHaveBeenCalled();
	});
});
