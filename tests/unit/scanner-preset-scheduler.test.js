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
