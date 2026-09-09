'use strict';

const { ScannerPresetSchedulerService, scannerPresetSchedulerService } = require('../../src/services/scannerPresets/ScannerPresetSchedulerService');
const { scannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const marketScannerController = require('../../src/controllers/webhooks/handlers/marketScanner/marketScanner');
const notificationAlertModule = require('../../src/controllers/webhooks/handlers/alert/alert');
const requestRouting = require('../../src/services/notification/requestRouting');

describe('ScannerPresetSchedulerService', () => {
	let savedEnv;
	let scheduler;
	let mockFirestore;
	let mockDocs;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_SCANNER_PRESET_SCHEDULER = 'true';
		process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE = 'web';
		process.env.SCANNER_PRESET_SCHEDULER_INTERVAL_MS = '60000';
		process.env.SCANNER_PRESET_SCHEDULER_BATCH_LIMIT = '50';
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'false';

		mockDocs = new Map();
		mockFirestore = {
			collection: jest.fn(() => ({
				doc: jest.fn((id) => ({
					id,
					set: jest.fn(async (data, options) => {
						const existing = mockDocs.get(id) || {};
						mockDocs.set(id, options?.merge ? { ...existing, ...data } : { ...data });
					}),
					get: jest.fn(async () => {
						const data = mockDocs.get(id);
						return {
							exists: Boolean(data),
							id,
							data: () => data,
						};
					}),
					update: jest.fn(async (data) => {
						const existing = mockDocs.get(id) || {};
						mockDocs.set(id, { ...existing, ...data });
					}),
				})),
				where: jest.fn().mockReturnThis(),
				get: jest.fn(async () => {
					const docs = Array.from(mockDocs.entries()).map(([id, data]) => ({
						id,
						exists: true,
						data: () => data,
					}));
					return {
						empty: docs.length === 0,
						docs,
					};
				}),
			})),
			runTransaction: jest.fn(async (callback) => {
				const transaction = {
					get: jest.fn(async (docRef) => {
						const data = mockDocs.get(docRef.id);
						return {
							exists: Boolean(data),
							id: docRef.id,
							data: () => data,
						};
					}),
					set: jest.fn((docRef, data, options) => {
						const existing = mockDocs.get(docRef.id) || {};
						mockDocs.set(docRef.id, options?.merge ? { ...existing, ...data } : { ...data });
					}),
					update: jest.fn((docRef, data) => {
						const existing = mockDocs.get(docRef.id) || {};
						mockDocs.set(docRef.id, { ...existing, ...data });
					}),
				};
				return callback(transaction);
			}),
		};

		jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);
		scannerPresetService._resetForTesting();
		scheduler = new ScannerPresetSchedulerService();
	});

	afterEach(async () => {
		if (scheduler) {
			await scheduler.stopWorker({ drain: false });
		}
		process.env = savedEnv;
		jest.restoreAllMocks();
	});

	describe('configuration and gating', () => {
		it('is disabled when ENABLE_SCANNER_PRESET_SCHEDULER is false or unset', () => {
			process.env.ENABLE_SCANNER_PRESET_SCHEDULER = 'false';
			expect(scheduler.isEnabled()).toBe(false);

			delete process.env.ENABLE_SCANNER_PRESET_SCHEDULER;
			expect(scheduler.isEnabled()).toBe(false);
		});

		it('reports correct status payload without leaking secrets', () => {
			const status = scheduler.getStatus();
			expect(status).toEqual({
				enabled: true,
				configured: true,
				ready: true,
				status: 'ready',
				role: 'web',
				running: false,
				intervalMs: 60000,
				batchLimit: 50,
				lastRunAt: null,
				lastRunDurationMs: null,
				lastRunScannedCount: 0,
				lastRunExecutedCount: 0,
				lastRunErrorCount: 0,
				lastRunDeferredByFloorCount: 0,
			});
		});

		it('normalizes worker role to web, worker, or disabled', () => {
			process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE = 'WORKER';
			expect(scheduler.getWorkerRole()).toBe('worker');

			process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE = 'disabled';
			expect(scheduler.getWorkerRole()).toBe('disabled');

			process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE = 'invalid_role';
			expect(scheduler.getWorkerRole()).toBe('web');
		});

		it('reports disabled status when worker role is disabled', () => {
			process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE = 'disabled';
			const status = scheduler.getStatus();
			expect(status.ready).toBe(false);
			expect(status.status).toBe('disabled');
		});
	});

	describe('sweep and execution in memory mode', () => {
		it('finds and executes due preset, then advances nextRunAt', async () => {
			const preset = await scannerPresetService.createPreset({
				name: 'Due preset',
				schedule: { enabled: true, cadence: '5m' },
			});
			// Force nextRunAt to past so it is due
			await scannerPresetService.updatePreset(preset.id, {
				nextRunAt: new Date(Date.now() - 60000).toISOString(),
			});

			const mockScanResults = [
				{
					scan: 'top_gainers',
					status: 'success',
					items: [{ symbol: 'BTCUSDT', change: 5.2 }],
				},
			];
			jest.spyOn(marketScannerController, 'runScans').mockResolvedValue(mockScanResults);
			const sendSpy = jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([
				{ channel: 'telegram', success: true },
			]);
			const mockNotificationManager = {};
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue(mockNotificationManager);

			const sweepResult = await scheduler.sweep();
			expect(sweepResult.scannedCount).toBe(1);
			expect(sweepResult.executedCount).toBe(1);
			expect(sweepResult.errorCount).toBe(0);

			expect(marketScannerController.runScans).toHaveBeenCalledTimes(1);
			expect(sendSpy).toHaveBeenCalledTimes(1);

			const updated = await scannerPresetService.getPreset(preset.id);
			expect(updated.lastStatus).toBe('success');
			expect(updated.lastRunAt).toBeDefined();
			expect(new Date(updated.nextRunAt).getTime()).toBeGreaterThan(Date.now());
			expect(updated.lockedUntil).toBeNull();
		});

		it('skips presets that are not due or disabled', async () => {
			await scannerPresetService.createPreset({
				name: 'Disabled preset',
				schedule: { enabled: false, cadence: '5m' },
			});
			await scannerPresetService.createPreset({
				name: 'Future preset',
				schedule: { enabled: true, cadence: '1h' },
				nextRunAt: new Date(Date.now() + 3600000).toISOString(),
			});

			const runSpy = jest.spyOn(marketScannerController, 'runScans');
			const sweepResult = await scheduler.sweep();
			expect(sweepResult.scannedCount).toBe(0);
			expect(sweepResult.executedCount).toBe(0);
			expect(runSpy).not.toHaveBeenCalled();
		});

		it('fails open when preset scan throws and records lastStatus=error without blocking others', async () => {
			const failingPreset = await scannerPresetService.createPreset({
				name: 'Failing preset',
				schedule: { enabled: true, cadence: '5m' },
				nextRunAt: new Date(Date.now() - 10000).toISOString(),
			});
			const succeedingPreset = await scannerPresetService.createPreset({
				name: 'Succeeding preset',
				schedule: { enabled: true, cadence: '10m' },
				nextRunAt: new Date(Date.now() - 5000).toISOString(),
			});

			jest.spyOn(marketScannerController, 'runScans').mockImplementation(async (preset) => {
				if (preset.name === 'Failing preset') {
					throw new Error('TradingView MCP connection reset');
				}
				return [{ scan: 'top_gainers', status: 'success', items: [] }];
			});
			jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([]);
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue({});

			const sweepResult = await scheduler.sweep();
			expect(sweepResult.scannedCount).toBe(2);
			expect(sweepResult.executedCount).toBe(2);
			expect(sweepResult.errorCount).toBe(1);

			const failing = await scannerPresetService.getPreset(failingPreset.id);
			expect(failing.lastStatus).toBe('error');
			expect(failing.lastError).toBe('TradingView MCP connection reset');
			expect(new Date(failing.nextRunAt).getTime()).toBeGreaterThan(Date.now());

			const succeeding = await scannerPresetService.getPreset(succeedingPreset.id);
			expect(succeeding.lastStatus).toBe('success');
		});

		it('advances the preset version on every scheduler mutation', async () => {
			const created = await scannerPresetService.createPreset({
				name: 'Version-bumping scheduler preset',
				schedule: { enabled: true, cadence: '5m' },
			});
			const initialVersion = created.version;

			// Force the preset to be due now so _claimPreset accepts the lease.
			await scannerPresetService.updatePreset(created.id, {
				nextRunAt: new Date(Date.now() - 1000).toISOString(),
			});
			const fresh = await scannerPresetService.getPreset(created.id);
			const claimed = await scheduler._claimPreset(fresh, Date.now(), 60000);
			expect(claimed).toBe(true);

			const afterClaim = await scannerPresetService.getPreset(created.id);
			expect(afterClaim.version).toBe(initialVersion + 2);
			expect(afterClaim.lockedUntil).toBeTruthy();

			await scheduler._finalizePresetRun(fresh, {
				lastRunAt: new Date().toISOString(),
				nextRunAt: new Date(Date.now() + 300000).toISOString(),
				lastStatus: 'success',
				lastError: null,
				lastDurationMs: 12,
			});
			const afterFinalize = await scannerPresetService.getPreset(created.id);
			expect(afterFinalize.version).toBe(initialVersion + 3);
			expect(afterFinalize.lockedUntil).toBeNull();
			expect(afterFinalize.lockedBy).toBeNull();
		});
	});

	describe('claim exclusivity and concurrency', () => {
		it('prevents concurrent schedulers from double-running the same preset', async () => {
			const preset = await scannerPresetService.createPreset({
				name: 'Contended preset',
				schedule: { enabled: true, cadence: '5m' },
				nextRunAt: new Date(Date.now() - 10000).toISOString(),
			});

			let resolveFirstScan;
			const firstScanPromise = new Promise((resolve) => {
				resolveFirstScan = resolve;
			});

			jest.spyOn(marketScannerController, 'runScans').mockImplementation(async () => {
				await firstScanPromise;
				return [{ scan: 'top_gainers', status: 'success', items: [] }];
			});
			jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([]);
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue({});

			const scheduler1 = new ScannerPresetSchedulerService();
			const scheduler2 = new ScannerPresetSchedulerService();

			// Start sweep 1 (which claims preset and waits in runScans)
			const sweep1Promise = scheduler1.sweep();

			// Give tick for scheduler1 to claim
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Sweep 2 should see preset is already claimed and skip it
			const sweep2Result = await scheduler2.sweep();
			expect(sweep2Result.executedCount).toBe(0);

			// Unblock scheduler 1
			resolveFirstScan();
			const sweep1Result = await sweep1Promise;
			expect(sweep1Result.executedCount).toBe(1);
		});
	});

	describe('per-preset floor enforcement (GH-786)', () => {
		const MIN_PRESET_FLOOR_MS = 60000;

		async function createPresetWithLastRunAt(name, lastRunAtOffsetMs) {
			const preset = await scannerPresetService.createPreset({
				name,
				schedule: { enabled: true, cadence: '5m' },
				nextRunAt: new Date(Date.now() - 1000).toISOString(),
			});
			if (lastRunAtOffsetMs !== null) {
				await scannerPresetService.updatePreset(preset.id, {
					lastRunAt: new Date(Date.now() - lastRunAtOffsetMs).toISOString(),
				});
			} else {
				await scannerPresetService.updatePreset(preset.id, {
					lastRunAt: null,
				});
			}
			return preset.id;
		}

		it('defers preset whose lastRunAt is younger than the 60s floor even when nextRunAt is past', async () => {
			const presetId = await createPresetWithLastRunAt('Young preset', 30000);

			const runSpy = jest.spyOn(marketScannerController, 'runScans').mockResolvedValue([
				{ scan: 'top_gainers', status: 'success', items: [] },
			]);

			const result = await scheduler.sweep();
			expect(result.scannedCount).toBe(1);
			expect(result.executedCount).toBe(0);
			expect(result.deferredByFloorCount).toBe(1);
			expect(runSpy).not.toHaveBeenCalled();

			const updated = await scannerPresetService.getPreset(presetId);
			expect(updated.lastRunAt).not.toBeNull();
		});

		it('fires preset whose lastRunAt is older than the 60s floor', async () => {
			const presetId = await createPresetWithLastRunAt('Ready preset', 90000);

			jest.spyOn(marketScannerController, 'runScans').mockResolvedValue([
				{ scan: 'top_gainers', status: 'success', items: [] },
			]);
			jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([]);
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue({});

			const result = await scheduler.sweep();
			expect(result.scannedCount).toBe(1);
			expect(result.executedCount).toBe(1);
			expect(result.deferredByFloorCount).toBe(0);

			const updated = await scannerPresetService.getPreset(presetId);
			expect(updated.lastStatus).toBe('success');
		});

		it('does not defer preset without lastRunAt (first run after creation)', async () => {
			const presetId = await createPresetWithLastRunAt('Brand-new preset', null);

			jest.spyOn(marketScannerController, 'runScans').mockResolvedValue([
				{ scan: 'top_gainers', status: 'success', items: [] },
			]);
			jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([]);
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue({});

			const result = await scheduler.sweep();
			expect(result.scannedCount).toBe(1);
			expect(result.executedCount).toBe(1);
			expect(result.deferredByFloorCount).toBe(0);

			const updated = await scannerPresetService.getPreset(presetId);
			expect(updated.lastStatus).toBe('success');
		});

		it('two consecutive sweeps 1s apart cannot fire the same preset twice', async () => {
			const presetId = await createPresetWithLastRunAt('Rapid preset', 1000);

			const runSpy = jest.spyOn(marketScannerController, 'runScans').mockResolvedValue([
				{ scan: 'top_gainers', status: 'success', items: [] },
			]);

			const first = await scheduler.sweep();
			expect(first.executedCount).toBe(0);
			expect(first.deferredByFloorCount).toBe(1);
			expect(runSpy).not.toHaveBeenCalled();

			await new Promise((resolve) => setTimeout(resolve, 50));

			const second = await scheduler.sweep();
			expect(second.executedCount).toBe(0);
			expect(second.deferredByFloorCount).toBe(1);
			expect(runSpy).not.toHaveBeenCalled();

			const updated = await scannerPresetService.getPreset(presetId);
			expect(updated.lastRunAt).not.toBeNull();
		});

		it('multi-replica concurrent sweep cannot fire a young preset twice', async () => {
			// Preset has not run yet — its previous lastRunAt is older than the
			// floor, so the first sweep is allowed to fire. After the first sweep
			// finishes, the preset's lastRunAt is within the floor window and a
			// concurrent replica sweeping at the same time must defer instead of
			// re-running.
			const presetId = await createPresetWithLastRunAt('Multi-replica preset', 90000);

			let resolveScan;
			const scanGate = new Promise((resolve) => {
				resolveScan = resolve;
			});

			jest.spyOn(marketScannerController, 'runScans').mockImplementation(async () => {
				await scanGate;
				return [{ scan: 'top_gainers', status: 'success', items: [] }];
			});
			jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([]);
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue({});

			const scheduler1 = new ScannerPresetSchedulerService();
			const scheduler2 = new ScannerPresetSchedulerService();

			const sweep1Promise = scheduler1.sweep();
			await new Promise((resolve) => setTimeout(resolve, 10));

			resolveScan();
			await sweep1Promise;

			// Re-mark the preset as due again so a fresh sweep would otherwise
			// try to fire it; the floor must defer it because scheduler1 just ran
			// the preset moments ago.
			await scannerPresetService.updatePreset(presetId, {
				nextRunAt: new Date(Date.now() - 1000).toISOString(),
			});

			const sweep2Result = await scheduler2.sweep();
			expect(sweep2Result.executedCount).toBe(0);
			expect(sweep2Result.deferredByFloorCount).toBe(1);
		});

		it('does not starve ready presets when earlier due presets are floor deferred', async () => {
			// Preset 1 is young (deferred)
			await createPresetWithLastRunAt('Young preset at front', 30000);
			// Preset 2 is ready (old lastRunAt)
			const readyId = await createPresetWithLastRunAt('Ready preset behind', 90000);

			jest.spyOn(marketScannerController, 'runScans').mockResolvedValue([
				{ scan: 'top_gainers', status: 'success', items: [] },
			]);
			jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([]);
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue({});

			// batchLimit of 1: without the fix, the young preset would fill the batch
			// and be deferred, leaving 0 executed. With the fix, the ready preset is
			// included and executed.
			const result = await scheduler.sweep({ batchLimit: 1 });
			expect(result.deferredByFloorCount).toBe(1);
			expect(result.executedCount).toBe(1);

			const updated = await scannerPresetService.getPreset(readyId);
			expect(updated.lastStatus).toBe('success');
		});

		it('atomic claim recheck rejects claim if lastRunAt was updated inside floor window', async () => {
			const presetId = await createPresetWithLastRunAt('Race preset', 90000);
			const preset = await scannerPresetService.getPreset(presetId);

			// Simulate another replica completing the preset before _claimPreset executes
			await scannerPresetService.updatePreset(presetId, {
				lastRunAt: new Date(Date.now() - 5000).toISOString(),
			});

			const claimed = await scheduler._claimPreset(preset, Date.now(), 60000);
			expect(claimed).toBe(false);
		});

		it('exposes deferredByFloor counter under dependencies.scannerPresetScheduler in /api/status', () => {
			const status = scheduler.getStatus();
			expect(status).toHaveProperty('lastRunDeferredByFloorCount');
			expect(status.lastRunDeferredByFloorCount).toBe(0);
			expect(status.lastRunDeferredByFloorCount).toBeDefined();
			expect(MIN_PRESET_FLOOR_MS).toBe(60000);
		});
	});

	describe('worker lifecycle and shutdown drain', () => {
		it('drains in-flight sweep on stopWorker', async () => {
			let resolveScan;
			const scanPromise = new Promise((resolve) => {
				resolveScan = resolve;
			});

			await scannerPresetService.createPreset({
				name: 'Drain preset',
				schedule: { enabled: true, cadence: '5m' },
				nextRunAt: new Date(Date.now() - 10000).toISOString(),
			});

			jest.spyOn(marketScannerController, 'runScans').mockImplementation(async () => {
				await scanPromise;
				return [{ scan: 'top_gainers', status: 'success', items: [] }];
			});
			jest.spyOn(requestRouting, 'sendWithNotificationRouting').mockResolvedValue([]);
			jest.spyOn(notificationAlertModule, 'getNotificationManager').mockReturnValue({});

			scheduler.startWorker();
			expect(scheduler.running).toBe(true);

			// Trigger sweep
			const sweepPromise = scheduler.sweep();
			await new Promise((resolve) => setTimeout(resolve, 10));

			let drained = false;
			const stopPromise = scheduler.stopWorker({ drain: true }).then(() => {
				drained = true;
			});

			expect(drained).toBe(false);
			resolveScan();
			await sweepPromise;
			await stopPromise;
			expect(drained).toBe(true);
			expect(scheduler.running).toBe(false);
		});
	});
});
