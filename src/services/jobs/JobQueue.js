'use strict';

const QUEUE_NAME = 'tradingview-jobs';
const JOB_NAME = 'tradingview-job';
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 30000;
const DEFAULT_CONCURRENCY = 1;

function getPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}

	return Math.min(parsed, max);
}

function isQueueExecutionEnabled() {
	return process.env.JOB_EXECUTION_MODE === 'render-worker';
}

function isBrokerConfigured() {
	return typeof process.env.REDIS_URL === 'string' && process.env.REDIS_URL.trim().length > 0;
}

class JobQueueUnavailableError extends Error {
	constructor(message = 'The asynchronous job queue is unavailable.') {
		super(message);
		this.name = 'JobQueueUnavailableError';
		this.code = 'JOB_QUEUE_UNAVAILABLE';
		this.statusCode = 503;
	}
}

class JobQueue {
	constructor({ QueueClass, WorkerClass, RedisClass } = {}) {
		this.QueueClass = QueueClass;
		this.WorkerClass = WorkerClass;
		this.RedisClass = RedisClass;
		this.queue = null;
		this.queueConnection = null;
		this.worker = null;
		this.workerConnections = new Map();
		this.pendingFailureHandlers = new Set();
		this.queueReady = false;
		this.accepting = true;
		this.readyPromise = null;
		this.metrics = {
			enqueued: 0,
			claimed: 0,
			completed: 0,
			failed: 0,
			lastErrorCode: null,
			lastEnqueuedAt: null,
		};
	}

	isEnabled() {
		return isQueueExecutionEnabled();
	}

	isConfigured() {
		return isBrokerConfigured();
	}

	async enqueue(jobId) {
		if (!this.isEnabled()) {
			return { queued: false, mode: 'local' };
		}

		this._assertAvailable();
		if (typeof jobId !== 'string' || !jobId) {
			throw new JobQueueUnavailableError('A jobId is required to enqueue an asynchronous job.');
		}

		try {
			const queue = await this._getQueue();
			await queue.add(
				JOB_NAME,
				{ jobId },
				{
					jobId,
					attempts: getPositiveInteger(process.env.JOB_QUEUE_ATTEMPTS, DEFAULT_ATTEMPTS, 20),
					backoff: {
						type: 'exponential',
						delay: getPositiveInteger(process.env.JOB_QUEUE_BACKOFF_MS, DEFAULT_BACKOFF_MS),
					},
					removeOnComplete: { count: 1000 },
					removeOnFail: { count: 1000 },
				},
			);
			this.metrics.enqueued += 1;
			this.metrics.lastEnqueuedAt = new Date().toISOString();
			return { queued: true, jobId };
		} catch (error) {
			this._recordError(error);
			throw new JobQueueUnavailableError();
		}
	}

	createWorker(processor, { onFailed } = {}) {
		this._assertAvailable();
		if (typeof processor !== 'function') {
			throw new TypeError('A queue worker processor is required.');
		}

		const Worker = this.WorkerClass || require('bullmq').Worker;
		const connection = this._createRedisConnection(true);
		const worker = new Worker(
			QUEUE_NAME,
			async (job) => {
				const jobId = job && job.data && job.data.jobId;
				if (typeof jobId !== 'string' || !jobId) {
					const error = new Error('Queue job is missing its jobId.');
					error.code = 'INVALID_QUEUE_PAYLOAD';
					throw error;
				}

				this.metrics.claimed += 1;
				const result = await processor(jobId, job);
				this.metrics.completed += 1;
				return result;
			},
			{
				connection,
				concurrency: getPositiveInteger(process.env.JOB_QUEUE_CONCURRENCY, DEFAULT_CONCURRENCY, 20),
			},
		);

		if (typeof worker.on === 'function') {
			worker.on('failed', (job, error) => {
				this.metrics.failed += 1;
				if (typeof onFailed === 'function') {
					const failurePromise = Promise.resolve()
						.then(() => onFailed(job, error))
						.catch((failure) => {
							console.warn('[JobQueue] Failed to release a queue claim:', failure.message);
						});
					this.pendingFailureHandlers.add(failurePromise);
					failurePromise.then(() => this.pendingFailureHandlers.delete(failurePromise));
				}
			});
			worker.on('error', (error) => this._recordError(error));
		}

		this.worker = worker;
		this.workerConnections.set(worker, connection);
		return worker;
	}

	async closeWorker(worker = this.worker) {
		this.accepting = false;
		if (!worker) {
			return;
		}

		try {
			if (typeof worker.close === 'function') {
				await worker.close();
			}
		} finally {
			while (this.pendingFailureHandlers.size > 0) {
				await Promise.all([...this.pendingFailureHandlers]);
			}
			await this._closeConnection(this.workerConnections.get(worker));
			this.workerConnections.delete(worker);
			if (this.worker === worker) {
				this.worker = null;
			}
		}
	}

	async close() {
		await this.closeWorker();
		if (this.queue && typeof this.queue.close === 'function') {
			await this.queue.close();
		}
		await this._closeConnection(this.queueConnection);
		this.queue = null;
		this.queueConnection = null;
		this.queueReady = false;
		this.readyPromise = null;
	}

	getStatus() {
		const enabled = this.isEnabled();
		const configured = this.isConfigured();
		let status = 'disabled';
		if (enabled) {
			status = configured ? (this.queueReady ? 'ready' : 'not_started') : 'misconfigured';
		}

		return {
			mode: enabled ? 'render-worker' : 'local',
			enabled,
			configured,
			ready: enabled && this.queueReady,
			status,
			queueName: QUEUE_NAME,
			enqueued: this.metrics.enqueued,
			claimed: this.metrics.claimed,
			completed: this.metrics.completed,
			failed: this.metrics.failed,
			lastErrorCode: this.metrics.lastErrorCode,
			lastEnqueuedAt: this.metrics.lastEnqueuedAt,
		};
	}

	_assertAvailable() {
		if (!this.isEnabled() || !this.isConfigured() || !this.accepting) {
			throw new JobQueueUnavailableError(
				!this.accepting
					? 'The asynchronous job queue is shutting down.'
					: 'JOB_EXECUTION_MODE=render-worker requires REDIS_URL.',
			);
		}
	}

	async _getQueue() {
		if (this.queue) {
			if (this.readyPromise) {
				await this.readyPromise;
			}
			return this.queue;
		}

		const Queue = this.QueueClass || require('bullmq').Queue;
		this.queueConnection = this._createRedisConnection(false);
		this.queue = new Queue(QUEUE_NAME, { connection: this.queueConnection });
		if (typeof this.queue.on === 'function') {
			this.queue.on('error', (error) => this._recordError(error));
		}

		this.readyPromise = typeof this.queue.waitUntilReady === 'function'
			? this.queue.waitUntilReady()
			: Promise.resolve();

		try {
			await this.readyPromise;
			this.queueReady = true;
			return this.queue;
		} catch (error) {
			this._recordError(error);
			const failedQueue = this.queue;
			const failedConnection = this.queueConnection;
			this.queue = null;
			this.queueConnection = null;
			this.queueReady = false;
			this.readyPromise = null;
			try {
				if (failedQueue && typeof failedQueue.close === 'function') {
					await failedQueue.close();
				}
			} catch (closeError) {
				this._recordError(closeError);
			}
			await this._closeConnection(failedConnection);
			throw new JobQueueUnavailableError();
		}
	}

	_createRedisConnection(forWorker) {
		const Redis = this.RedisClass || require('ioredis');
		return new Redis(process.env.REDIS_URL, {
			connectTimeout: getPositiveInteger(process.env.JOB_QUEUE_CONNECT_TIMEOUT_MS, 5000),
			lazyConnect: true,
			maxRetriesPerRequest: forWorker ? null : 1,
		});
	}

	_recordError(error) {
		this.metrics.lastErrorCode = error && error.code ? error.code : 'JOB_QUEUE_ERROR';
	}

	async _closeConnection(connection) {
		if (!connection) {
			return;
		}

		try {
			if (typeof connection.quit === 'function') {
				await connection.quit();
			} else if (typeof connection.disconnect === 'function') {
				connection.disconnect();
			}
		} catch (error) {
			if (typeof connection.disconnect === 'function') {
				connection.disconnect();
			}
		}
	}
}

const jobQueue = new JobQueue();

module.exports = {
	JobQueue,
	JobQueueUnavailableError,
	QUEUE_NAME,
	JOB_NAME,
	isQueueExecutionEnabled,
	jobQueue,
};
