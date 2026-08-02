'use strict';

const { JobRepository, _resetForTesting } = require('../../src/services/jobs/JobRepository');

describe('JobRepository durable claims', () => {
	it('prefers a fresh durable row over a stale web-process cache entry', async () => {
		const jobId = 'job-list-123';
		const durableJob = {
			jobId,
			type: 'expanded-analysis',
			status: 'completed',
			createdAt: new Date().toISOString(),
		};
		const query = {
			orderBy: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			get: jest.fn().mockResolvedValue({
				docs: [{ id: jobId, data: () => durableJob }],
			}),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => ({
			collection: jest.fn(() => query),
		}));
		repository.setMemory(jobId, { ...durableJob, status: 'processing' });

		try {
			await expect(repository.list({ limit: 1 })).resolves.toEqual([
				expect.objectContaining({ jobId, status: 'completed' }),
			]);
		} finally {
			_resetForTesting();
		}
	});

	it('pushes a status filter into the Firestore reconciliation query', async () => {
		const processingJob = {
			jobId: 'job-processing-123',
			status: 'processing',
			createdAt: new Date().toISOString(),
		};
		const query = {
			where: jest.fn().mockReturnThis(),
			orderBy: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			get: jest.fn().mockResolvedValue({
				docs: [{ id: processingJob.jobId, data: () => processingJob }],
			}),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => ({
			collection: jest.fn(() => query),
		}));

		try {
			await expect(repository.list({ status: 'processing', limit: 1 })).resolves.toEqual([
				expect.objectContaining({ jobId: processingJob.jobId }),
			]);
			expect(query.where).toHaveBeenCalledWith('status', '==', 'processing');
			expect(query.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
		} finally {
			_resetForTesting();
		}
	});

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

	it('marks a claimed job as failed after the final worker attempt', async () => {
		const job = {
			jobId: 'job-123',
			status: 'processing',
			execution: {
				mode: 'render-worker',
				status: 'running',
				workerId: 'worker-1',
				claimedAt: new Date().toISOString(),
				leaseUntil: new Date(Date.now() + 60000).toISOString(),
			},
		};
		const repository = new JobRepository();
		repository.get = jest.fn().mockResolvedValue(job);
		repository.save = jest.fn().mockResolvedValue('job-123');
		const error = Object.assign(new Error('permanent failure'), { code: 'PERMANENT_FAILURE' });

		await expect(repository.failClaim('job-123', 'worker-1', error)).resolves.toBe(true);
		expect(repository.save).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 'failed',
				error: 'permanent failure',
				code: 'PERMANENT_FAILURE',
				execution: expect.objectContaining({
					status: 'failed',
					workerId: null,
					leaseUntil: null,
				}),
			}),
			{ required: true },
		);
	});

	it('renews an active claim for its owning worker', async () => {
		const oldLeaseUntil = new Date(Date.now() + 1000).toISOString();
		const job = {
			jobId: 'job-123',
			status: 'processing',
			execution: {
				mode: 'render-worker',
				status: 'running',
				workerId: 'worker-1',
				claimedAt: new Date().toISOString(),
				leaseUntil: oldLeaseUntil,
			},
		};
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({ exists: true, id: job.jobId, data: () => job }),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.renewClaim('job-123', 'worker-1')).resolves.toBe(true);

		const renewed = transaction.set.mock.calls[0][1];
		expect(renewed.execution).toEqual(expect.objectContaining({ workerId: 'worker-1', status: 'running' }));
		expect(Date.parse(renewed.execution.leaseUntil)).toBeGreaterThan(Date.parse(oldLeaseUntil));
	});

	it('accepts a same-attempt renewal after terminal finalization', async () => {
		const job = {
			jobId: 'job-123',
			status: 'completed',
			execution: {
				mode: 'render-worker',
				status: 'completed',
				workerId: 'worker-1',
				attempt: 3,
				leaseUntil: null,
			},
		};
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({ exists: true, id: job.jobId, data: () => job }),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.renewClaim('job-123', 'worker-1', 3)).resolves.toBe(true);
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('updates claims transactionally only for the current worker owner', async () => {
		const job = {
			jobId: 'job-123',
			status: 'processing',
			execution: {
				mode: 'render-worker',
				status: 'running',
				workerId: 'worker-2',
			},
		};
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({ exists: true, id: job.jobId, data: () => job }),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);
		const error = Object.assign(new Error('stale worker'), { code: 'STALE_WORKER' });

		await expect(repository.releaseClaim('job-123', 'worker-1', error)).resolves.toBe(false);
		await expect(repository.failClaim('job-123', 'worker-1', error)).resolves.toBe(false);

		expect(firestore.runTransaction).toHaveBeenCalledTimes(2);
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('rejects claim updates from an older processing attempt', async () => {
		const job = {
			jobId: 'job-123',
			status: 'processing',
			execution: {
				mode: 'render-worker',
				status: 'running',
				workerId: 'worker-1',
				attempt: 2,
			},
		};
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({ exists: true, id: job.jobId, data: () => job }),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);
		const error = Object.assign(new Error('stale attempt'), { code: 'STALE_ATTEMPT' });

		await expect(repository.releaseClaim('job-123', 'worker-1', error, 1)).resolves.toBe(false);
		await expect(repository.failClaim('job-123', 'worker-1', error, 1)).resolves.toBe(false);

		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('rejects durable worker saves from an older processing attempt', async () => {
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({
					jobId: 'job-123',
					status: 'processing',
					execution: {
						mode: 'render-worker',
						status: 'running',
						workerId: 'worker-1',
						attempt: 2,
					},
				}),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.save({
			jobId: 'job-123',
			status: 'processing',
			execution: {
				mode: 'render-worker',
				status: 'running',
				workerId: 'worker-1',
				attempt: 1,
			},
		}, { required: true })).resolves.toBeNull();

		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('rejects claim renewal from an older processing attempt', async () => {
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({
					jobId: 'job-123',
					status: 'processing',
					execution: {
						mode: 'render-worker',
						status: 'running',
						workerId: 'worker-1',
						attempt: 2,
					},
				}),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.renewClaim('job-123', 'worker-1', 1)).resolves.toBe(false);
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('does not overwrite a terminal job during a save transaction', async () => {
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({ jobId: 'job-123', status: 'cancelled' }),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.save({ jobId: 'job-123', status: 'completed' }, { required: true })).resolves.toBeNull();

		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('rejects a durable save from a worker that no longer owns the claim', async () => {
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({
					jobId: 'job-123',
					status: 'processing',
					execution: { mode: 'render-worker', status: 'running', workerId: 'worker-2' },
				}),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.save({
			jobId: 'job-123',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'running', workerId: 'worker-1' },
		}, { required: true })).resolves.toBeNull();

		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('rejects an ownerless nonterminal save during an active claim', async () => {
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({
					jobId: 'job-123',
					status: 'processing',
					execution: { mode: 'render-worker', status: 'running', workerId: 'worker-1' },
				}),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.save({
			jobId: 'job-123',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'queued' },
		}, { required: true })).resolves.toBeNull();

		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('merges callback metadata without replaying a claimed job snapshot', async () => {
		const docRef = {};
		const currentJob = {
			jobId: 'job-123',
			status: 'processing',
			progress: { current: 3 },
			execution: { mode: 'render-worker', status: 'running', workerId: 'worker-1', attempt: 2 },
			callbackStatus: { status: 'pending', attempts: [] },
		};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => currentJob,
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.updateCallbackStatus('job-123', 'completed', {
			status: 'success',
			attempts: [{ attempt: 1, statusCode: 200 }],
		})).resolves.toBe(true);

		expect(transaction.set).toHaveBeenCalledWith(
			docRef,
			expect.objectContaining({
				progress: { current: 3 },
				execution: currentJob.execution,
				callbackStatus: {
					status: 'success',
					attempts: [{ attempt: 1, statusCode: 200 }],
					events: {
						completed: {
							status: 'success',
							attempts: [{ attempt: 1, statusCode: 200 }],
						},
					},
				},
			}),
		);
	});

	it('preserves current callback metadata during worker saves', async () => {
		const docRef = {};
		const callbackStatus = {
			status: 'success',
			attempts: [{ attempt: 1, statusCode: 200 }],
			events: {
				processing: {
					status: 'success',
					attempts: [{ attempt: 1, statusCode: 200 }],
				},
			},
		};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({
					jobId: 'job-123',
					status: 'processing',
					execution: { mode: 'render-worker', status: 'running', workerId: 'worker-1', attempt: 2 },
					callbackStatus,
				}),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.save({
			jobId: 'job-123',
			status: 'processing',
			execution: { mode: 'render-worker', status: 'running', workerId: 'worker-1', attempt: 2 },
			callbackStatus: { status: 'pending', attempts: [] },
		}, { required: true })).resolves.toBe('job-123');

		expect(transaction.set).toHaveBeenCalledWith(
			docRef,
			expect.objectContaining({ callbackStatus }),
		);
	});

	it('propagates callback status persistence failures', async () => {
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({})) })),
			runTransaction: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.updateCallbackStatus('job-123', 'completed', {
			status: 'success',
			attempts: [{ attempt: 1, statusCode: 200 }],
		})).rejects.toMatchObject({ code: 'JOB_CALLBACK_STATUS_UNAVAILABLE' });
	});

	it('claims callback events transactionally and only takes over expired reservations', async () => {
		const docRef = {};
		const pendingJob = {
			jobId: 'job-123',
			status: 'completed',
			callbackStatus: { status: 'pending', attempts: [] },
		};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => pendingJob,
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.claimCallbackDelivery('job-123', 'completed', 'delivery-1'))
			.resolves.toBe(true);
		expect(transaction.set).toHaveBeenCalledWith(
			docRef,
			expect.objectContaining({
				callbackStatus: expect.objectContaining({
					events: expect.objectContaining({
						completed: expect.objectContaining({
							status: 'in_flight',
							deliveryId: 'delivery-1',
						}),
					}),
				}),
			}),
		);

		transaction.set.mockClear();
		transaction.get.mockResolvedValue({
			exists: true,
			id: 'job-123',
			data: () => ({
				...pendingJob,
				callbackStatus: {
					status: 'in_flight',
					attempts: [],
					events: {
						completed: {
							status: 'in_flight',
							deliveryId: 'delivery-1',
							startedAt: new Date().toISOString(),
						},
					},
				},
			}),
		});
		await expect(repository.claimCallbackDelivery('job-123', 'completed', 'delivery-2'))
			.rejects.toMatchObject({ code: 'JOB_CALLBACK_DELIVERY_IN_FLIGHT' });
		expect(transaction.set).not.toHaveBeenCalled();

		transaction.get.mockResolvedValue({
			exists: true,
			id: 'job-123',
			data: () => ({
				...pendingJob,
				callbackStatus: {
					status: 'in_flight',
					attempts: [],
					events: {
						completed: {
							status: 'in_flight',
							deliveryId: 'delivery-1',
							startedAt: new Date(Date.now() - 120000).toISOString(),
						},
					},
				},
			}),
		});
		await expect(repository.claimCallbackDelivery('job-123', 'completed', 'delivery-2'))
			.resolves.toBe(true);
		expect(transaction.set).toHaveBeenCalledWith(
			docRef,
			expect.objectContaining({
				callbackStatus: expect.objectContaining({
					events: expect.objectContaining({
						completed: expect.objectContaining({ deliveryId: 'delivery-2' }),
					}),
				}),
			}),
		);
	});

	it('does not claim a processing callback after terminal status advances', async () => {
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({
					jobId: 'job-123',
					status: 'completed',
					callbackStatus: { status: 'pending', attempts: [] },
				}),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => docRef) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.claimCallbackDelivery('job-123', 'processing', 'delivery-1'))
			.resolves.toBe(false);
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('rejects an active callback claim so terminal redelivery remains retryable', async () => {
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				id: 'job-123',
				data: () => ({
					jobId: 'job-123',
					status: 'completed',
					callbackStatus: {
						status: 'in_flight',
						events: {
							completed: {
								status: 'in_flight',
								startedAt: new Date().toISOString(),
							},
						},
					},
				}),
			}),
			set: jest.fn(),
		};
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({})) })),
			runTransaction: jest.fn(async callback => callback(transaction)),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.claimCallbackDelivery('job-123', 'completed', 'delivery-2'))
			.rejects.toMatchObject({ code: 'JOB_CALLBACK_DELIVERY_IN_FLIGHT' });
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('propagates callback claim storage failures', async () => {
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({})) })),
			runTransaction: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
		};
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => firestore);

		await expect(repository.claimCallbackDelivery('job-123', 'completed', 'delivery-1'))
			.rejects.toMatchObject({ code: 'JOB_CALLBACK_CLAIM_UNAVAILABLE' });
	});

	it('rejects claim renewal when durable storage is unavailable', async () => {
		const repository = new JobRepository();
		repository._getFirestore = jest.fn(() => null);

		await expect(repository.renewClaim('job-123', 'worker-1')).rejects.toMatchObject({
			code: 'JOB_CLAIM_RENEWAL_UNAVAILABLE',
		});
	});
});
