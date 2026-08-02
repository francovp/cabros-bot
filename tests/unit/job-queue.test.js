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
});
