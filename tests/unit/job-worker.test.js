'use strict';

const { JobService } = require('../../src/services/jobs/JobService');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
			'worker-1',
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

	it('persists a terminal failure for a final worker attempt', async () => {
		const repository = {
			failClaim: jest.fn().mockResolvedValue(true),
			get: jest.fn().mockResolvedValue({ jobId: 'job-123', status: 'failed' }),
		};
		const service = new JobService(repository);
		service._triggerCallbackIfConfigured = jest.fn().mockResolvedValue(undefined);
		const error = Object.assign(new Error('permanent failure'), { code: 'PERMANENT_FAILURE' });

		await expect(service.failQueuedJob('job-123', 'worker-1', error)).resolves.toBe(true);

		expect(repository.failClaim).toHaveBeenCalledWith('job-123', 'worker-1', error);
		expect(service._triggerCallbackIfConfigured).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: 'job-123', status: 'failed' }),
		);
	});

	it('renews a render-worker claim while processing a job', async () => {
		const previousLeaseMs = process.env.JOB_QUEUE_CLAIM_LEASE_MS;
		process.env.JOB_QUEUE_CLAIM_LEASE_MS = '20';
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'claimed', workerId: 'worker-1' },
			createdAt: new Date().toISOString(),
		};
		const repository = {
			get: jest.fn().mockResolvedValue(job),
			save: jest.fn().mockResolvedValue('job-123'),
			renewClaim: jest.fn().mockResolvedValue(true),
		};
		const service = new JobService(repository);
		let finishExecution;
		service._executeExpandedAnalysis = jest.fn().mockReturnValue(new Promise((resolve) => {
			finishExecution = resolve;
		}));
		service._triggerCallbackIfConfigured = jest.fn().mockResolvedValue(undefined);

		try {
			const runPromise = service._runBackgroundJob('job-123', {}, null, null, 'worker-1');
			await delay(30);
			expect(service._executeExpandedAnalysis).toHaveBeenCalled();
			expect(repository.renewClaim).toHaveBeenCalledWith('job-123', 'worker-1');
			finishExecution();
			await runPromise;
		} finally {
			if (previousLeaseMs === undefined) {
				delete process.env.JOB_QUEUE_CLAIM_LEASE_MS;
			} else {
				process.env.JOB_QUEUE_CLAIM_LEASE_MS = previousLeaseMs;
			}
		}
	});

	it('aborts and skips persistence when a render-worker claim is lost', async () => {
		const previousLeaseMs = process.env.JOB_QUEUE_CLAIM_LEASE_MS;
		process.env.JOB_QUEUE_CLAIM_LEASE_MS = '20';
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'claimed', workerId: 'worker-1' },
			createdAt: new Date().toISOString(),
		};
		const repository = {
			get: jest.fn().mockResolvedValue(job),
			save: jest.fn().mockResolvedValue('job-123'),
			renewClaim: jest.fn().mockResolvedValue(false),
		};
		const service = new JobService(repository);
		const execution = new Promise((resolve) => {
			service._executeExpandedAnalysis = jest.fn((currentJob, parsed, signal) => {
				signal.addEventListener('abort', resolve, { once: true });
				return execution;
			});
		});

		try {
			const run = service._runBackgroundJob(
				'job-123',
				{ symbols: [{ raw: 'BINANCE:BTCUSDT' }] },
				job.requestMetadata,
				null,
				'worker-1',
			);
			await delay(30);
			await execution;
			await run;
			expect(repository.renewClaim).toHaveBeenCalled();
			expect(repository.save).toHaveBeenCalledTimes(1);
		} finally {
			if (previousLeaseMs === undefined) delete process.env.JOB_QUEUE_CLAIM_LEASE_MS;
			else process.env.JOB_QUEUE_CLAIM_LEASE_MS = previousLeaseMs;
		}
	});

	it('rejects queued execution when claim renewal storage fails', async () => {
		const previousLeaseMs = process.env.JOB_QUEUE_CLAIM_LEASE_MS;
		process.env.JOB_QUEUE_CLAIM_LEASE_MS = '20';
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'claimed', workerId: 'worker-1' },
			createdAt: new Date().toISOString(),
		};
		const renewalError = Object.assign(new Error('Firestore unavailable'), {
			code: 'JOB_CLAIM_RENEWAL_UNAVAILABLE',
		});
		const repository = {
			get: jest.fn().mockResolvedValue(job),
			save: jest.fn().mockResolvedValue('job-123'),
			renewClaim: jest.fn().mockRejectedValue(renewalError),
		};
		const service = new JobService(repository);
		const execution = new Promise((resolve) => {
			service._executeExpandedAnalysis = jest.fn((currentJob, parsed, signal) => {
				signal.addEventListener('abort', resolve, { once: true });
				return execution;
			});
		});

		try {
			const run = service._runBackgroundJob(
				'job-123',
				{ symbols: [{ raw: 'BINANCE:BTCUSDT' }] },
				job.requestMetadata,
				null,
				'worker-1',
			);
			const runOutcome = run.then(
				() => ({ code: 'UNEXPECTED_SUCCESS' }),
				(error) => error,
			);
			await delay(30);
			await execution;
			await expect(runOutcome).resolves.toMatchObject({ code: 'JOB_CLAIM_RENEWAL_UNAVAILABLE' });
			expect(repository.save).toHaveBeenCalledTimes(1);
		} finally {
			if (previousLeaseMs === undefined) delete process.env.JOB_QUEUE_CLAIM_LEASE_MS;
			else process.env.JOB_QUEUE_CLAIM_LEASE_MS = previousLeaseMs;
		}
	});
});
