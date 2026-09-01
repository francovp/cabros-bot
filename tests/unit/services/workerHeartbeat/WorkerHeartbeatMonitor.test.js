'use strict';

const {
	WorkerHeartbeatMonitor,
	HEALTH_HEALTHY,
	HEALTH_STALE,
	HEALTH_MISSING,
	HEALTH_DISABLED,
	HEALTH_UNKNOWN,
} = require('../../../../src/services/workerHeartbeat/WorkerHeartbeatMonitor');

function buildFirestoreMock({ heartbeatDoc, scannerDocs = [], error = null } = {}) {
	const docRef = {
		get: jest.fn(() => {
			if (error) return Promise.reject(error);
			if (!heartbeatDoc) return Promise.resolve({ exists: false });
			return Promise.resolve({
				exists: true,
				id: 'signal-outcome',
				data: () => heartbeatDoc,
			});
		}),
	};

	const collection = jest.fn((name) => {
		if (name === 'workerHeartbeats') {
			return { doc: () => docRef };
		}
		if (name === 'scannerPresets') {
			const query = {
				orderBy: jest.fn(() => query),
				limit: jest.fn(() => query),
				get: jest.fn(() => {
					if (error) return Promise.reject(error);
					return Promise.resolve({
						empty: scannerDocs.length === 0,
						docs: scannerDocs.map((doc, idx) => ({
							id: `doc-${idx}`,
							data: () => doc,
						})),
					});
				}),
			};
			return query;
		}
		return null;
	});

	return { firestore: { collection } };
}

describe('WorkerHeartbeatMonitor', () => {
	let savedEnv;
	let originalSignalOutcome;
	let originalScannerPreset;

	beforeEach(() => {
		savedEnv = { ...process.env };
		originalSignalOutcome = process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		originalScannerPreset = process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		delete process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE;
		delete process.env.ENABLE_SCANNER_PRESET_SCHEDULER;
		delete process.env.WORKER_HEARTBEAT_ALERTING_ENABLED;
		delete process.env.WORKER_HEARTBEAT_CACHE_TTL_MS;
		delete process.env.WORKER_HEARTBEAT_STALENESS_MULTIPLIER;
	});

	afterEach(() => {
		process.env = savedEnv;
		if (originalSignalOutcome !== undefined) process.env.SIGNAL_OUTCOME_WORKER_ROLE = originalSignalOutcome;
		if (originalScannerPreset !== undefined) process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE = originalScannerPreset;
	});

	it('reports missing heartbeat when firestore is unavailable', async () => {
		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => null,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'web', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: true, role: 'web', intervalMs: 60000 }),
		});

		const signalOutcome = await monitor.getSignalOutcomeStatus();
		const scanner = await monitor.getScannerPresetSchedulerStatus();

		expect(signalOutcome.health).toBe(HEALTH_UNKNOWN);
		expect(signalOutcome.error).toBe('firestore_unavailable');
		expect(scanner.health).toBe(HEALTH_UNKNOWN);
		expect(scanner.error).toBe('ephemeral_storage');
	});

	it('classifies fresh heartbeat as healthy', async () => {
		const recent = new Date(Date.now() - 30 * 1000);
		const { firestore } = buildFirestoreMock({
			heartbeatDoc: {
				worker: 'signal-outcome',
				role: 'worker',
				enabled: true,
				running: true,
				lastRunAt: { toMillis: () => recent.getTime(), toDate: () => recent },
				updatedAt: { toMillis: () => recent.getTime(), toDate: () => recent },
			},
		});

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
			now: () => recent.getTime() + 30 * 1000,
		});

		const status = await monitor.getSignalOutcomeStatus();
		expect(status.health).toBe(HEALTH_HEALTHY);
		expect(status.hasHeartbeat).toBe(true);
		expect(status.heartbeatAgeMs).toBe(30000);
		expect(status.role).toBe('worker');
	});

	it('classifies stale heartbeat as stale', async () => {
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		const { firestore } = buildFirestoreMock({
			heartbeatDoc: {
				worker: 'signal-outcome',
				role: 'worker',
				enabled: true,
				updatedAt: { toMillis: () => stale.getTime(), toDate: () => stale },
			},
		});

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
		});

		const status = await monitor.getSignalOutcomeStatus();
		expect(status.health).toBe(HEALTH_STALE);
		expect(status.heartbeatAgeMs).toBeGreaterThan(60 * 60 * 1000 - 1000);
	});

	it('reports missing heartbeat when no document exists', async () => {
		const { firestore } = buildFirestoreMock({ heartbeatDoc: null });

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
		});

		const status = await monitor.getSignalOutcomeStatus();
		expect(status.health).toBe(HEALTH_MISSING);
		expect(status.hasHeartbeat).toBe(false);
	});

	it('reports disabled when worker role is disabled', async () => {
		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => null,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'disabled', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
		});

		const status = await monitor.getSignalOutcomeStatus();
		expect(status.health).toBe(HEALTH_DISABLED);
		expect(status.role).toBe('disabled');
	});

	it('fails open when firestore read throws', async () => {
		const { firestore } = buildFirestoreMock({ error: new Error('firestore read failed') });

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
		});

		const status = await monitor.getSignalOutcomeStatus();
		expect(status.error).toBe('read_failed');
		expect(status.health).toBe(HEALTH_UNKNOWN);
	});

	it('uses latest scanner preset updatedAt for scanner heartbeat', async () => {
		const recent = new Date(Date.now() - 30 * 1000);
		const { firestore } = buildFirestoreMock({
			heartbeatDoc: null,
			scannerDocs: [
				{ updatedAt: recent.toISOString(), lastRunAt: recent.toISOString() },
			],
		});

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			now: () => recent.getTime() + 30 * 1000,
		});

		const status = await monitor.getScannerPresetSchedulerStatus();
		expect(status.health).toBe(HEALTH_HEALTHY);
		expect(status.hasHeartbeat).toBe(true);
	});

	it('reports missing scanner heartbeat when no presets are present', async () => {
		const { firestore } = buildFirestoreMock({ heartbeatDoc: null, scannerDocs: [] });

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
		});

		const status = await monitor.getScannerPresetSchedulerStatus();
		expect(status.health).toBe(HEALTH_MISSING);
	});

	it('caches snapshots for the configured TTL', async () => {
		const recent = new Date(Date.now() - 30 * 1000);
		const firestore = {
			collection: jest.fn((name) => {
				if (name === 'workerHeartbeats') {
					const docRef = {
						get: jest.fn(() => Promise.resolve({
							exists: true,
							id: 'signal-outcome',
							data: () => ({
								worker: 'signal-outcome',
								role: 'worker',
								enabled: true,
								updatedAt: { toMillis: () => recent.getTime(), toDate: () => recent },
							}),
						})),
					};
					return { doc: () => docRef };
				}
				return null;
			}),
		};

		let nowMs = recent.getTime() + 30 * 1000;
		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
			now: () => nowMs,
		});

		const first = await monitor.getSignalOutcomeStatus();
		const second = await monitor.getSignalOutcomeStatus();

		expect(second).toBe(first);
		expect(firestore.collection).toHaveBeenCalledTimes(1);
	});

	it('does not invoke onStaleDetected without opt-in alerting', async () => {
		process.env.WORKER_HEARTBEAT_ALERTING_ENABLED = 'false';
		const onStaleDetected = jest.fn();
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		const { firestore } = buildFirestoreMock({
			heartbeatDoc: {
				worker: 'signal-outcome',
				role: 'worker',
				enabled: true,
				updatedAt: { toMillis: () => stale.getTime(), toDate: () => stale },
			},
		});

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
			onStaleDetected,
		});

		const status = await monitor.getSignalOutcomeStatus();
		expect(status.health).toBe(HEALTH_STALE);
		expect(onStaleDetected).not.toHaveBeenCalled();
	});

	it('invokes onStaleDetected hook when alerting is opt-in and cooldown elapsed', async () => {
		process.env.WORKER_HEARTBEAT_ALERTING_ENABLED = 'true';
		const onStaleDetected = jest.fn();
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		const { firestore } = buildFirestoreMock({
			heartbeatDoc: {
				worker: 'signal-outcome',
				role: 'worker',
				enabled: true,
				updatedAt: { toMillis: () => stale.getTime(), toDate: () => stale },
			},
		});

		const monitor = new WorkerHeartbeatMonitor({
			getFirestore: () => firestore,
			getSignalOutcomeWorkerStatus: () => ({ enabled: true, role: 'worker', intervalMs: 60000 }),
			getScannerPresetSchedulerWorkerStatus: () => ({ enabled: false, role: 'web', intervalMs: 60000 }),
			onStaleDetected,
		});

		await monitor.getSignalOutcomeStatus();
		expect(onStaleDetected).toHaveBeenCalledTimes(1);
		expect(onStaleDetected.mock.calls[0][0]).toMatchObject({
			workerName: 'signal-outcome',
			snapshot: expect.objectContaining({ health: HEALTH_STALE }),
		});
	});
});