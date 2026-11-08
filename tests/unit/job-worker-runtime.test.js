'use strict';

const {
	FINAL_FAILURE_MAX_ATTEMPTS,
	FINAL_FAILURE_RETRY_DELAY_MS,
	JOB_QUEUE_RECONCILIATION_INTERVAL_MS,
	JOB_POLL_DEFAULT_INTERVAL_MS,
	startJobWorker,
} = require('../../src/services/jobs/jobWorker');

describe('job worker runtime', () => {
	const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;

	beforeEach(() => {
		process.env.WORKER_STARTUP_JITTER_MS = '0';
	});

	afterAll(() => {
		if (previousJitter === undefined) {
			delete process.env.WORKER_STARTUP_JITTER_MS;
		} else {
			process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
		}
	});

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

	it('uses published global jitter over a non-zero environment value', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		const previousRemoteConfigEnabled = process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		process.env.WORKER_STARTUP_JITTER_MS = '1000';
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
		remoteConfigService._setRemoteOverridesForTesting({ WORKER_STARTUP_JITTER_MS: 2000 });
		const randomIntSpy = jest.spyOn(require('crypto'), 'randomInt').mockReturnValue(1500);
		jest.useFakeTimers();
		let runtime;
		try {
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn(() => ({ id: 'worker-remote-jitter' })),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = { processQueuedJob: jest.fn() };
			runtime = await startJobWorker({ queue, service, workerId: 'worker-remote-jitter' });

			await jest.advanceTimersByTimeAsync(1499);
			expect(queue.createWorker).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(1);
			await runtime.ready;

			expect(randomIntSpy).toHaveBeenCalledWith(0, 2001);
			expect(queue.createWorker).toHaveBeenCalledTimes(1);
		} finally {
			if (runtime) await runtime.stop();
			remoteConfigService.stop();
			remoteConfigService._resetForTesting();
			jest.useRealTimers();
			randomIntSpy.mockRestore();
			if (previousJitter === undefined) delete process.env.WORKER_STARTUP_JITTER_MS;
			else process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			if (previousRemoteConfigEnabled === undefined) delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			else process.env.ENABLE_FIREBASE_REMOTE_CONFIG = previousRemoteConfigEnabled;
		}
	});

	it('returns the runtime before a no-jitter queue worker becomes ready', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		const previousRemoteConfigEnabled = process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		process.env.WORKER_STARTUP_JITTER_MS = '0';
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'false';
		let resolveQueueReady;
		const queueReady = new Promise((resolve) => { resolveQueueReady = resolve; });
		const queue = {
			isEnabled: () => true,
			createWorker: jest.fn(() => ({
				id: 'worker-pending-ready',
				waitUntilReady: () => queueReady,
			})),
			closeWorker: jest.fn().mockResolvedValue(undefined),
		};
		const service = { processQueuedJob: jest.fn() };
		const startPromise = startJobWorker({ queue, service, workerId: 'worker-pending-ready' });
		let returnedEarly = false;
		let runtime;

		try {
			const firstResult = await Promise.race([
				startPromise.then((value) => ({ returned: true, value })),
				new Promise((resolve) => setImmediate(() => resolve({ returned: false }))),
			]);
			returnedEarly = firstResult.returned;
			if (returnedEarly) {
				runtime = firstResult.value;
				await runtime.stop();
				expect(queue.closeWorker).toHaveBeenCalledTimes(1);
			}
			resolveQueueReady();
			runtime = runtime || await startPromise;
			await runtime.ready;
			if (!returnedEarly) await runtime.stop();

			expect(returnedEarly).toBe(true);
			expect(queue.closeWorker).toHaveBeenCalledTimes(1);
		} finally {
			resolveQueueReady();
			if (runtime && !returnedEarly) await runtime.stop();
			if (previousJitter === undefined) delete process.env.WORKER_STARTUP_JITTER_MS;
			else process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			if (previousRemoteConfigEnabled === undefined) delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			else process.env.ENABLE_FIREBASE_REMOTE_CONFIG = previousRemoteConfigEnabled;
		}
	});

	it('schedules durable queued-job reconciliation while the worker is running', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		process.env.WORKER_STARTUP_JITTER_MS = '0';
		jest.useFakeTimers();
		try {
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn(() => ({ id: 'worker-1' })),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = {
				processQueuedJob: jest.fn(),
				reconcileQueuedJobs: jest.fn().mockResolvedValue(1),
			};

			const runtime = await startJobWorker({ queue, service, workerId: 'worker-1' });
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(1);

			await jest.advanceTimersByTimeAsync(JOB_QUEUE_RECONCILIATION_INTERVAL_MS);
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(2);

			await runtime.stop();
			await jest.advanceTimersByTimeAsync(JOB_QUEUE_RECONCILIATION_INTERVAL_MS);
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(2);
		} finally {
			jest.useRealTimers();
			if (previousJitter === undefined) {
				delete process.env.WORKER_STARTUP_JITTER_MS;
			} else {
				process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			}
		}
	});

	it('waits for startup jitter before the first and recurring job reconciliation', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		process.env.WORKER_STARTUP_JITTER_MS = '50';
		const randomIntSpy = jest.spyOn(require('crypto'), 'randomInt').mockReturnValue(50);
		jest.useFakeTimers();
		try {
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn(() => ({ id: 'worker-1' })),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = {
				processQueuedJob: jest.fn(),
				reconcileQueuedJobs: jest.fn().mockResolvedValue(1),
			};

			const runtime = await startJobWorker({ queue, service, workerId: 'worker-1' });
			expect(service.reconcileQueuedJobs).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(49);
			expect(service.reconcileQueuedJobs).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(1);
			await Promise.resolve();
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(1);
			await runtime.stop();
		} finally {
			jest.useRealTimers();
			randomIntSpy.mockRestore();
			if (previousJitter === undefined) {
				delete process.env.WORKER_STARTUP_JITTER_MS;
			} else {
				process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			}
		}
	});

	it('does not create a BullMQ consumer until startup jitter expires', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		process.env.WORKER_STARTUP_JITTER_MS = '50';
		const randomIntSpy = jest.spyOn(require('crypto'), 'randomInt').mockReturnValue(50);
		jest.useFakeTimers();
		let runtime;
		try {
			const worker = { id: 'worker-1', waitUntilReady: jest.fn().mockResolvedValue(undefined) };
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn(() => worker),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = {
				processQueuedJob: jest.fn(),
				reconcileQueuedJobs: jest.fn().mockResolvedValue(1),
			};

			runtime = await startJobWorker({ queue, service, workerId: 'worker-1' });
			expect(queue.createWorker).not.toHaveBeenCalled();
			expect(service.reconcileQueuedJobs).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(49);
			expect(queue.createWorker).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(1);
			await runtime.ready;

			expect(queue.createWorker).toHaveBeenCalledTimes(1);
			expect(worker.waitUntilReady).toHaveBeenCalledTimes(1);
			expect(service.reconcileQueuedJobs).toHaveBeenCalledTimes(1);
		} finally {
			if (runtime) await runtime.stop();
			jest.useRealTimers();
			randomIntSpy.mockRestore();
			if (previousJitter === undefined) {
				delete process.env.WORKER_STARTUP_JITTER_MS;
			} else {
				process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			}
		}
	});

	it('delays the first Firestore poll schedule until startup jitter expires', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		const previousMode = process.env.JOB_EXECUTION_MODE;
		process.env.WORKER_STARTUP_JITTER_MS = '50';
		process.env.JOB_EXECUTION_MODE = 'firestore-poller';
		const randomIntSpy = jest.spyOn(require('crypto'), 'randomInt').mockReturnValue(50);
		jest.useFakeTimers();
		const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
		let runtime;
		try {
			const repository = { list: jest.fn().mockResolvedValue([]) };
			runtime = await startJobWorker({ service: { repository }, workerId: 'worker-fp-1', unref: false });
			expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
			expect(setTimeoutSpy.mock.results[0].value.hasRef()).toBe(true);
			expect(setTimeoutSpy.mock.calls[0][1]).toBe(50);
			await jest.advanceTimersByTimeAsync(49);
			expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
			await jest.advanceTimersByTimeAsync(1);
			expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
			expect(setTimeoutSpy.mock.calls[1][1]).toBe(JOB_POLL_DEFAULT_INTERVAL_MS);
			expect(setTimeoutSpy.mock.results[1].value.hasRef()).toBe(true);
			expect(repository.list).not.toHaveBeenCalled();
			await runtime.stop();
			expect(jest.getTimerCount()).toBe(0);
		} finally {
			if (runtime) await runtime.stop();
			jest.useRealTimers();
			setTimeoutSpy.mockRestore();
			randomIntSpy.mockRestore();
			if (previousJitter === undefined) {
				delete process.env.WORKER_STARTUP_JITTER_MS;
			} else {
				process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			}
			if (previousMode === undefined) {
				delete process.env.JOB_EXECUTION_MODE;
			} else {
				process.env.JOB_EXECUTION_MODE = previousMode;
			}
		}
	});

	it('keeps standalone startup jitter referenced and cancels it on stop', async () => {
		const previousJitter = process.env.WORKER_STARTUP_JITTER_MS;
		process.env.WORKER_STARTUP_JITTER_MS = '50';
		const randomIntSpy = jest.spyOn(require('crypto'), 'randomInt').mockReturnValue(50);
		jest.useFakeTimers();
		const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
		try {
			const queue = {
				isEnabled: () => true,
				createWorker: jest.fn(() => ({ id: 'worker-1' })),
				closeWorker: jest.fn().mockResolvedValue(undefined),
			};
			const service = {
				processQueuedJob: jest.fn(),
				reconcileQueuedJobs: jest.fn().mockResolvedValue(1),
			};

			const runtime = await startJobWorker({ queue, service, workerId: 'worker-1', unref: false });
			expect(setTimeoutSpy.mock.results[0].value.hasRef()).toBe(true);
			await runtime.stop();
			expect(jest.getTimerCount()).toBe(0);
			await jest.advanceTimersByTimeAsync(50);
			expect(service.reconcileQueuedJobs).not.toHaveBeenCalled();
			expect(queue.createWorker).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
			jest.useRealTimers();
			randomIntSpy.mockRestore();
			if (previousJitter === undefined) {
				delete process.env.WORKER_STARTUP_JITTER_MS;
			} else {
				process.env.WORKER_STARTUP_JITTER_MS = previousJitter;
			}
		}
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

	it('bounds terminal failure persistence retries', async () => {
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
				failQueuedJob: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
			};
			await startJobWorker({ queue, service, workerId: 'worker-1' });
			const finalJob = { data: { jobId: 'job-123' }, attemptsMade: 3, opts: { attempts: 3 } };
			const finalError = Object.assign(new Error('permanent failure'), {
				code: 'PERMANENT_FAILURE',
				claimAttempt: 3,
			});
			const finalization = onFailed(finalJob, finalError);

			for (let retry = 1; retry < FINAL_FAILURE_MAX_ATTEMPTS; retry++) {
				await jest.advanceTimersByTimeAsync(FINAL_FAILURE_RETRY_DELAY_MS);
			}

			await expect(finalization).resolves.toBe(false);
			expect(service.failQueuedJob).toHaveBeenCalledTimes(FINAL_FAILURE_MAX_ATTEMPTS);
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
		expect(service.failQueuedJob).not.toHaveBeenCalled();
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

	describe('firestore-poller mode', () => {
		const originalMode = process.env.JOB_EXECUTION_MODE;

		beforeEach(() => {
			process.env.JOB_EXECUTION_MODE = 'firestore-poller';
		});

		afterEach(() => {
			if (originalMode !== undefined) {
				process.env.JOB_EXECUTION_MODE = originalMode;
			} else {
				delete process.env.JOB_EXECUTION_MODE;
			}
		});

		it('polls and processes queued jobs without initializing Redis or BullMQ', async () => {
			const queue = {
				isEnabled: jest.fn(() => false),
				createWorker: jest.fn(),
			};
			const repository = {
				list: jest.fn().mockResolvedValue([
					{
						jobId: 'job-1',
						status: 'processing',
						execution: { mode: 'firestore-poller', status: 'queued' },
					},
					{
						jobId: 'job-other',
						status: 'processing',
						execution: { mode: 'render-worker', status: 'queued' },
					},
				]),
			};
			const service = {
				repository,
				processQueuedJob: jest.fn().mockResolvedValue(undefined),
				releaseQueuedJob: jest.fn(),
				failQueuedJob: jest.fn(),
				waitForCallbacks: jest.fn().mockResolvedValue(undefined),
			};

			const runtime = await startJobWorker({ queue, service, workerId: 'worker-fp-1' });
			await runtime.pollOnce();
			await runtime.stop();

			expect(queue.createWorker).not.toHaveBeenCalled();
			expect(repository.list).toHaveBeenCalledWith({ status: 'processing', limit: 50 });
			expect(service.processQueuedJob).toHaveBeenCalledWith('job-1', null, 'worker-fp-1');
			expect(service.processQueuedJob).not.toHaveBeenCalledWith('job-other', expect.anything(), expect.anything());
			expect(service.waitForCallbacks).toHaveBeenCalledTimes(1);
		});

		it('polls expired claims and handles race conditions safely', async () => {
			const repository = {
				list: jest.fn().mockResolvedValue([
					{
						jobId: 'job-expired',
						status: 'processing',
						execution: {
							mode: 'firestore-poller',
							status: 'running',
							leaseUntil: new Date(Date.now() - 5000).toISOString(),
						},
					},
					{
						jobId: 'job-active-claim',
						status: 'processing',
						execution: {
							mode: 'firestore-poller',
							status: 'running',
							leaseUntil: new Date(Date.now() + 60000).toISOString(),
						},
					},
				]),
			};
			const raceError = Object.assign(new Error('Job claim is active'), { code: 'JOB_CLAIM_ACTIVE' });
			const service = {
				repository,
				processQueuedJob: jest.fn().mockRejectedValue(raceError),
				releaseQueuedJob: jest.fn(),
				failQueuedJob: jest.fn(),
				waitForCallbacks: jest.fn().mockResolvedValue(undefined),
			};

			const runtime = await startJobWorker({ service, workerId: 'worker-fp-1' });
			await runtime.pollOnce();
			await runtime.stop();

			expect(service.processQueuedJob).toHaveBeenCalledWith('job-expired', null, 'worker-fp-1');
			expect(service.processQueuedJob).not.toHaveBeenCalledWith('job-active-claim', expect.anything(), expect.anything());
			expect(service.releaseQueuedJob).not.toHaveBeenCalled();
			expect(service.failQueuedJob).not.toHaveBeenCalled();
		});

		it('releases retryable claims when attempts remain and fails when max attempts reached', async () => {
			const repository = {
				list: jest.fn().mockResolvedValue([
					{
						jobId: 'job-retryable',
						status: 'processing',
						execution: { mode: 'firestore-poller', status: 'queued' },
					},
					{
						jobId: 'job-final-fail',
						status: 'processing',
						execution: { mode: 'firestore-poller', status: 'queued' },
					},
				]),
			};
			const retryError = Object.assign(new Error('transient network glitch'), {
				claimAttempt: 2,
				code: 'NETWORK_ERROR',
			});
			const finalError = Object.assign(new Error('fatal error'), {
				claimAttempt: 5,
				code: 'FATAL_ERROR',
			});
			const service = {
				repository,
				processQueuedJob: jest.fn()
					.mockRejectedValueOnce(retryError)
					.mockRejectedValueOnce(finalError),
				releaseQueuedJob: jest.fn().mockResolvedValue(true),
				failQueuedJob: jest.fn().mockResolvedValue(true),
				waitForCallbacks: jest.fn().mockResolvedValue(undefined),
			};

			const runtime = await startJobWorker({ service, workerId: 'worker-fp-1' });
			await runtime.pollOnce();
			await runtime.stop();

			expect(service.releaseQueuedJob).toHaveBeenCalledWith('job-retryable', 'worker-fp-1', retryError, 2);
			expect(service.failQueuedJob).toHaveBeenCalledWith('job-final-fail', 'worker-fp-1', finalError, 5);
		});
	});

	describe('Worker environment controls (#855)', () => {
		const originalEnv = { ...process.env };

		afterEach(() => {
			process.env = { ...originalEnv };
		});

		it('honors mirrored MARKET_SCANNER_DEFAULT_EXCHANGE for market scanner job parsing', () => {
			const { parseMarketScannerRequest } = require('../../src/services/tradingview/marketScannerReport');

			process.env.MARKET_SCANNER_DEFAULT_EXCHANGE = 'NASDAQ';
			const parsedNasdaq = parseMarketScannerRequest({ body: {} });
			expect(parsedNasdaq.exchange).toBe('NASDAQ');

			delete process.env.MARKET_SCANNER_DEFAULT_EXCHANGE;
			const parsedDefault = parseMarketScannerRequest({ body: {} });
			expect(parsedDefault.exchange).toBe('BINANCE');
		});

		it('honors mirrored ENABLE_NOTIFICATION_REDRIVE for failed job delivery recording', async () => {
			const NotificationManager = require('../../src/services/notification/NotificationManager');
			const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');
			const recordSpy = jest.spyOn(notificationRedriveService, 'recordDeliveryResults').mockResolvedValue(['job-scanner-1_telegram']);

			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
			const channel = {
				name: 'telegram',
				isEnabled: () => true,
				send: jest.fn().mockResolvedValue({
					success: false,
					channel: 'telegram',
					error: 'Network timeout',
					category: 'TIMEOUT',
				}),
			};

			const manager = new NotificationManager(channel);
			const alert = {
				text: 'Market scanner report',
				source: 'job_worker',
				jobId: 'job-scanner-1',
			};

			await manager.sendToAll(alert);

			expect(recordSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					text: 'Market scanner report',
					source: 'job_worker',
					jobId: 'job-scanner-1',
				}),
				expect.arrayContaining([
					expect.objectContaining({
						channel: 'telegram',
						category: 'TIMEOUT',
						error: 'Network timeout',
					}),
				]),
				expect.any(Object),
			);

			recordSpy.mockRestore();
		});
	});
});
