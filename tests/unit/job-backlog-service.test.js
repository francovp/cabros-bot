'use strict';

const { JobBacklogService } = require('../../src/services/jobs/JobBacklogService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

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
			enabled: true,
			running: false,
			waitingCount: 0,
			delayedCount: 0,
			failedCount: 0,
			activeCount: 0,
			durableQueuedCount: 0,
			durableQueuedTruncated: false,
			durableScanRotated: false,
			durableProbeSucceeded: null,
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

	it('does not send a false recovery page when a probe fails transiently after an active alert', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
			JOB_BACKLOG_PAGE_COOLDOWN_MS: '900000',
		};

		let probeShouldFail = false;

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => (probeShouldFail
				? Promise.reject(new Error('firestore blip'))
				: Promise.resolve({
					durableQueuedCount: 3,
					oldestQueuedAgeMs: 700000,
					oldestCreatedAt: new Date(now - 700000).toISOString(),
				}))),
		};

		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 3, delayed: 0, failed: 0, active: 0 })),
		};

		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const service = new JobBacklogService({ repository, queue, botGetter: () => ({ telegram: { sendMessage } }) });

		await service.probe(now);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(service.getStatus().backlogAlert.active).toBe(true);

		// Transient probe failure must NOT be read as "backlog drained".
		probeShouldFail = true;
		await service.probe(now + 60000);

		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).not.toHaveBeenLastCalledWith(
			expect.anything(),
			expect.stringContaining('Job Backlog Cleared'),
			expect.anything(),
		);
		expect(service.getStatus().backlogAlert.active).toBe(true);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).toBeNull();

		// Once the probe recovers, the alert is still latched — no re-page inside cooldown.
		probeShouldFail = false;
		await service.probe(now + 120000);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(service.getStatus().backlogAlert.active).toBe(true);
	});

	it('keeps the alert active and retries the all-clear when the recovery send reports an unsuccessful delivery', async () => {
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
		let recoveryShouldSucceed = true;

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
				waiting: currentDurable, delayed: 0, failed: 0, active: 0,
			})),
		};

		const sendMessage = jest.fn()
			.mockResolvedValueOnce({ message_id: 1 })
			// First recovery attempt resolves { success: false } rather than rejecting.
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ message_id: 3 });

		const service = new JobBacklogService({ repository, queue, botGetter: () => ({ telegram: { sendMessage } }) });

		await service.probe(now);
		expect(service.getStatus().backlogAlert.active).toBe(true);

		// Backlog drains, but the recovery notification fails to deliver.
		currentAgeMs = null;
		currentDurable = 0;
		recoveryShouldSucceed = false;
		await service.probe(now + 60000);

		// The latch must survive: clearing it would strand the incident silently.
		expect(service.getStatus().backlogAlert.active).toBe(true);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).toBeNull();

		// The next probe retries the all-clear and only then clears the latch.
		recoveryShouldSucceed = true;
		await service.probe(now + 120000);
		expect(sendMessage).toHaveBeenCalledTimes(3);
		expect(service.getStatus().backlogAlert.active).toBe(false);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).not.toBeNull();
	});

	it('pages when only the admin chat is configured and the broadcast channel is disabled', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			// No TELEGRAM_CHAT_ID: the broadcast channel is legitimately disabled.
			TELEGRAM_CHAT_ID: '',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
		};

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 5,
				oldestQueuedAgeMs: 700000,
				oldestCreatedAt: new Date(now - 700000).toISOString(),
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 5, delayed: 0, failed: 0, active: 0 })),
		};

		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		// isEnabled() is false (no broadcast chat), but admin delivery is eligible.
		const telegramService = {
			isEnabled: () => false,
			isAdminDeliveryEligible: () => true,
			send: sendMessage,
		};

		const service = new JobBacklogService({
			repository,
			queue,
			telegramServiceGetter: () => telegramService,
		});

		await service.probe(now);

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				telegramChatId: 'admin-12345',
				text: expect.stringContaining('Job Backlog Alert'),
			}),
		);
		expect(service.getStatus().backlogAlert.active).toBe(true);
	});

	it('bounds a hung broker probe so backlog reporting keeps running fail-open', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			JOB_BACKLOG_PROBE_TIMEOUT_MS: '1000',
		};

		// Simulates a half-open broker connection: getJobCounts() never settles.
		const queue = {
			getJobCounts: jest.fn(() => new Promise(() => {})),
		};
		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 2,
				oldestQueuedAgeMs: 120000,
				oldestCreatedAt: new Date(now - 120000).toISOString(),
			})),
		};

		const service = new JobBacklogService({ repository, queue });
		const started = Date.now();
		const status = await service.probe(now);
		const elapsed = Date.now() - started;

		// The probe returns within its deadline instead of hanging forever.
		expect(elapsed).toBeLessThan(5000);
		expect(status.waitingCount).toBe(0);
		// The broker slot is wedged, but the durable slot is independent, so depth
		// is still reported from Firestore.
		expect(status.durableQueuedCount).toBe(2);
		expect(status.oldestQueuedAgeMs).toBe(120000);
	});

	it('reports backlogMonitorEnabled false so a disabled monitor is distinguishable from a healthy queue', () => {
		const saved = process.env.ENABLE_JOB_BACKLOG_MONITOR;
		process.env = { ...savedEnv, ENABLE_JOB_BACKLOG_MONITOR: 'false' };
		try {
			const service = new JobBacklogService();
			const status = service.getStatus();
			expect(status.enabled).toBe(false);
			expect(status.durableQueuedCount).toBe(0);
		} finally {
			if (saved === undefined) delete process.env.ENABLE_JOB_BACKLOG_MONITOR;
			else process.env.ENABLE_JOB_BACKLOG_MONITOR = saved;
		}
	});

	it('treats a durable probe that fell back to memory as indeterminate, not drained', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
		};

		// getBacklogDepth() swallows its Firestore error and returns an empty
		// memory result, flagged via probeFailed. A web replica's process-local
		// map is empty, so this must not read as "backlog drained".
		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 0,
				oldestQueuedAgeMs: null,
				oldestCreatedAt: null,
				source: 'firestore-error',
				probeFailed: true,
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 0, delayed: 0, failed: 0, active: 0 })),
		};
		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const service = new JobBacklogService({ repository, queue, botGetter: () => ({ telegram: { sendMessage } }) });

		await service.probe(now);

		expect(service.getStatus().backlogAlert.active).toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(service.getStatus().backlogAlert.lastRecoveryAt).toBeNull();
	});

	it('does not stack a new probe on top of a timed-out one that is still outstanding', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			JOB_BACKLOG_PROBE_TIMEOUT_MS: '1000',
		};

		const getJobCounts = jest.fn(() => new Promise(() => {}));
		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 0,
				oldestQueuedAgeMs: null,
				oldestCreatedAt: null,
			})),
		};
		const service = new JobBacklogService({ repository, queue: { getJobCounts } });

		await service.probe(now);
		// The broker call timed out but is still pending internally.
		expect(getJobCounts).toHaveBeenCalledTimes(1);
		expect(service.outstandingProbes.broker.size).toBe(1);

		await service.probe(now + 60000);
		// The second sweep must not open a second connection for the same work.
		expect(getJobCounts).toHaveBeenCalledTimes(1);
	});

	it('keeps the durable probe observable while the broker call is still outstanding', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			JOB_BACKLOG_PROBE_TIMEOUT_MS: '1000',
		};

		const queue = { getJobCounts: jest.fn(() => new Promise(() => {})) };
		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 7,
				oldestQueuedAgeMs: 900000,
				oldestCreatedAt: new Date(now - 900000).toISOString(),
			})),
		};
		const service = new JobBacklogService({ repository, queue });

		const status = await service.probe(now);

		// The broker is wedged, but backlog depth is still reported from Firestore.
		expect(getBacklogCalls()).toBe(1);
		expect(status.durableQueuedCount).toBe(7);
		expect(status.oldestQueuedAgeMs).toBe(900000);
		expect(status.waitingCount).toBe(0);

		function getBacklogCalls() {
			return repository.getBacklogDepth.mock.calls.length;
		}
	});

	it('keeps a skipped durable probe indeterminate so it cannot clear an active alert', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
			JOB_BACKLOG_PROBE_TIMEOUT_MS: '1000',
		};

		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const healthyRepository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 3,
				oldestQueuedAgeMs: 700000,
				oldestCreatedAt: new Date(now - 700000).toISOString(),
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 3, delayed: 0, failed: 0, active: 0 })),
		};
		const service = new JobBacklogService({ repository: healthyRepository, queue, botGetter: () => ({ telegram: { sendMessage } }) });

		// Establish a latched alert from a healthy probe.
		await service.probe(now);
		expect(service.getStatus().backlogAlert.active).toBe(true);
		expect(sendMessage).toHaveBeenCalledTimes(1);

		// The broker now hangs and stays outstanding, so the durable read is skipped.
		// A skipped probe produced no result and must stay indeterminate -- it is
		// unknown, not drained.
		queue.getJobCounts = jest.fn(() => new Promise(() => {}));
		await service.probe(now + 60000);

		expect(service.getStatus().backlogAlert.active).toBe(true);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).toBeNull();
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it('exposes durableQueuedTruncated so a bounded scan is not read as a complete depth', async () => {
		const now = Date.now();
		process.env = { ...savedEnv, JOB_EXECUTION_MODE: 'render-worker' };

		// Drive the real projection path: the repository reports that the scan hit
		// its page cap, and getStatus() must surface that rather than defaulting to
		// false. Seeding lastProbe directly would bypass the naming this covers.
		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 500,
				oldestQueuedAgeMs: 900000,
				oldestCreatedAt: new Date(now - 900000).toISOString(),
				truncated: true,
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 0, delayed: 0, failed: 0, active: 0 })),
		};
		const service = new JobBacklogService({ repository, queue });

		const probed = await service.probe(now);
		expect(probed.durableQueuedTruncated).toBe(true);

		const status = service.getStatus();
		expect(status.durableQueuedCount).toBe(500);
		expect(status.durableQueuedTruncated).toBe(true);
	});

	it('reports durableQueuedTruncated false when the scan completed within its page budget', async () => {
		const now = Date.now();
		process.env = { ...savedEnv, JOB_EXECUTION_MODE: 'render-worker' };

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 2,
				oldestQueuedAgeMs: 1000,
				oldestCreatedAt: new Date(now - 1000).toISOString(),
				truncated: false,
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 0, delayed: 0, failed: 0, active: 0 })),
		};
		const service = new JobBacklogService({ repository, queue });

		await service.probe(now);
		expect(service.getStatus().durableQueuedTruncated).toBe(false);
	});

	it('keeps the alert active when an injected notifyAdmin callback reports an unsuccessful recovery', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
		};

		let age = 700000;
		let recoveryDelivered = true;
		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: age ? 3 : 0,
				oldestQueuedAgeMs: age,
				oldestCreatedAt: age ? new Date(now - age).toISOString() : null,
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: age ? 3 : 0, delayed: 0, failed: 0, active: 0 })),
		};

		// The callback resolves { success: false } rather than rejecting.
		const notifyAdmin = jest.fn(async (payload) => (
			payload.type === 'backlog_recovery' && !recoveryDelivered ? { success: false } : { success: true }
		));

		const service = new JobBacklogService({ repository, queue, notifyAdmin });

		await service.probe(now);
		expect(service.getStatus().backlogAlert.active).toBe(true);

		age = null;
		recoveryDelivered = false;
		await service.probe(now + 60000);

		// A callback that reported failure must not clear the latch.
		expect(service.getStatus().backlogAlert.active).toBe(true);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).toBeNull();

		recoveryDelivered = true;
		await service.probe(now + 120000);
		expect(service.getStatus().backlogAlert.active).toBe(false);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).not.toBeNull();
	});

	it('keeps a truncated scan that observed no queued job indeterminate', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
		};

		let truncated = false;
		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 0,
				oldestQueuedAgeMs: null,
				oldestCreatedAt: null,
				truncated,
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 0, delayed: 0, failed: 0, active: 0 })),
		};
		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const service = new JobBacklogService({ repository, queue, botGetter: () => ({ telegram: { sendMessage } }) });

		// Latch an alert from a healthy, non-truncated empty scan.
		repository.getBacklogDepth = jest.fn(() => Promise.resolve({
			durableQueuedCount: 3,
			oldestQueuedAgeMs: 700000,
			oldestCreatedAt: new Date(now - 700000).toISOString(),
			truncated: false,
		}));
		await service.probe(now);
		expect(service.getStatus().backlogAlert.active).toBe(true);

		// The backlog drained, but the scan hit its page cap on actively leased
		// documents and observed nothing -- queued jobs may exist beyond the cap.
		repository.getBacklogDepth = jest.fn(() => Promise.resolve({
			durableQueuedCount: 0,
			oldestQueuedAgeMs: null,
			oldestCreatedAt: null,
			truncated,
		}));
		truncated = true;
		await service.probe(now + 60000);

		// Unknown, not drained: the latch must survive and no all-clear is sent.
		expect(service.getStatus().backlogAlert.active).toBe(true);
		expect(service.getStatus().backlogAlert.lastRecoveryAt).toBeNull();
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it('treats a truncated scan that did observe queued jobs as conclusive', async () => {
		const now = Date.now();
		process.env = {
			...savedEnv,
			JOB_EXECUTION_MODE: 'render-worker',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: 'admin-12345',
			JOB_BACKLOG_ALERT_THRESHOLD_MS: '600000',
		};

		const repository = {
			isConfigured: jest.fn(() => true),
			getBacklogDepth: jest.fn(() => Promise.resolve({
				durableQueuedCount: 500,
				oldestQueuedAgeMs: 700000,
				oldestCreatedAt: new Date(now - 700000).toISOString(),
				truncated: true,
			})),
		};
		const queue = {
			getJobCounts: jest.fn(() => Promise.resolve({ waiting: 0, delayed: 0, failed: 0, active: 0 })),
		};
		const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
		const service = new JobBacklogService({ repository, queue, botGetter: () => ({ telegram: { sendMessage } }) });

		await service.probe(now);
		// A truncated scan that observed an aged job is still real evidence, so it
		// must page and latch rather than be treated as indeterminate.
		expect(service.getStatus().durableQueuedTruncated).toBe(true);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(service.getStatus().backlogAlert.active).toBe(true);
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

	it('never treats a rotated sweep that saw nothing as evidence of recovery', async () => {
		// A rotation sweep that observed no queued job covered only a window of the
		// collection: queued jobs can sit in the unscanned prefix. A sweep that
		// reached the end from a cursor reports truncated:false, so the cap check
		// does not catch it. Treating it as conclusive emitted a false "Backlog
		// Cleared" page and then re-paged the same incident.
		const notifyAdmin = jest.fn().mockResolvedValue({ success: true });
		const agedBacklog = {
			durableQueuedCount: 20,
			oldestQueuedAgeMs: 7200000,
			oldestCreatedAt: new Date(Date.now() - 7200000).toISOString(),
		};
		const rotatedEmpty = {
			durableQueuedCount: 0,
			oldestQueuedAgeMs: null,
			oldestCreatedAt: null,
			truncated: false,
			scanRotated: true,
		};
		const repository = {
			getBacklogDepth: jest.fn()
				.mockResolvedValueOnce(agedBacklog)
				.mockResolvedValue(rotatedEmpty),
		};
		const service = new JobBacklogService({ repository, notifyAdmin });

		await service.probe();
		expect(service.hasActiveAlert).toBe(true);
		expect(notifyAdmin).toHaveBeenCalledTimes(1);

		// The rotated empty sweep must not clear the latch.
		await service.probe();
		await service.probe();

		expect(service.hasActiveAlert).toBe(true);
		expect(notifyAdmin).toHaveBeenCalledTimes(1);
		expect(notifyAdmin.mock.calls.every(([payload]) => payload.type === 'backlog_alert')).toBe(true);
	});

	it('does not clear an active alert when a rotated sweep sees only young queued jobs', async () => {
		// The rotated sweep found queued work, but none aged past the threshold, so
		// the old below-threshold branch cleared the latch and paged an all-clear.
		// A stalled job in the unscanned prefix could still be over the threshold, so
		// a partial sweep must never clear an incident.
		const notifyAdmin = jest.fn().mockResolvedValue({ success: true });
		const repository = {
			getBacklogDepth: jest.fn()
				.mockResolvedValueOnce({
					durableQueuedCount: 8,
					oldestQueuedAgeMs: 7200000,
					oldestCreatedAt: new Date(Date.now() - 7200000).toISOString(),
					truncated: false,
				})
				.mockResolvedValue({
					durableQueuedCount: 3,
					oldestQueuedAgeMs: 5000,
					oldestCreatedAt: new Date(Date.now() - 5000).toISOString(),
					truncated: false,
					scanRotated: true,
				}),
		};
		const service = new JobBacklogService({ repository, notifyAdmin });

		await service.probe();
		expect(service.hasActiveAlert).toBe(true);

		await service.probe();

		expect(service.hasActiveAlert).toBe(true);
		expect(notifyAdmin.mock.calls.every(([payload]) => payload.type === 'backlog_alert')).toBe(true);
	});

	it('still pages from a partial sweep that observed an aged job', async () => {
		// Paging is fail-safe, so a rotated sweep that sees an aged job must still
		// alert. Only the recovery direction is gated on conclusive coverage.
		const notifyAdmin = jest.fn().mockResolvedValue({ success: true });
		const repository = {
			getBacklogDepth: jest.fn().mockResolvedValue({
				durableQueuedCount: 2,
				oldestQueuedAgeMs: 3600000,
				oldestCreatedAt: new Date(Date.now() - 3600000).toISOString(),
				truncated: true,
				scanRotated: true,
			}),
		};
		const service = new JobBacklogService({ repository, notifyAdmin });

		await service.probe();

		expect(service.hasActiveAlert).toBe(true);
		expect(notifyAdmin).toHaveBeenCalledTimes(1);
		expect(notifyAdmin.mock.calls[0][0].type).toBe('backlog_alert');
	});

	it('clears the latch once a complete sweep confirms the backlog is drained', async () => {
		// The held latch must not become permanent: a conclusive empty sweep is the
		// only thing that proves the unscanned region is clear.
		const notifyAdmin = jest.fn().mockResolvedValue({ success: true });
		const repository = {
			getBacklogDepth: jest.fn()
				.mockResolvedValueOnce({
					durableQueuedCount: 4,
					oldestQueuedAgeMs: 7200000,
					oldestCreatedAt: new Date(Date.now() - 7200000).toISOString(),
				})
				.mockResolvedValue({
					durableQueuedCount: 0,
					oldestQueuedAgeMs: null,
					oldestCreatedAt: null,
					truncated: false,
				}),
		};
		const service = new JobBacklogService({ repository, notifyAdmin });

		await service.probe();
		expect(service.hasActiveAlert).toBe(true);

		await service.probe();

		expect(service.hasActiveAlert).toBe(false);
		expect(notifyAdmin).toHaveBeenCalledTimes(2);
		expect(notifyAdmin.mock.calls[1][0].type).toBe('backlog_recovery');
	});

	it('reports an unknown durable depth when the durable probe failed', async () => {
		// Publishing zero for an unreadable backlog is indistinguishable from a
		// drained one, so the unknown must survive into the status payload.
		const repository = {
			getBacklogDepth: jest.fn().mockResolvedValue({
				durableQueuedCount: null,
				oldestQueuedAgeMs: null,
				oldestCreatedAt: null,
				truncated: false,
				source: 'firestore-unavailable',
				probeFailed: true,
			}),
		};
		const service = new JobBacklogService({ repository });

		const status = await service.probe();

		expect(status.durableQueuedCount).toBeNull();
		expect(status.durableProbeSucceeded).toBe(false);
		expect(service.getStatus().durableProbeSucceeded).toBe(false);
	});

	it('reports a consistent durable depth before the first probe', () => {
		// getStatus() falls back to the memory mirror before any probe runs. Reading
		// durableQueuedCount from a different source made it report 0 while
		// oldestQueuedAgeMs reported the real age, so /api/status contradicted
		// itself on the same object.
		const repository = {
			getMemoryBacklogDepth: jest.fn(() => ({
				durableQueuedCount: 42,
				oldestQueuedAgeMs: 5000,
				oldestCreatedAt: new Date(Date.now() - 5000).toISOString(),
			})),
		};

		const status = new JobBacklogService({ repository }).getStatus();

		expect(status.durableQueuedCount).toBe(42);
		expect(status.oldestQueuedAgeMs).toBe(5000);
	});

	it('applies a Remote Config interval change to the sweep that follows an in-flight probe', async () => {
		jest.useFakeTimers();
		try {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.JOB_BACKLOG_PROBE_INTERVAL_MS = '3600000';
			let releaseProbe;
			const service = new JobBacklogService();
			service.probe = jest.fn(() => new Promise((resolve) => { releaseProbe = resolve; }));

			service.startMonitor({ unref: false });
			jest.advanceTimersByTime(3600000);
			expect(service.probe).toHaveBeenCalledTimes(1);
			expect(service.timer).toBeNull();

			// The interval changes while a probe is running, so there is no pending
			// timer to re-arm.
			remoteConfigService._setRemoteOverridesForTesting({ JOB_BACKLOG_PROBE_INTERVAL_MS: 60000 });

			releaseProbe();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// The next sweep uses the new cadence, not the original hour.
			expect(service._scheduledIntervalMs).toBe(60000);
			jest.advanceTimersByTime(60000);
			await Promise.resolve();
			await Promise.resolve();
			expect(service.probe).toHaveBeenCalledTimes(2);

			service.stop();
		} finally {
			delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			jest.useRealTimers();
			remoteConfigService._resetForTesting();
		}
	});

	it('reschedules a pending probe when Remote Config lowers the interval', async () => {
		jest.useFakeTimers();
		try {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.JOB_BACKLOG_PROBE_INTERVAL_MS = '3600000';
			const service = new JobBacklogService();
			service.probe = jest.fn().mockResolvedValue({});

			service.startMonitor({ unref: false });
			expect(service.timer).not.toBeNull();
			expect(service._scheduledIntervalMs).toBe(3600000);

			// The interval is lowered remotely. The pending hour-long timer would
			// otherwise keep its original delay, so the new cadence only took
			// effect an hour later.
			remoteConfigService._setRemoteOverridesForTesting({ JOB_BACKLOG_PROBE_INTERVAL_MS: 60000 });

			// The re-armed timer fires on the new cadence, not the old one.
			jest.advanceTimersByTime(59999);
			expect(service.probe).not.toHaveBeenCalled();
			jest.advanceTimersByTime(1);
			await Promise.resolve();
			await Promise.resolve();
			expect(service.probe).toHaveBeenCalledTimes(1);

			service.stop();
		} finally {
			delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			jest.useRealTimers();
			remoteConfigService._resetForTesting();
		}
	});

	it('unsubscribes the Remote Config listener when the monitor stops', () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.JOB_BACKLOG_PROBE_INTERVAL_MS = '3600000';
		const service = new JobBacklogService();
		service.probe = jest.fn().mockResolvedValue({});

		try {
			service.startMonitor({ unref: false });
			expect(service._unsubscribeRemoteConfig).toEqual(expect.any(Function));

			service.stop();
			expect(service._unsubscribeRemoteConfig).toBeNull();

			// A later Remote Config change must not re-arm a stopped monitor.
			remoteConfigService._setRemoteOverridesForTesting({ JOB_BACKLOG_PROBE_INTERVAL_MS: 1000 });
			expect(service.timer).toBeNull();
			expect(service.running).toBe(false);
		} finally {
			delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			remoteConfigService._resetForTesting();
		}
	});

	it('keeps every rescheduled probe timer unref\'d so it cannot hold the process open', async () => {
		const refStates = [];
		const realSetTimeout = global.setTimeout;
		jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
			const timer = realSetTimeout(fn, ms, ...args);
			if (ms === 1000) refStates.push(timer.hasRef());
			return timer;
		});

		try {
			process.env.JOB_BACKLOG_PROBE_INTERVAL_MS = '1000';
			const service = new JobBacklogService();
			service.probe = jest.fn().mockResolvedValue({});

			service.startMonitor();

			// Let the first timer fire and self-reschedule into a second 1s timer.
			await new Promise((resolve) => realSetTimeout(resolve, 1300));
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// Only the *currently live* timer matters for process-exit behaviour;
			// the first already fired and was replaced.
			expect(service.timer).not.toBeNull();
			expect(service.timer.hasRef()).toBe(false);
			expect(refStates.length).toBeGreaterThanOrEqual(2);

			service.stop();
		} finally {
			jest.restoreAllMocks();
		}
	});

	it('keeps rescheduled probe timers referenced when unref is disabled', async () => {
		const refStates = [];
		const realSetTimeout = global.setTimeout;
		jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
			const timer = realSetTimeout(fn, ms, ...args);
			if (ms === 1000) refStates.push(timer.hasRef());
			return timer;
		});

		try {
			process.env.JOB_BACKLOG_PROBE_INTERVAL_MS = '1000';
			const service = new JobBacklogService();
			service.probe = jest.fn().mockResolvedValue({});

			service.startMonitor({ unref: false });

			await new Promise((resolve) => realSetTimeout(resolve, 1300));
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(service.timer).not.toBeNull();
			expect(service.timer.hasRef()).toBe(true);
			expect(refStates.length).toBeGreaterThanOrEqual(2);

			service.stop();
		} finally {
			jest.restoreAllMocks();
		}
	});
});
