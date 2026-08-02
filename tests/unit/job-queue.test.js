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
});
