'use strict';

const { JobBacklogService } = require('../../src/services/jobs/JobBacklogService');

describe('JobBacklogService', () => {
	const savedEnv = process.env;

	afterEach(() => {
		process.env = savedEnv;
		jest.clearAllMocks();
	});

	it('returns default status when uninitialized', () => {
		const service = new JobBacklogService();
		const status = service.getStatus();

		expect(status).toEqual({
			waitingCount: 0,
			delayedCount: 0,
			failedCount: 0,
			activeCount: 0,
			durableQueuedCount: 0,
			oldestQueuedAgeMs: null,
			oldestCreatedAt: null,
			lastProbedAt: null,
			backlogAlert: {
				active: false,
				thresholdMs: 900000,
				pagedAt: null,
				lastRecoveryAt: null,
			},
		});
	});

	it('probes memory repository when in local mode', async () => {
		const now = Date.now();
		const repository = {
			isConfigured: jest.fn(() => false),
			getMemoryBacklogDepth: jest.fn(() => ({
				durableQueuedCount: 2,
				oldestQueuedAgeMs: 120000,
				oldestCreatedAt: new Date(now - 120000).toISOString(),
			})),
		};

		const service = new JobBacklogService({ repository });
		const status = await service.probe(now);

		expect(repository.getMemoryBacklogDepth).toHaveBeenCalledWith(now);
		expect(status.durableQueuedCount).toBe(2);
		expect(status.oldestQueuedAgeMs).toBe(120000);
		expect(status.waitingCount).toBe(0);
		expect(status.backlogAlert.active).toBe(false);
	});

	it('probes BullMQ queue counts and Firestore backlog depth in render-worker mode', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			REDIS_URL: 'redis://localhost:6379',
		};

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn().mockResolvedValue({
				durableQueuedCount: 5,
				oldestQueuedAgeMs: 300000,
				oldestCreatedAt: new Date(now - 300000).toISOString(),
			}),
		};

		const queue = {
			getJobCounts: jest.fn().mockResolvedValue({
				waiting: 4,
				delayed: 1,
				failed: 0,
				active: 0,
				paused: 0,
			}),
		};

		const service = new JobBacklogService({ repository, queue });
		const status = await service.probe(now);

		expect(queue.getJobCounts).toHaveBeenCalled();
		expect(repository.getBacklogDepth).toHaveBeenCalledWith({ maxScan: 100, now });
		expect(status.waitingCount).toBe(4);
		expect(status.delayedCount).toBe(1);
		expect(status.durableQueuedCount).toBe(5);
		expect(status.oldestQueuedAgeMs).toBe(300000);
	});

	it('pages operators via Telegram when backlog age exceeds threshold', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000', // 10 minutes
			JOB_BACKLOG_PAGE_COOLDOWN_MS: '900000', // 15 minutes
		};

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn().mockResolvedValue({
				durableQueuedCount: 3,
				oldestQueuedAgeMs: 700000, // 11.6 minutes > 10m threshold
				oldestCreatedAt: new Date(now - 700000).toISOString(),
			}),
		};

		const queue = {
			getJobCounts: jest.fn().mockResolvedValue({
				waiting: 3,
				delayed: 0,
				failed: 0,
				active: 0,
			}),
		};

		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const botGetter = () => ({
			telegram: { sendMessage },
		});

		const service = new JobBacklogService({ repository, queue, botGetter });
		const status = await service.probe(now);

		expect(status.backlogAlert.active).toBe(true);
		expect(status.backlogAlert.pagedAt).toBe(new Date(now).toISOString());
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith(
			'admin-12345',
			expect.stringContaining('Job Backlog Alert'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});

	it('deduplicates operator pages within cooldown window', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000', // 10 minutes
			JOB_BACKLOG_PAGE_COOLDOWN_MS: '900000', // 15 minutes
		};

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn().mockResolvedValue({
				durableQueuedCount: 3,
				oldestQueuedAgeMs: 700000,
				oldestCreatedAt: new Date(now - 700000).toISOString(),
			}),
		};

		const queue = {
			getJobCounts: jest.fn().mockResolvedValue({
				waiting: 3,
				delayed: 0,
				failed: 0,
				active: 0,
			}),
		};

		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const botGetter = () => ({
			telegram: { sendMessage },
		});

		const service = new JobBacklogService({ repository, queue, botGetter });

		// First probe: sends alert
		await service.probe(now);
		expect(sendMessage).toHaveBeenCalledTimes(1);

		// Second probe (5 mins later, within 15 min cooldown): no duplicate page
		await service.probe(now + 300000);
		expect(sendMessage).toHaveBeenCalledTimes(1);

		// Third probe (16 mins later, cooldown expired): sends repeat alert
		await service.probe(now + 960000);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('sends recovery notification when backlog clears after an active alert', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
			JOB_BACKLOG_PAGE_COOLDOWN_MS: '900000',
		};

		let currentAgeMs = 700000;
		let currentDurable = 3;

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: currentDurable,
				oldestQueuedAgeMs: currentAgeMs,
				oldestCreatedAt: currentAgeMs ? new Date(now - currentAgeMs).toISOString() : null,
			})),
		};

		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({
				waiting: currentDurable,
				delayed: 0,
				failed: 0,
				active: 0,
			})),
		};

		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const botGetter = () => ({
			telegram: { sendMessage },
		});

		const service = new JobBacklogService({ repository, queue, botGetter });

		// Probe 1: Alert triggered
		await service.probe(now);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(service.getStatus().backlogAlert.active).toBe(true);

		// Backlog clears
		currentAgeMs = null;
		currentDurable = 0;

		// Probe 2: Recovery notification sent
		await service.probe(now + 60000);
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage).toHaveBeenLastCalledWith(
			'admin-12345',
			expect.stringContaining('Job Backlog Cleared'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
		expect(service.getStatus().backlogAlert.active).toBe(false);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).toBe(new Date(now + 60000).toISOString());
	});

	it('fails open when Telegram sendMessage fails', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '60000',
		};

		const repository = {
			isConfigured: jest.fn(() => false),
			getMemoryBacklogDepth: jest.fn(() => ({
				durableQueuedCount: 2,
				oldestQueuedAgeMs: 120000,
				oldestCreatedAt: new Date(now - 120000).toISOString(),
			})),
		};

		const logger = {
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
		};

		const botGetter = () => ({
			telegram: {
				sendMessage: jest.fn().mockRejectedValue(new Error('Network error')),
			},
		});

		const service = new JobBacklogService({ repository, botGetter, logger });

		// Should not throw
		await expect(service.probe(now)).resolves.toBeDefined();
		expect(logger.warn).toHaveBeenCalledWith(
			'[JobBacklogService] Failed to send Telegram backlog alert (fail-open)',
			expect.objectContaining({ error: 'Network error' }),
		);
	});

	it('does not record a page when Telegram reports an unsuccessful delivery', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '60000',
		};

		const repository = {
			isConfigured: jest.fn(() => false),
			getMemoryBacklogDepth: jest.fn(() => ({
				durableQueuedCount: 2,
				oldestQueuedAgeMs: 120000,
				oldestCreatedAt: new Date(now - 120000).toISOString(),
			})),
		};
		const sendMessage = jest.fn().mockResolvedValue({ success: false });
		const service = new JobBacklogService({
			repository,
			botGetter: () => ({ telegram: { sendMessage } }),
		});

		await service.probe(now);

		expect(service.getStatus().backlogAlert.active).toBe(false);
		expect(service.getStatus().backlogAlert.pagedAt).toBeNull();

		await service.probe(now + 120000);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('re-reads the probe interval after each scheduled probe', async () => {
		jest.useFakeTimers();
		try {
			process.env.JOB_BACKLOG_PROBE_INTERVAL_MS = '60000';
			const service = new JobBacklogService();
			service.probe = jest.fn().mockImplementation(async () => {
				process.env.JOB_BACKLOG_PROBE_INTERVAL_MS = '120000';
			});

			service.startMonitor({ unref: false });
			expect(service.timer).not.toBeNull();

			jest.advanceTimersByTime(60000);
			await Promise.resolve();
			await Promise.resolve();
			expect(service.probe).toHaveBeenCalledTimes(1);

			jest.advanceTimersByTime(119999);
			expect(service.probe).toHaveBeenCalledTimes(1);
			jest.advanceTimersByTime(1);
			await Promise.resolve();
			await Promise.resolve();
			expect(service.probe).toHaveBeenCalledTimes(2);

			service.stop();
			expect(service.timer).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});
});
