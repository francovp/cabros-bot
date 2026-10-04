'use strict';

const { JobQueue } = require('../../src/services/jobs/JobQueue');

describe('JobQueue', () => {
	const savedEnv = process.env;

	afterEach(() => {
		process.env = savedEnv;
	});

	it('fails closed when render-worker mode has no Redis broker', async () => {
		process.env = { ...savedEnv, JOB_EXECUTION_MODE: 'render-worker' };
		delete process.env.REDIS_URL;

		const queue = new JobQueue();

		await expect(queue.enqueue('job-123')).rejects.toMatchObject({
			code: 'JOB_QUEUE_UNAVAILABLE',
			statusCode: 503,
		});
	});

	it('enqueues only the durable job reference with a stable BullMQ id', async () => {
		const add = jest.fn().mockResolvedValue({ id: 'job-123' });
		const waitUntilReady = jest.fn().mockResolvedValue(undefined);
		const queueClient = { add, waitUntilReady, close: jest.fn() };
		const QueueClass = jest.fn(() => queueClient);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ QueueClass, RedisClass });
		await queue.enqueue('job-123');

		expect(add).toHaveBeenCalledWith(
			'tradingview-job',
			{ jobId: 'job-123' },
			expect.objectContaining({ jobId: 'job-123', attempts: expect.any(Number) }),
		);
		expect(add.mock.calls[0][1]).toEqual({ jobId: 'job-123' });
	});

	it('treats an enqueue acknowledgement loss as accepted when BullMQ has the job', async () => {
		const add = jest.fn().mockRejectedValue(new Error('Redis connection lost after write'));
		const getJob = jest.fn().mockResolvedValue({ id: 'job-123', data: { jobId: 'job-123' } });
		const waitUntilReady = jest.fn().mockResolvedValue(undefined);
		const queueClient = { add, getJob, waitUntilReady, close: jest.fn() };
		const QueueClass = jest.fn(() => queueClient);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ QueueClass, RedisClass });

		await expect(queue.enqueue('job-123')).resolves.toEqual({ queued: true, jobId: 'job-123' });
		expect(getJob).toHaveBeenCalledWith('job-123');
	});

	it('retries an existing failed BullMQ job during durable reconciliation', async () => {
		const retry = jest.fn().mockResolvedValue(undefined);
		const getState = jest.fn().mockResolvedValue('failed');
		const getJob = jest.fn().mockResolvedValue({ getState, retry });
		const waitUntilReady = jest.fn().mockResolvedValue(undefined);
		const queueClient = { getJob, waitUntilReady, close: jest.fn() };
		const QueueClass = jest.fn(() => queueClient);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ QueueClass, RedisClass });

		await expect(queue.retryFailed('job-123')).resolves.toBe(true);
		expect(getJob).toHaveBeenCalledWith('job-123');
		expect(getState).toHaveBeenCalledTimes(1);
		expect(retry).toHaveBeenCalledWith('failed');
	});

	it('reports an indeterminate acceptance when queue reconciliation is unavailable', async () => {
		const add = jest.fn().mockRejectedValue(new Error('Redis connection lost after write'));
		const getJob = jest.fn().mockRejectedValue(new Error('Redis still unavailable'));
		const waitUntilReady = jest.fn().mockResolvedValue(undefined);
		const queueClient = { add, getJob, waitUntilReady, close: jest.fn() };
		const QueueClass = jest.fn(() => queueClient);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ QueueClass, RedisClass });

		await expect(queue.enqueue('job-123')).rejects.toMatchObject({
			code: 'JOB_QUEUE_ACCEPTANCE_UNKNOWN',
			statusCode: 503,
		});
	});

	it('can retry enqueue after an initial queue readiness failure', async () => {
		const firstClose = jest.fn().mockResolvedValue(undefined);
		const firstQueue = {
			waitUntilReady: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
			close: firstClose,
		};
		const secondAdd = jest.fn().mockResolvedValue({ id: 'job-456' });
		const secondQueue = {
			add: secondAdd,
			waitUntilReady: jest.fn().mockResolvedValue(undefined),
		};
		const QueueClass = jest.fn()
			.mockImplementationOnce(() => firstQueue)
			.mockImplementationOnce(() => secondQueue);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ QueueClass, RedisClass });

		await expect(queue.enqueue('job-123')).rejects.toMatchObject({
			code: 'JOB_QUEUE_UNAVAILABLE',
		});
		expect(queue.accepting).toBe(true);

		await expect(queue.enqueue('job-456')).resolves.toEqual({ queued: true, jobId: 'job-456' });
		expect(secondAdd).toHaveBeenCalled();
		expect(firstClose).toHaveBeenCalledTimes(1);
	});

	it('stops accepting work before closing a worker', async () => {
		const close = jest.fn().mockResolvedValue(undefined);
		const worker = { close };
		const WorkerClass = jest.fn(() => worker);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ WorkerClass, RedisClass });
		const created = queue.createWorker(jest.fn());
		await queue.closeWorker(created);

		expect(close).toHaveBeenCalledTimes(1);
	});

	it('waits for failed-event finalization before closing a worker', async () => {
		let failedHandler;
		let resolveFailure;
		const close = jest.fn().mockResolvedValue(undefined);
		const worker = {
			on: jest.fn((event, handler) => {
				if (event === 'failed') failedHandler = handler;
			}),
			close,
		};
		const WorkerClass = jest.fn(() => worker);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));
		const onFailed = jest.fn(() => new Promise((resolve) => {
			resolveFailure = resolve;
		}));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ WorkerClass, RedisClass });
		const created = queue.createWorker(jest.fn(), { onFailed });
		failedHandler({ data: { jobId: 'job-123' } }, new Error('worker failure'));

		let settled = false;
		const closing = queue.closeWorker(created).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveFailure();
		await closing;
		expect(onFailed).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('returns queue job counts in render-worker mode', async () => {
		const counts = { waiting: 2, delayed: 1, failed: 0, active: 3, paused: 0 };
		const getJobCounts = jest.fn().mockResolvedValue(counts);
		const waitUntilReady = jest.fn().mockResolvedValue(undefined);
		const queueClient = { getJobCounts, waitUntilReady, close: jest.fn() };
		const QueueClass = jest.fn(() => queueClient);
		const RedisClass = jest.fn(() => ({ disconnect: jest.fn() }));

		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://queue.example:6379',
		};

		const queue = new JobQueue({ QueueClass, RedisClass });
		const result = await queue.getJobCounts();

		expect(result).toEqual({ waiting: 2, delayed: 1, failed: 0, active: 3, paused: 0 });
		expect(getJobCounts).toHaveBeenCalledWith('waiting', 'delayed', 'failed', 'active', 'paused');
	});

	it('includes backlog depth in getStatus', () => {
		const queue = new JobQueue();
		const backlog = {
			waitingCount: 5,
			delayedCount: 2,
			failedCount: 1,
			activeCount: 3,
			durableQueuedCount: 7,
			oldestQueuedAgeMs: 450000,
			backlogAlert: {
				active: false,
				thresholdMs: 900000,
				pagedAt: null,
				lastRecoveryAt: null,
			},
		};

		const status = queue.getStatus(backlog);
		expect(status.waitingCount).toBe(5);
		expect(status.delayedCount).toBe(2);
		expect(status.failedCount).toBe(1);
		expect(status.activeCount).toBe(3);
		expect(status.durableQueuedCount).toBe(7);
		expect(status.oldestQueuedAgeMs).toBe(450000);
		expect(status.backlogAlert).toEqual({
			active: false,
			thresholdMs: 900000,
			pagedAt: null,
			lastRecoveryAt: null,
		});
	});

	it('preserves an unknown durable depth through the queue projection', () => {
		// An explicit null means the last sweep could not observe durable state.
		// Defaulting it to 0 would publish an apparently empty backlog next to
		// durableProbeSucceeded: false, so a client reading the count would see a
		// drained queue that was never actually read.
		const queue = new JobQueue();
		const status = queue.getStatus({ durableQueuedCount: null, durableProbeSucceeded: false });

		expect(status.durableQueuedCount).toBeNull();
		expect(status.durableProbeSucceeded).toBe(false);
	});

	it('defaults the durable depth to zero only when no backlog service reported', () => {
		// Absent is different from explicitly unknown: with no service at all there
		// is genuinely nothing to observe, and the documented schema allows null
		// for the unknown case.
		const queue = new JobQueue();
		const status = queue.getStatus({});

		expect(status.durableQueuedCount).toBe(0);
	});

	describe('broker readiness probe (#1117)', () => {
		function healthyQueueClass() {
			return jest.fn(() => ({
				add: jest.fn().mockResolvedValue({ id: 'job-1' }),
				waitUntilReady: jest.fn().mockResolvedValue(undefined),
				close: jest.fn().mockResolvedValue(undefined),
			}));
		}

		it('reports a healthy broker as ready without requiring an enqueued job', async () => {
			// The cutover validation in #1117 asserts status "ready" right after
			// flipping JOB_EXECUTION_MODE. Readiness used to be set only as a side
			// effect of _getQueue(), which runs on the first enqueue, so a freshly
			// cut-over and completely idle deployment reported "not_started" and
			// looked like a failed enablement.
			process.env = {
				...savedEnv,
				JOB_EXECUTION_MODE: 'render-worker',
				REDIS_URL: 'redis://queue.example:6379',
			};

			const queue = new JobQueue({ QueueClass: healthyQueueClass(), RedisClass: jest.fn(() => ({ disconnect: jest.fn() })) });

			expect(queue.getStatus({}).status).toBe('not_started');

			await expect(queue.probeBrokerReadiness()).resolves.toMatchObject({ reachable: true });

			const status = queue.getStatus({});
			expect(status.status).toBe('ready');
			expect(status.ready).toBe(true);
			expect(status.brokerReachable).toBe(true);
			expect(typeof status.lastBrokerProbeAt).toBe('string');
			expect(status.lastBrokerProbeErrorCode).toBeNull();
		});

		it('distinguishes an unreachable broker from a broker that was never probed', async () => {
			// isConfigured() only string-checks REDIS_URL, so a dead broker and a
			// healthy one used to report an identical enabled/configured/ready/status
			// tuple. An operator could not tell a working cut-over from a broken one
			// without waiting for a job to fail.
			process.env = {
				...savedEnv,
				JOB_EXECUTION_MODE: 'render-worker',
				REDIS_URL: 'redis://queue.example:6379',
			};

			const failingWaitUntilReady = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
			const QueueClass = jest.fn(() => ({ waitUntilReady: failingWaitUntilReady, close: jest.fn() }));
			const queue = new JobQueue({ QueueClass, RedisClass: jest.fn(() => ({ disconnect: jest.fn() })) });

			expect(queue.getStatus({}).brokerReachable).toBeNull();

			await expect(queue.probeBrokerReadiness()).resolves.toMatchObject({ reachable: false });

			const status = queue.getStatus({});
			expect(status.status).toBe('unreachable');
			expect(status.ready).toBe(false);
			expect(status.brokerReachable).toBe(false);
			expect(status.lastBrokerProbeErrorCode).toBeTruthy();
			expect(status.configured).toBe(true);
		});

		it('skips the probe and reports misconfigured when no broker URL is set', async () => {
			process.env = { ...savedEnv, JOB_EXECUTION_MODE: 'render-worker' };
			delete process.env.REDIS_URL;

			const QueueClass = healthyQueueClass();
			const queue = new JobQueue({ QueueClass, RedisClass: jest.fn(() => ({ disconnect: jest.fn() })) });

			await expect(queue.probeBrokerReadiness()).resolves.toMatchObject({ reachable: false, skipped: true });

			const status = queue.getStatus({});
			expect(status.status).toBe('misconfigured');
			expect(status.brokerReachable).toBeNull();
			expect(QueueClass).not.toHaveBeenCalled();
		});

		it('bounds a stalled broker with JOB_QUEUE_PROBE_TIMEOUT_MS and fails open', async () => {
			process.env = {
				...savedEnv,
				JOB_EXECUTION_MODE: 'render-worker',
				REDIS_URL: 'redis://queue.example:6379',
				JOB_QUEUE_PROBE_TIMEOUT_MS: '25',
			};

			// A broker that accepts the connection but never completes the handshake:
			// the probe must give up on its own deadline instead of hanging a
			// status request or blocking startup.
			const QueueClass = jest.fn(() => ({
				waitUntilReady: () => new Promise(() => {}),
				close: jest.fn(),
			}));
			const queue = new JobQueue({ QueueClass, RedisClass: jest.fn(() => ({ disconnect: jest.fn() })) });

			await expect(queue.probeBrokerReadiness()).resolves.toMatchObject({ reachable: false });
			expect(queue.getStatus({}).status).toBe('unreachable');
		});

		it('falls back to the documented probe deadline when the configured value is malformed', async () => {
			process.env = {
				...savedEnv,
				JOB_EXECUTION_MODE: 'render-worker',
				REDIS_URL: 'redis://queue.example:6379',
				JOB_QUEUE_PROBE_TIMEOUT_MS: 'not-a-number',
			};

			const QueueClass = jest.fn(() => ({
				waitUntilReady: () => new Promise(() => {}),
				close: jest.fn(),
			}));
			const queue = new JobQueue({ QueueClass, RedisClass: jest.fn(() => ({ disconnect: jest.fn() })) });

			jest.useFakeTimers();
			try {
				let settled = false;
				const probe = queue.probeBrokerReadiness().then((result) => {
					settled = true;
					return result;
				});

				// The default is 5000ms, so a NaN or 0 deadline would have blown
				// through this and reported a verdict immediately.
				await jest.advanceTimersByTimeAsync(4999);
				expect(settled).toBe(false);

				await jest.advanceTimersByTimeAsync(2);
				await expect(probe).resolves.toMatchObject({
					reachable: false,
					errorCode: 'JOB_QUEUE_PROBE_TIMEOUT',
				});
			} finally {
				jest.useRealTimers();
			}
		});

		it('single-flights concurrent probes so one deployment connects once', async () => {
			process.env = {
				...savedEnv,
				JOB_EXECUTION_MODE: 'render-worker',
				REDIS_URL: 'redis://queue.example:6379',
			};

			const QueueClass = healthyQueueClass();
			const queue = new JobQueue({ QueueClass, RedisClass: jest.fn(() => ({ disconnect: jest.fn() })) });

			const [first, second] = await Promise.all([
				queue.probeBrokerReadiness(),
				queue.probeBrokerReadiness(),
			]);

			expect(first).toMatchObject({ reachable: true });
			expect(second).toMatchObject({ reachable: true });
			expect(QueueClass).toHaveBeenCalledTimes(1);
		});

		it('never throws out of the probe so a status call cannot fail', async () => {
			process.env = {
				...savedEnv,
				JOB_EXECUTION_MODE: 'render-worker',
				REDIS_URL: 'redis://queue.example:6379',
			};

			const QueueClass = jest.fn(() => {
				throw new Error('redis constructor exploded');
			});
			const queue = new JobQueue({ QueueClass, RedisClass: jest.fn(() => ({ disconnect: jest.fn() })) });

			await expect(queue.probeBrokerReadiness()).resolves.toMatchObject({ reachable: false });
			expect(() => queue.getStatus({})).not.toThrow();
		});
	});
});
