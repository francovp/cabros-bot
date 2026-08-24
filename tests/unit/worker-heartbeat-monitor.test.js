'use strict';

const {
	WorkerHeartbeatMonitorService,
	formatDuration,
	DEFAULT_STALE_MULTIPLIER,
	DEFAULT_ALERT_COOLDOWN_MS,
	DEFAULT_CHECK_INTERVAL_MS,
	DEFAULT_GRACE_PERIOD_MS,
} = require('../../src/services/monitoring/WorkerHeartbeatMonitorService');

describe('WorkerHeartbeatMonitorService', () => {
	let monitor;
	let mockFirestore;
	let mockDocs;
	let pagesSent;
	let mockTelegramService;
	let mockNotificationManager;

	beforeEach(() => {
		mockDocs = new Map();
		pagesSent = [];

		mockFirestore = {
			collection: jest.fn(() => ({
				doc: jest.fn((id) => ({
					id,
					get: jest.fn(async () => {
						const data = mockDocs.get(id);
						return {
							exists: Boolean(data),
							id,
							data: () => data,
						};
					}),
				})),
			})),
		};

		mockTelegramService = {
			isEnabled: jest.fn().mockReturnValue(true),
			send: jest.fn(async (payload) => {
				pagesSent.push(payload);
				return { success: true };
			}),
		};

		mockNotificationManager = {
			channels: new Map([['telegram', mockTelegramService]]),
		};

		monitor = new WorkerHeartbeatMonitorService({
			getFirestore: () => mockFirestore,
			getNotificationManager: () => mockNotificationManager,
			workers: [
				{
					id: 'signal-outcome',
					name: 'Signal Outcome Worker',
					collection: 'workerHeartbeats',
					docId: 'signal-outcome',
					isEnabled: () => true,
					getRole: () => 'worker',
					getIntervalMs: () => 300000, // 5m
				},
				{
					id: 'scanner-preset-scheduler',
					name: 'Scanner Preset Scheduler',
					collection: 'workerHeartbeats',
					docId: 'scanner-preset-scheduler',
					isEnabled: () => true,
					getRole: () => 'worker',
					getIntervalMs: () => 60000, // 1m
				},
			],
		});
	});

	afterEach(() => {
		monitor.stop();
	});

	describe('formatDuration helper', () => {
		it('formats seconds, minutes, and hours accurately', () => {
			expect(formatDuration(0)).toBe('0s');
			expect(formatDuration(45000)).toBe('45s');
			expect(formatDuration(60000)).toBe('1m');
			expect(formatDuration(90000)).toBe('1m 30s');
			expect(formatDuration(3600000)).toBe('1h');
			expect(formatDuration(5400000)).toBe('1h 30m');
		});
	});

	describe('fresh heartbeat checks', () => {
		it('reports healthy and sends no pages when heartbeats are fresh', async () => {
			const now = 1700000000000;
			// 2 minutes old for 5m interval worker -> fresh (threshold is 15m)
			mockDocs.set('signal-outcome', {
				updatedAt: new Date(now - 120000),
				lastRunScannedCount: 10,
				lastRunEvaluatedCount: 5,
			});
			// 30 seconds old for 1m interval worker -> fresh (threshold is 3m)
			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now - 30000),
				lastRunScannedCount: 2,
				lastRunExecutedCount: 1,
			});

			const results = await monitor.checkHeartbeats({ now });

			expect(results['signal-outcome'].status).toBe('healthy');
			expect(results['scanner-preset-scheduler'].status).toBe('healthy');
			expect(pagesSent).toHaveLength(0);

			const status = monitor.getStatus();
			expect(status.workers['signal-outcome'].isAlerting).toBe(false);
			expect(status.workers['signal-outcome'].lastStatus).toBe('healthy');
		});
	});

	describe('staleness detection and operator paging', () => {
		it('pages operators when a heartbeat exceeds the stale threshold', async () => {
			const now = 1700000000000;
			// 16 minutes old for 5m interval (threshold is 15m with 3x multiplier)
			mockDocs.set('signal-outcome', {
				updatedAt: new Date(now - 16 * 60 * 1000),
				lastRunScannedCount: 10,
				lastRunEvaluatedCount: 5,
				lastRunPendingCount: 5,
				lastRunErrorCount: 0,
			});
			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now - 30000),
			});

			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-10099999';

			const results = await monitor.checkHeartbeats({ now });

			expect(results['signal-outcome'].status).toBe('stale');
			expect(results['signal-outcome'].reason).toBe('stale_heartbeat');
			expect(results['scanner-preset-scheduler'].status).toBe('healthy');

			expect(pagesSent).toHaveLength(1);
			expect(pagesSent[0].telegramChatId).toBe('-10099999');
			expect(pagesSent[0].text).toContain('🚨 Worker Heartbeat Stale Alert');
			expect(pagesSent[0].text).toContain('Signal Outcome Worker (signal-outcome)');
			expect(pagesSent[0].text).toContain('Status: STALE');
			expect(pagesSent[0].text).toContain('16m ago');
			expect(pagesSent[0].text).toContain('scanned=10, evaluated=5, pending=5, errors=0');

			const status = monitor.getStatus();
			expect(status.workers['signal-outcome'].isAlerting).toBe(true);
			expect(status.workers['signal-outcome'].lastStatus).toBe('stale');
		});

		it('cooldown deduplication prevents duplicate pages within cooldown window', async () => {
			const now = 1700000000000;
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-10099999';

			mockDocs.set('signal-outcome', {
				updatedAt: new Date(now - 20 * 60 * 1000),
			});
			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now),
			});

			// First check -> sends page
			await monitor.checkHeartbeats({ now, alertCooldownMs: 1800000 });
			expect(pagesSent).toHaveLength(1);

			// Keep scanner-preset-scheduler fresh during next checks
			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now + 300000),
			});

			// Second check 5 minutes later -> still stale, but in cooldown -> NO page
			await monitor.checkHeartbeats({ now: now + 300000, alertCooldownMs: 1800000 });
			expect(pagesSent).toHaveLength(1);

			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now + 31 * 60 * 1000),
			});

			// Third check 31 minutes later -> cooldown expired -> sends page
			await monitor.checkHeartbeats({ now: now + 31 * 60 * 1000, alertCooldownMs: 1800000 });
			expect(pagesSent).toHaveLength(2);
		});
	});

	describe('missing heartbeat handling and grace period', () => {
		it('suppresses alert when heartbeat doc is missing within startup grace period', async () => {
			const now = monitor.startedAt + 60000; // 1 minute uptime
			// Neither doc is present in Firestore

			const results = await monitor.checkHeartbeats({ now, gracePeriodMs: 300000 });

			expect(results['signal-outcome'].status).toBe('grace_period');
			expect(results['scanner-preset-scheduler'].status).toBe('grace_period');
			expect(pagesSent).toHaveLength(0);
		});

		it('pages operators when heartbeat doc is missing after startup grace period', async () => {
			const now = monitor.startedAt + 400000; // 6.6m uptime (> 5m grace period)
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-10099999';

			const results = await monitor.checkHeartbeats({ now, gracePeriodMs: 300000 });

			expect(results['signal-outcome'].status).toBe('stale');
			expect(results['signal-outcome'].reason).toBe('missing_heartbeat');
			expect(pagesSent).toHaveLength(2);
			expect(pagesSent[0].text).toContain('Status: MISSING');
			expect(pagesSent[0].text).toContain('No heartbeat document found');
		});
	});

	describe('recovery notifications', () => {
		it('sends a single all-clear recovery page when worker resumes fresh heartbeats', async () => {
			const now = 1700000000000;
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-10099999';

			// 1. Worker is stale
			mockDocs.set('signal-outcome', {
				updatedAt: new Date(now - 20 * 60 * 1000),
			});
			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now),
			});

			await monitor.checkHeartbeats({ now });
			expect(pagesSent).toHaveLength(1);
			expect(pagesSent[0].text).toContain('🚨 Worker Heartbeat Stale Alert');

			// 2. Worker recovers with fresh heartbeat 2 minutes later
			mockDocs.set('signal-outcome', {
				updatedAt: new Date(now + 120000),
			});
			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now + 120000),
			});

			await monitor.checkHeartbeats({ now: now + 120000 });
			expect(pagesSent).toHaveLength(2);
			expect(pagesSent[1].text).toContain('✅ Worker Heartbeat Recovered');
			expect(pagesSent[1].text).toContain('Signal Outcome Worker (signal-outcome)');
			expect(pagesSent[1].text).toContain('Status: HEALTHY');

			// 3. Subsequent fresh checks do NOT repeat recovery notification
			mockDocs.set('scanner-preset-scheduler', {
				updatedAt: new Date(now + 180000),
			});
			mockDocs.set('signal-outcome', {
				updatedAt: new Date(now + 180000),
			});
			await monitor.checkHeartbeats({ now: now + 180000 });
			expect(pagesSent).toHaveLength(2);
		});
	});

	describe('role and enablement gating', () => {
		it('skips workers whose role is web or disabled', async () => {
			monitor = new WorkerHeartbeatMonitorService({
				getFirestore: () => mockFirestore,
				getNotificationManager: () => mockNotificationManager,
				workers: [
					{
						id: 'signal-outcome',
						name: 'Signal Outcome Worker',
						collection: 'workerHeartbeats',
						docId: 'signal-outcome',
						isEnabled: () => true,
						getRole: () => 'web', // Web process -> does not evaluate staleness
						getIntervalMs: () => 300000,
					},
					{
						id: 'scanner-preset-scheduler',
						name: 'Scanner Preset Scheduler',
						collection: 'workerHeartbeats',
						docId: 'scanner-preset-scheduler',
						isEnabled: () => false, // Disabled
						getRole: () => 'worker',
						getIntervalMs: () => 60000,
					},
				],
			});

			const results = await monitor.checkHeartbeats({ now: 1700000000000 });

			expect(results['signal-outcome'].status).toBe('skipped_non_worker');
			expect(results['scanner-preset-scheduler'].status).toBe('disabled');
			expect(pagesSent).toHaveLength(0);
		});
	});

	describe('fail-open behavior on errors', () => {
		it('fails open without throwing when Firestore read rejects', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			const customFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						get: jest.fn().mockRejectedValue(new Error('Firestore socket timeout')),
					})),
				})),
			};

			monitor = new WorkerHeartbeatMonitorService({
				getFirestore: () => customFirestore,
				getNotificationManager: () => mockNotificationManager,
				logger: console,
				workers: [
					{
						id: 'signal-outcome',
						name: 'Signal Outcome Worker',
						collection: 'workerHeartbeats',
						docId: 'signal-outcome',
						isEnabled: () => true,
						getRole: () => 'worker',
						getIntervalMs: () => 300000,
					},
				],
			});

			const results = await monitor.checkHeartbeats({ now: 1700000000000 });
			expect(results['signal-outcome'].status).toBe('error');
			expect(results['signal-outcome'].error).toBe('Firestore socket timeout');
			expect(warnSpy).toHaveBeenCalledWith(
				'[WorkerHeartbeatMonitor] Failed to read heartbeat for signal-outcome: Firestore socket timeout',
			);

			warnSpy.mockRestore();
		});

		it('fails open when Telegram delivery rejects', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-10099999';

			mockTelegramService.send.mockRejectedValue(new Error('Telegram 502 Bad Gateway'));
			mockDocs.set('signal-outcome', {
				updatedAt: new Date(1700000000000 - 20 * 60 * 1000),
			});

			const results = await monitor.checkHeartbeats({ now: 1700000000000 });
			expect(results['signal-outcome'].status).toBe('stale');
			expect(warnSpy).toHaveBeenCalledWith(
				'[WorkerHeartbeatMonitor] Failed to send admin notification: Telegram 502 Bad Gateway',
			);

			warnSpy.mockRestore();
		});

		it('skips checks gracefully when Firestore is unavailable', async () => {
			monitor = new WorkerHeartbeatMonitorService({
				getFirestore: () => null,
				getNotificationManager: () => mockNotificationManager,
				workers: [
					{
						id: 'signal-outcome',
						name: 'Signal Outcome Worker',
						collection: 'workerHeartbeats',
						docId: 'signal-outcome',
						isEnabled: () => true,
						getRole: () => 'worker',
						getIntervalMs: () => 300000,
					},
				],
			});

			const results = await monitor.checkHeartbeats({ now: 1700000000000 });
			expect(results['signal-outcome'].status).toBe('skipped_no_firestore');
		});
	});

	describe('service lifecycle', () => {
		it('starts and stops timer cleanly', () => {
			expect(monitor.running).toBe(false);
			monitor.start();
			expect(monitor.running).toBe(true);
			expect(monitor.timer).toBeDefined();

			monitor.stop();
			expect(monitor.running).toBe(false);
			expect(monitor.timer).toBeNull();
		});
	});
});
