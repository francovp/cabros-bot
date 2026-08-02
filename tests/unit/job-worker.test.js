'use strict';

const { JobService } = require('../../src/services/jobs/JobService');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('queued job execution', () => {
	it('preserves the custom Bollinger threshold from queued metadata', () => {
		const service = new JobService({});

		const parsed = service._parseQueuedJob({
			type: 'market-scanner',
			requestMetadata: {
				type: 'market-scanner',
				exchange: 'BINANCE',
				timeframe: '4h',
				scans: ['bollinger_scan'],
				limit: 5,
				bbwThreshold: 0.12,
				ranked: false,
				includeMultiTimeframe: false,
			},
		});

		expect(parsed.bbwThreshold).toBe(0.12);
	});

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

	it('reconciles callbacks when a terminal job is redelivered', async () => {
		const terminalJob = {
			jobId: 'job-123',
			status: 'completed',
			callbackUrl: 'https://example.com/callback',
			callbackEvents: ['completed'],
			callbackStatus: { status: 'pending', attempts: [] },
		};
		const repository = {
			claim: jest.fn().mockResolvedValue({ claimed: false, reason: 'terminal' }),
			get: jest.fn().mockResolvedValue(terminalJob),
		};
		const service = new JobService(repository);
		service._triggerCallbackIfConfigured = jest.fn().mockResolvedValue(undefined);

		await expect(service.processQueuedJob('job-123', null, 'worker-1')).resolves.toEqual({
			skipped: true,
			reason: 'terminal',
		});

		expect(service._triggerCallbackIfConfigured).toHaveBeenCalledWith(
			terminalJob,
			{ awaitDelivery: true },
		);
	});

	it('waits for callback reconciliation before acknowledging terminal redelivery', async () => {
		const terminalJob = {
			jobId: 'job-123',
			status: 'completed',
			callbackUrl: 'https://example.com/callback',
			callbackEvents: ['completed'],
			callbackStatus: { status: 'pending', attempts: [] },
		};
		const repository = {
			claim: jest.fn().mockResolvedValue({ claimed: false, reason: 'terminal' }),
			get: jest.fn().mockResolvedValue(terminalJob),
		};
		const service = new JobService(repository);
		let resolveCallback;
		service._sendCallbackWithRetry = jest.fn(() => new Promise((resolve) => {
			resolveCallback = resolve;
		}));

		let settled = false;
		const run = service.processQueuedJob('job-123', null, 'worker-1').then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));

		expect(settled).toBe(false);
		resolveCallback();
		await expect(run).resolves.toEqual({ skipped: true, reason: 'terminal' });
	});

	it('does not replay a delivery with a completed durable checkpoint', async () => {
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			createdAt: new Date().toISOString(),
			execution: {
				mode: 'render-worker',
				status: 'claimed',
				workerId: 'worker-1',
				attempt: 2,
			},
			requestMetadata: {
				type: 'expanded-analysis',
				symbols: ['BINANCE:BTCUSDT'],
			},
			fullResults: [{ symbol: 'BINANCE:BTCUSDT', status: 'analyzed' }],
			fullScanResults: [],
			deliveryCheckpoint: {
				status: 'completed',
				results: [{ success: true, channel: 'telegram', messageId: 'message-1' }],
			},
		};
		const repository = {
			get: jest.fn().mockResolvedValue(job),
			save: jest.fn().mockResolvedValue(job.jobId),
		};
		const service = new JobService(repository);
		service._executeExpandedAnalysis = jest.fn();
		service._triggerCallbackIfConfigured = jest.fn().mockResolvedValue(undefined);

		await service._runBackgroundJob(
			job.jobId,
			{ symbols: [{ raw: 'BINANCE:BTCUSDT' }] },
			job.requestMetadata,
			null,
			'worker-1',
		);

		expect(service._executeExpandedAnalysis).not.toHaveBeenCalled();
		expect(service._triggerCallbackIfConfigured).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'completed' }),
			{ awaitDelivery: true },
		);
	});

	it('stops a redelivered job when the prior notification outcome is unknown', async () => {
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			createdAt: new Date().toISOString(),
			execution: {
				mode: 'render-worker',
				status: 'claimed',
				workerId: 'worker-1',
				attempt: 2,
			},
			requestMetadata: {
				type: 'expanded-analysis',
			symbols: ['BINANCE:BTCUSDT'],
			},
			deliveryCheckpoint: { status: 'in_flight', deliveryId: 'delivery-1' },
		};
		const repository = {
			get: jest.fn().mockResolvedValue(job),
			save: jest.fn().mockResolvedValue(job.jobId),
		};
		const service = new JobService(repository);
		service._executeExpandedAnalysis = jest.fn();

		await expect(service._runBackgroundJob(
			job.jobId,
			{ symbols: [{ raw: 'BINANCE:BTCUSDT' }] },
			job.requestMetadata,
			null,
			'worker-1',
		)).rejects.toMatchObject({ code: 'JOB_DELIVERY_RECONCILIATION_REQUIRED' });

		expect(service._executeExpandedAnalysis).not.toHaveBeenCalled();
	});

	it('persists a durable delivery checkpoint around notification sending', async () => {
		const job = {
			jobId: 'job-123',
			status: 'processing',
			execution: {
				mode: 'render-worker',
				status: 'running',
				workerId: 'worker-1',
				attempt: 2,
			},
			_workerId: 'worker-1',
		};
		const savedJobs = [];
		const repository = {
			get: jest.fn().mockResolvedValue(job),
			save: jest.fn().mockImplementation(async (currentJob) => {
				savedJobs.push(JSON.parse(JSON.stringify(currentJob)));
				return currentJob.jobId;
			}),
		};
		const service = new JobService(repository);
		const results = [{ success: true, channel: 'telegram', messageId: 'message-1' }];
		const notificationManager = {
			sendToAll: jest.fn().mockResolvedValue(results),
			getEnabledChannels: () => ['telegram'],
		};

		await expect(service._sendQueuedNotification(
			job,
			notificationManager,
			{ text: 'BTC alert' },
			{},
		)).resolves.toEqual(results);

		expect(savedJobs[0]).toEqual(
			expect.objectContaining({
				deliveryCheckpoint: expect.objectContaining({ status: 'in_flight' }),
			}),
		);
		expect(notificationManager.sendToAll).toHaveBeenCalledTimes(1);
		expect(savedJobs[1]).toEqual(
			expect.objectContaining({
				deliveryCheckpoint: expect.objectContaining({
					status: 'completed',
					results,
				}),
			}),
		);
	});

	it('preserves a completed delivery when checkpoint persistence fails after sending', async () => {
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			execution: {
				mode: 'render-worker',
				status: 'claimed',
				workerId: 'worker-1',
				attempt: 2,
			},
			_workerId: 'worker-1',
			fullResults: [{ status: 'analyzed' }],
			fullScanResults: [],
		};
		const savedJobs = [];
		const checkpointError = new Error('Firestore checkpoint unavailable');
		const repository = {
			get: jest.fn().mockResolvedValue(job),
			save: jest.fn().mockImplementation(async currentJob => {
				savedJobs.push(JSON.parse(JSON.stringify(currentJob)));
				return currentJob.jobId;
			}),
		};
		const service = new JobService(repository);
		const results = [{ success: true, channel: 'telegram', messageId: 'message-1' }];
		service._executeExpandedAnalysis = jest.fn(async currentJob => {
			currentJob.deliveryResults = results;
			currentJob.deliveryCheckpoint = {
				status: 'completed',
				results,
			};
			throw checkpointError;
		});
		service._triggerCallbackIfConfigured = jest.fn().mockResolvedValue(undefined);

		await expect(service._runBackgroundJob(
			job.jobId,
			{},
			null,
			null,
			'worker-1',
		)).resolves.toBeUndefined();

		expect(savedJobs.at(-1)).toEqual(expect.objectContaining({
			status: 'completed',
			deliveryCheckpoint: expect.objectContaining({ status: 'completed', results }),
		}));
		expect(service._triggerCallbackIfConfigured).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'completed' }),
			{ awaitDelivery: true },
		);
	});

	it('binds processor failures to the Firestore claim attempt', async () => {
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'claimed', workerId: 'worker-1', attempt: 4 },
			requestMetadata: {
				type: 'expanded-analysis',
				symbols: ['BINANCE:BTCUSDT'],
			},
		};
		const repository = {
			claim: jest.fn().mockResolvedValue({ claimed: true, job }),
		};
		const service = new JobService(repository);
		const error = new Error('worker failed');
		service._runBackgroundJob = jest.fn().mockRejectedValue(error);

		await expect(service.processQueuedJob('job-123', null, 'worker-1')).rejects.toMatchObject({
			claimAttempt: 4,
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
			{ awaitDelivery: true },
		);
	});

	it('rejects worker persistence when the durable save loses ownership', async () => {
		const repository = {
			get: jest.fn().mockResolvedValue({ jobId: 'job-123' }),
			save: jest.fn().mockResolvedValue(null),
		};
		const service = new JobService(repository);
		const job = {
			jobId: 'job-123',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'running', workerId: 'worker-1' },
			_workerId: 'worker-1',
		};

		await expect(service._persistJob(job)).rejects.toMatchObject({ code: 'JOB_CLAIM_LOST' });
	});

	it('renews a render-worker claim while processing a job', async () => {
		const previousLeaseMs = process.env.JOB_QUEUE_CLAIM_LEASE_MS;
		process.env.JOB_QUEUE_CLAIM_LEASE_MS = '20';
		const job = {
			jobId: 'job-123',
			type: 'expanded-analysis',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'claimed', workerId: 'worker-1', attempt: 3 },
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
		expect(repository.renewClaim).toHaveBeenCalledWith('job-123', 'worker-1', 3);
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
