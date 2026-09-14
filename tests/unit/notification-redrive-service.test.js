const { NotificationRedriveService, notificationRedriveService, calculateBackoffMs, stripUndefinedFieldsDeep } = require('../../src/services/notification/NotificationRedriveService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const { signalRepeatCooldown } = require('../../src/services/alerts/signalRepeatCooldown');

describe('NotificationRedriveService', () => {
	let savedEnv;
	let service;
	let mockFirestore;
	let mockDocs;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'web';
		process.env.NOTIFICATION_REDRIVE_INTERVAL_MS = '60000';
		process.env.NOTIFICATION_REDRIVE_BATCH_LIMIT = '50';
		process.env.NOTIFICATION_REDRIVE_MAX_ATTEMPTS = '3';
		process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS = '3600000';
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = 'admin-chat-123';

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
							exists: !!data,
							id,
							data: () => data,
						};
					}),
				})),
				where: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				get: jest.fn(async () => {
					const docs = Array.from(mockDocs.entries()).map(([id, data]) => ({
						id,
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
							exists: !!data,
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
		service = new NotificationRedriveService();
	});

	afterEach(async () => {
		if (service) {
			await service.stopWorker({ drain: false });
			service._resetForTesting();
		}
		process.env = savedEnv;
		jest.restoreAllMocks();
	});

	describe('configuration and gating', () => {
		it('is disabled when ENABLE_NOTIFICATION_REDRIVE is false or unset', () => {
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'false';
			expect(service.isEnabled()).toBe(false);

			delete process.env.ENABLE_NOTIFICATION_REDRIVE;
			expect(service.isEnabled()).toBe(false);
		});

		it('reports correct status payload without secret leak', () => {
			const status = service.getStatus();
			expect(status).toEqual({
				enabled: true,
				configured: true,
				ready: true,
				status: 'ready',
				role: 'web',
				workerRole: 'web',
				running: false,
				intervalMs: 60000,
				batchLimit: 50,
				maxAttempts: 3,
				maxAgeMs: 3600000,
				pendingCount: 0,
				deliveredCount: 0,
				exhaustedCount: 0,
				zeroChannelBroadcasts: 0,
				lastRunAt: null,
				lastSweepAt: null,
				lastRunDurationMs: null,
				lastRunScannedCount: 0,
				lastRunRedrivenCount: 0,
				lastRunErrorCount: 0,
				lastRunExhaustedCount: 0,
				lastSweepResult: null,
			});
		});

		it('exposes structured lastSweepResult with processed/succeeded/exhausted/errors', () => {
			service.lastSweepAt = new Date('2026-08-30T00:00:00.000Z');
			service.lastSweepResult = {
				processed: 10,
				succeeded: 4,
				exhausted: 2,
				errors: 1,
			};
			const status = service.getStatus();
			expect(status.lastSweepAt).toBe('2026-08-30T00:00:00.000Z');
			expect(status.lastSweepResult).toEqual({
				processed: 10,
				succeeded: 4,
				exhausted: 2,
				errors: 1,
			});
		});

		it('publishes lastSweepAt and lastSweepResult only upon sweep completion, not during in-flight sweep', async () => {
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'web';
			let resolveDispatch;
			const dispatchGate = new Promise((resolve) => {
				resolveDispatch = resolve;
			});
			const mockNotificationManager = {
				sendToChannels: jest.fn(async () => {
					await dispatchGate;
					return [{ channel: 'telegram', success: true }];
				}),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);
			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-inflight' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
			);
			service.inMemoryStore.get('corr-inflight_telegram').nextAttemptAt = Date.now() - 1000;

			// Before sweep starts:
			expect(service.getStatus().lastSweepAt).toBeNull();
			expect(service.getStatus().lastSweepResult).toBeNull();

			// Start sweep:
			const sweepPromise = service.sweep();

			// Give event loop tick to enter sweep and await sendToChannels:
			await new Promise((r) => setImmediate(r));

			// While in flight, lastSweepAt and lastSweepResult should still be null (not mismatched interim numbers)
			const inFlightStatus = service.getStatus();
			expect(inFlightStatus.lastSweepAt).toBeNull();
			expect(inFlightStatus.lastSweepResult).toBeNull();

			// Complete the dispatch:
			resolveDispatch();
			await sweepPromise;

			// After sweep completion, both are published as an atomic snapshot:
			const completedStatus = service.getStatus();
			expect(completedStatus.lastSweepAt).not.toBeNull();
			expect(completedStatus.lastSweepResult).toEqual({
				processed: 1,
				succeeded: 1,
				exhausted: 0,
				errors: 0,
			});
		});

		it('reports workerRole mirroring role', () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const status = service.getStatus();
			expect(status.role).toBe('worker');
			expect(status.workerRole).toBe('worker');
		});

		it('syncs durable telemetry for web status replicas', () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'web';
			jest.spyOn(service, 'getFirestore').mockReturnValue({});
			jest.spyOn(service, 'syncWorkerTelemetry').mockImplementation(() => {
				service.persistedLastSweepAt = new Date('2026-09-13T12:00:00.000Z');
				service.persistedLastSweepResult = {
					processed: 4,
					succeeded: 2,
					exhausted: 1,
					errors: 1,
				};
				service.persistedPendingCount = 7;
				service.persistedDeliveredCount = 4;
				service.persistedExhaustedCount = 2;
				return Promise.resolve(true);
			});

			const status = service.getStatus();

			expect(service.syncWorkerTelemetry).toHaveBeenCalled();
			expect(status.lastSweepAt).toBe('2026-09-13T12:00:00.000Z');
			expect(status.lastSweepResult).toEqual({
				processed: 4,
				succeeded: 2,
				exhausted: 1,
				errors: 1,
			});
			expect(status.pendingCount).toBe(7);
			expect(status.deliveredCount).toBe(4);
			expect(status.exhaustedCount).toBe(2);
		});

		it('keeps a newer local completed sweep over an older durable snapshot', () => {
			jest.spyOn(service, 'getFirestore').mockReturnValue({});
			jest.spyOn(service, 'syncWorkerTelemetry').mockResolvedValue(true);
			service.persistedLastRunAt = new Date('2026-09-13T11:59:00.000Z');
			service.persistedLastSweepAt = new Date('2026-09-13T11:59:01.000Z');
			service.persistedLastSweepResult = {
				processed: 1,
				succeeded: 0,
				exhausted: 0,
				errors: 1,
			};
			service.persistedLastRunDurationMs = 10;
			service.persistedLastRunScannedCount = 1;
			service.persistedLastRunRedrivenCount = 0;
			service.persistedLastRunErrorCount = 1;
			service.persistedLastRunExhaustedCount = 0;
			service.lastRunAt = new Date('2026-09-13T12:00:00.000Z');
			service.lastSweepAt = new Date('2026-09-13T12:00:01.000Z');
			service.lastSweepResult = {
				processed: 2,
				succeeded: 1,
				exhausted: 1,
				errors: 0,
			};
			service.lastRunDurationMs = 20;
			service.lastRunScannedCount = 2;
			service.lastRunRedrivenCount = 1;
			service.lastRunErrorCount = 0;
			service.lastRunExhaustedCount = 1;

			const status = service.getStatus();

			expect(status.lastRunAt).toBe('2026-09-13T12:00:00.000Z');
			expect(status.lastSweepAt).toBe('2026-09-13T12:00:01.000Z');
			expect(status.lastSweepResult).toEqual(service.lastSweepResult);
			expect(status.lastRunDurationMs).toBe(20);
			expect(status.lastRunScannedCount).toBe(2);
			expect(status.lastRunRedrivenCount).toBe(1);
			expect(status.lastRunErrorCount).toBe(0);
			expect(status.lastRunExhaustedCount).toBe(1);
		});

		it('normalizes worker role to web, worker, or disabled', () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'WORKER';
			expect(service.getWorkerRole()).toBe('worker');

			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'disabled';
			expect(service.getWorkerRole()).toBe('disabled');

			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'invalid_role';
			expect(service.getWorkerRole()).toBe('web');
		});
	});

	describe('recordDeliveryResults', () => {
		it('does not record when redrive is disabled', async () => {
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'false';
			const alert = { text: 'Test alert' };
			const results = [{ channel: 'telegram', success: false, error: 'Network timeout' }];

			const recorded = await service.recordDeliveryResults(alert, results);
			expect(recorded).toEqual([]);
			expect(service.getPendingCount()).toBe(0);
		});

		it('does not record when options or alert indicates a probe or redrive ineligible', async () => {
			const alert = { text: 'Alert body', correlationId: 'corr-probe' };
			const results = [
				{ channel: 'telegram', success: false, error: 'Network timeout' },
			];

			// options.isProbe: true
			let recorded = await service.recordDeliveryResults(alert, results, { isProbe: true });
			expect(recorded).toEqual([]);
			expect(service.getPendingCount()).toBe(0);

			// options.redriveEligible: false
			recorded = await service.recordDeliveryResults(alert, results, { redriveEligible: false });
			expect(recorded).toEqual([]);
			expect(service.getPendingCount()).toBe(0);

			// alert.isProbe: true
			recorded = await service.recordDeliveryResults({ ...alert, isProbe: true }, results);
			expect(recorded).toEqual([]);
			expect(service.getPendingCount()).toBe(0);

			// alert.redriveEligible: false
			recorded = await service.recordDeliveryResults({ ...alert, redriveEligible: false }, results);
			expect(recorded).toEqual([]);
			expect(service.getPendingCount()).toBe(0);
		});

		it('records only failed channels and stores in fallback in-memory store', async () => {
			const alert = { text: 'Alert body', correlationId: 'corr-123' };
			const results = [
				{ channel: 'telegram', success: true, messageId: 'msg-1' },
				{ channel: 'whatsapp', success: false, error: 'Connection refused', statusCode: 503 },
			];
			const options = { routing: { whatsappChatId: '120363@g.us' } };

			const recorded = await service.recordDeliveryResults(alert, results, options);
			expect(recorded).toHaveLength(1);
			expect(recorded[0]).toBe('corr-123_whatsapp');
			expect(service.getPendingCount()).toBe(1);

			const pending = service.inMemoryStore.get('corr-123_whatsapp');
			expect(pending.channel).toBe('whatsapp');
			expect(pending.status).toBe('pending');
			expect(pending.attemptCount).toBe(0);
			expect(pending.alert.text).toBe('Alert body');
			expect(pending.destinationOverride.whatsappChatId).toBe('120363@g.us');
		});

		it('updates the cached durable pending count for local enqueue and terminalization', async () => {
			service.persistedPendingCount = 7;
			const alert = { text: 'Alert body', correlationId: 'corr-local-count' };
			const results = [{ channel: 'telegram', success: false, error: 'Connection refused' }];

			await service.recordDeliveryResults(alert, results);

			expect(service.getStatus().pendingCount).toBe(8);

			await service.markTerminal('corr-local-count_telegram', 'cancelled');

			expect(service.getStatus().pendingCount).toBe(7);
		});

		it('does not decrement cached durable pending count when terminalization persistence fails', async () => {
			service.persistedPendingCount = 7;
			service.inMemoryStore.set('corr-terminal-failure_telegram', {
				status: 'pending',
				expiresAt: new Date(Date.now() + 60000),
			});
			const failingFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(failingFirestore);

			const marked = await service.markTerminal('corr-terminal-failure_telegram', 'cancelled');

			expect(marked).toBe(false);
			expect(service.getStatus().pendingCount).toBe(7);
		});

		it('records dead-letters to Firestore when Firestore is available', async () => {
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			const alert = { text: 'Alert body', correlationId: 'corr-abc' };
			const results = [
				{ channel: 'telegram', success: false, error: 'Telegram 500 error' },
			];

			const recorded = await service.recordDeliveryResults(alert, results);
			expect(recorded).toHaveLength(1);
			expect(mockDocs.size).toBe(1);

			const doc = Array.from(mockDocs.values())[0];
			expect(doc.channel).toBe('telegram');
			expect(doc.status).toBe('pending');
			expect(doc.attemptCount).toBe(0);
			expect(doc.lastError).toBe('Telegram 500 error');
		});

		it('sanitizes undefined fields before writing to Firestore', async () => {
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			const alert = { text: 'Alert body', undefinedField: undefined };
			const results = [
				{ channel: 'discord', success: false, error: 'Webhook 404', undefinedMeta: undefined },
			];
			const options = { routing: { channels: undefined } };

			await service.recordDeliveryResults(alert, results, options);
			expect(mockDocs.size).toBe(1);
			const doc = Array.from(mockDocs.values())[0];
			expect(doc.alert).not.toHaveProperty('undefinedField');
			expect(doc.destinationOverride).toEqual({});
		});

		it('fails open and records to in-memory store if Firestore throws', async () => {
			const failingFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn().mockRejectedValue(new Error('Firestore quota exceeded')),
					})),
				})),
			};
			alertStorageService.getFirestore.mockReturnValue(failingFirestore);

			const alert = { text: 'Alert fallback', correlationId: 'fail-1' };
			const results = [{ channel: 'telegram', success: false, error: 'Failed' }];

			const recorded = await service.recordDeliveryResults(alert, results);
			expect(recorded).toHaveLength(1);
			expect(service.getPendingCount()).toBe(1);
		});

		it('terminalizes a late durable enqueue before releasing worker cooldown ownership', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const recordId = 'corr-stalled-enqueue_telegram';
			let resolveStalledSet;
			let firstWrite = true;
			const stalledSet = jest.fn((data, options) => {
				if (firstWrite) {
					firstWrite = false;
					return new Promise((resolve) => {
						resolveStalledSet = () => {
							mockDocs.set(recordId, options?.merge ? { ...mockDocs.get(recordId), ...data } : { ...data });
							resolve();
						};
					});
				}
				const existing = mockDocs.get(recordId) || {};
				mockDocs.set(recordId, options?.merge ? { ...existing, ...data } : { ...data });
				return Promise.resolve();
			});
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ id: recordId, set: stalledSet })),
				})),
			});
			const releaseSpy = jest.spyOn(signalRepeatCooldown, 'release');

			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-stalled-enqueue' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{ repeatCooldown: { key: 'BINANCE|ETHUSDT|4h|BUY', channelsByName: { telegram: 'telegram:destination-a' } } },
			);

			expect(stalledSet).toHaveBeenCalledTimes(1);
			expect(releaseSpy).not.toHaveBeenCalled();
			expect(resolveStalledSet).toBeDefined();
			resolveStalledSet();
			await new Promise((resolve) => setImmediate(resolve));
			expect(releaseSpy).toHaveBeenCalledWith('BINANCE|ETHUSDT|4h|BUY', ['telegram:destination-a']);
			expect(mockDocs.get(recordId).status).toBe('cancelled');
			releaseSpy.mockRestore();
		});

		it('keeps worker cooldown ownership when late enqueue cancellation is not durable', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const recordId = 'corr-failed-cancellation_telegram';
			let resolveStalledSet;
			let writeCount = 0;
			const set = jest.fn((data, options) => {
				writeCount += 1;
				if (writeCount === 1) {
					return new Promise((resolve) => {
						resolveStalledSet = () => {
							mockDocs.set(recordId, options?.merge ? { ...mockDocs.get(recordId), ...data } : { ...data });
							resolve();
						};
					});
				}
				return Promise.reject(new Error('cancellation write failed'));
			});
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ id: recordId, set })),
				})),
			});
			const releaseSpy = jest.spyOn(signalRepeatCooldown, 'release');

			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-failed-cancellation' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{ repeatCooldown: { key: 'BINANCE|ETHUSDT|4h|BUY', channelsByName: { telegram: 'telegram:destination-a' } } },
			);

			resolveStalledSet();
			await new Promise((resolve) => setImmediate(resolve));
			expect(releaseSpy).not.toHaveBeenCalled();
			releaseSpy.mockRestore();
		});

		it('keeps web-role cooldowns when Firestore falls back to in-memory redrive', async () => {
			process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
			const failingFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
					})),
				})),
			};
			alertStorageService.getFirestore.mockReturnValue(failingFirestore);
			const reservation = signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				['telegram:destination-a'],
			);

			await service.recordDeliveryResults(
				{ text: 'Alert fallback', correlationId: 'fallback-cooldown' },
				[{ channel: 'telegram', success: false, error: 'Failed' }],
				{
					repeatCooldown: {
						key: reservation.key,
						channelsByName: { telegram: 'telegram:destination-a' },
					},
				},
			);

			expect(signalRepeatCooldown.getStats().activeTrackedSignals).toBe(1);
		});
	});

		describe('sweep and redrive', () => {
		it('compares supersession with reservation time instead of enqueue time', async () => {
			const key = 'BINANCE|ETHUSDT|5m|BUY';
			const channel = 'telegram:destination-a';
			const record = {
				id: 'late-failure_telegram',
				createdAt: new Date(2_000),
				repeatCooldown: { key, channel, reservedAt: 1_000 },
			};
			service.supersessionStore.set(service.getSupersessionId(key, channel), {
				status: 'superseded',
				supersededAt: new Date(1_500),
			});

			expect(await service.isRepeatCooldownSuperseded(record)).toBe(true);
		});

		it('does not persist the default destination sentinel for redrive', async () => {
			await service.recordDeliveryResults(
				{ text: 'Telegram signal', correlationId: 'corr-default-destination' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{
					routing: { channels: ['telegram'] },
					repeatCooldown: {
						key: 'BINANCE|ETHUSDT|5m|BUY',
						channelsByName: { telegram: 'telegram:default' },
						destinationsByName: { telegram: 'default' },
					},
				},
			);

			expect(service.inMemoryStore.get('corr-default-destination_telegram').destinationOverride)
				.toEqual({ channels: ['telegram'] });
		});

		it('redrives to the destination used by the cooldown identity', async () => {
			const mockTelegramSend = jest.fn().mockResolvedValue({ success: true, messageId: 'redrive-destination' });
			const mockNotificationManager = {
				channels: new Map([['telegram', { name: 'telegram', send: mockTelegramSend, isEnabled: () => true }]]),
				sendToChannels: jest.fn(async (payload, channels, opts) => [{
					channel: channels[0],
					...(await mockTelegramSend(payload, opts)),
				}]),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);

			await service.recordDeliveryResults(
				{ text: 'Telegram signal', correlationId: 'corr-destination' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{
					routing: { channels: ['telegram'] },
					repeatCooldown: {
						key: 'BINANCE|ETHUSDT|5m|BUY',
						channelsByName: { telegram: 'telegram:destination-a' },
						destinationsByName: { telegram: 'destination-a' },
					},
				},
			);

			const item = service.inMemoryStore.get('corr-destination_telegram');
			item.nextAttemptAt = Date.now() - 1000;
			await service.sweep();

			expect(mockTelegramSend).toHaveBeenCalledWith(
				expect.objectContaining({ telegramChatId: 'destination-a' }),
				expect.anything(),
			);
		});

		it('bounds supersession reads when Firestore documents stall', async () => {
			const never = new Promise(() => {});
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ get: jest.fn(() => never) })),
				})),
			});

			const result = await service.isRepeatCooldownSuperseded({
				id: 'stalled_telegram',
				createdAt: new Date(),
				repeatCooldown: {
					key: 'BINANCE|ETHUSDT|5m|BUY',
					channel: 'telegram:destination-a',
				},
			});

			expect(result).toBe(false);
		});

		it('does not start overlapping cooldown reconciliation reads after timeout', async () => {
			const stalledGet = jest.fn(() => new Promise(() => {}));
			const query = {
				get: stalledGet,
				limit: jest.fn(() => query),
			};
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({ where: jest.fn(() => query) })),
			});

			await Promise.all([
				service.reconcileRepeatCooldown('BINANCE|ETHUSDT|5m|BUY', ['telegram:destination-a']),
				service.reconcileRepeatCooldown('BINANCE|ETHUSDT|5m|BUY', ['telegram:destination-a']),
			]);

			expect(stalledGet).toHaveBeenCalledTimes(1);
		});

		it('keeps reconciliation single-flight scoped to each cooldown identity', async () => {
			const stalledGet = jest.fn(() => new Promise(() => {}));
			const query = {
				get: stalledGet,
				limit: jest.fn(() => query),
			};
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({ where: jest.fn(() => query) })),
			});

			await Promise.all([
				service.reconcileRepeatCooldown('BINANCE|ETHUSDT|5m|BUY', ['telegram:destination-a']),
				service.reconcileRepeatCooldown('BINANCE|BTCUSDT|5m|BUY', ['telegram:destination-a']),
			]);

			expect(stalledGet).toHaveBeenCalledTimes(2);
		});

		it('retains stalled reconciliation ownership until the Firestore read settles', async () => {
			let resolveStalledGet;
			const stalledGet = jest.fn(() => new Promise((resolve) => {
				resolveStalledGet = resolve;
			}));
			const query = {
				get: stalledGet,
				limit: jest.fn(() => query),
			};
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({ where: jest.fn(() => query) })),
			});

			await service.reconcileRepeatCooldown('BINANCE|ETHUSDT|5m|BUY', ['telegram:destination-a']);

			expect(service.reconciliationPromises.size).toBe(1);
			resolveStalledGet({ docs: [] });
			await new Promise((resolve) => setImmediate(resolve));
			expect(service.reconciliationPromises.size).toBe(0);
		});

		it('reconciles terminal Firestore redrives in the local cooldown store', async () => {
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			const refreshSpy = jest.spyOn(signalRepeatCooldown, 'refresh');
			signalRepeatCooldown.reset();
			signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				['telegram:destination-a'],
				4000,
			);
			mockDocs.set('corr-reconcile_telegram', {
				status: 'delivered',
				repeatCooldown: {
					key: 'BINANCE|ETHUSDT|5m|BUY',
					channel: 'telegram:destination-a',
				},
				deliveredAt: new Date(5000),
			});

			await service.reconcileRepeatCooldown('BINANCE|ETHUSDT|5m|BUY', ['telegram:destination-a']);

			expect(refreshSpy).toHaveBeenCalledWith('BINANCE|ETHUSDT|5m|BUY', ['telegram:destination-a'], 5000);
			refreshSpy.mockRestore();
		});

		it('paginates terminal Firestore redrives beyond the first page', async () => {
			const key = 'BINANCE|ETHUSDT|5m|BUY';
			const channel = 'telegram:destination-a';
			const firstPage = Array.from({ length: 200 }, (_, index) => ({
				id: `old-${index}`,
				status: 'delivered',
				repeatCooldown: { key, channel },
				deliveredAt: new Date(5000),
			}));
			const secondPage = [{
				id: 'new-terminal',
				status: 'delivered',
				repeatCooldown: { key, channel },
				 deliveredAt: new Date(6000),
			}];
			let pageIndex = 0;
			const getPage = jest.fn(async () => ({
				docs: (pageIndex++ === 0 ? firstPage : secondPage).map((record) => ({
					id: record.id,
					data: () => record,
				})),
			}));
			const secondQuery = {
				get: getPage,
				limit: jest.fn(() => secondQuery),
			};
			const query = {
				get: getPage,
				limit: jest.fn(() => query),
				startAfter: jest.fn(() => secondQuery),
			};
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({ where: jest.fn(() => query) })),
			});
			signalRepeatCooldown.reset();
			signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				[channel],
				4000,
			);
			const refreshSpy = jest.spyOn(signalRepeatCooldown, 'refresh');

			await service.reconcileRepeatCooldown(key, [channel]);

			expect(getPage).toHaveBeenCalledTimes(2);
			expect(refreshSpy).toHaveBeenCalledWith(key, [channel], 6000);
		});

		it('filters stale generations before selecting the newest terminal transition', async () => {
			const key = 'BINANCE|ETHUSDT|5m|BUY';
			const channel = 'telegram:destination-a';
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			signalRepeatCooldown.reset();
			signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				[channel],
				4_000,
			);
			signalRepeatCooldown.refresh(key, [channel], 10_000);
			mockDocs.set('old-terminal', {
				status: 'cancelled',
				repeatCooldown: { key, channel, reservedAt: 4_000 },
				terminalAt: new Date(20_000),
			});
			mockDocs.set('new-delivery', {
				status: 'delivered',
				repeatCooldown: { key, channel, reservedAt: 10_000 },
				deliveredAt: new Date(15_000),
			});
			const refreshSpy = jest.spyOn(signalRepeatCooldown, 'refresh');

			await service.reconcileRepeatCooldown(key, [channel]);

			expect(refreshSpy).toHaveBeenCalledWith(key, [channel], 15_000);
			refreshSpy.mockRestore();
		});

		it('does not apply an older terminal redrive to a newer local reservation', async () => {
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			const releaseSpy = jest.spyOn(signalRepeatCooldown, 'release');
			const current = signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				['telegram:destination-a'],
				10_000,
			);
			mockDocs.set('corr-old-terminal_telegram', {
				status: 'expired',
				repeatCooldown: {
					key: current.key,
					channel: 'telegram:destination-a',
				},
				terminalAt: new Date(5000),
			});

			await service.reconcileRepeatCooldown(current.key, ['telegram:destination-a']);

			expect(releaseSpy).not.toHaveBeenCalled();
			releaseSpy.mockRestore();
		});

		it('does not release a newer local reservation for an older terminal redrive', async () => {
			const key = 'BINANCE|ETHUSDT|5m|BUY';
			const channel = 'telegram:destination-a';
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			signalRepeatCooldown.reset();
			signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				[channel],
				4_000,
			);
			signalRepeatCooldown.refresh(key, [channel], 10_000);
			mockDocs.set('corr-old-generation_telegram', {
				status: 'expired',
				repeatCooldown: { key, channel, reservedAt: 4_000 },
				terminalAt: new Date(20_000),
			});
			const refreshSpy = jest.spyOn(signalRepeatCooldown, 'refresh');

			await service.reconcileRepeatCooldown(key, [channel]);

			expect(refreshSpy).not.toHaveBeenCalled();
			refreshSpy.mockRestore();
		});

		it('fences redrive cooldown release so an older terminal redrive does not release a newer reservation with a higher generation', async () => {
			const key = 'BINANCE|ETHUSDT|5m|BUY';
			const channel = 'telegram:destination-a';
			signalRepeatCooldown.reset();
			const firstRes = signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				[channel],
				4_000,
			);
			const secondRes = signalRepeatCooldown.reserve(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' },
				[channel],
				5_000,
			);

			const releaseSpy = jest.spyOn(signalRepeatCooldown, 'release');

			// Redrive record for first reservation with older generation expires/exhausts
			const oldRecord = {
				id: 'corr-old-gen_telegram',
				status: 'exhausted',
				repeatCooldown: {
					key,
					channel,
					generation: firstRes.generation,
				},
			};

			service.inMemoryStore.set(oldRecord.id, oldRecord);
			// Trigger release via service helper
			await service.reconcileRepeatCooldown(key, [channel]);

			// Cooldown timestamp on channel should remain intact
			expect(signalRepeatCooldown.getChannelTimestamp(key, channel)).toBe(4_000);
			releaseSpy.mockRestore();
		});

		it('uses Firestore commit timestamps to determine supersession across replicas', async () => {
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			const key = 'BINANCE|ETHUSDT|4h|BUY';
			const channel = 'telegram:destination-a';
			const supersessionId = service.getSupersessionId(key, channel);

			const recordId = 'corr-reentry_telegram';
			mockDocs.set(recordId, {
				id: recordId,
				status: 'pending',
				repeatCooldown: { key, channel, generation: 1000 },
			});
			// Mock record document with createTime later than supersession (new re-entry)
			mockFirestore.collection = jest.fn(() => ({
				doc: jest.fn((id) => {
					if (id === recordId) {
						return {
							id,
							get: jest.fn(async () => ({
								exists: true,
								id,
								data: () => mockDocs.get(recordId),
								createTime: { seconds: 1005, nanoseconds: 500000 },
							})),
						};
					}
					if (id === supersessionId) {
						return {
							id,
							get: jest.fn(async () => ({
								exists: true,
								id,
								data: () => ({ status: 'superseded', key, channel, generation: 1000 }),
								updateTime: { seconds: 1000, nanoseconds: 0 },
							})),
						};
					}
					return { id, get: jest.fn(async () => ({ exists: false })) };
				}),
			}));

			const isSuperseded = await service.isRepeatCooldownSuperseded({
				id: recordId,
				repeatCooldown: { key, channel, generation: 1000 },
			});

			// Since record TrueTime is later than supersession TrueTime, it should NOT be superseded
			expect(isSuperseded).toBe(false);
		});

		it('cancels pending opposite-side redrives', async () => {
			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-cancel' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{
					repeatCooldown: {
						key: 'BINANCE|ETHUSDT|4h|BUY',
						channelsByName: { telegram: 'telegram:destination-a' },
					},
				},
			);

			await service.cancelPendingRepeatCooldowns('BINANCE|ETHUSDT|4h|BUY', ['telegram:destination-a']);

			expect(service.inMemoryStore.get('corr-cancel_telegram').status).toBe('cancelled');
		});

		it('does not cancel reservations created after the supersession marker', async () => {
			const key = 'BINANCE|ETHUSDT|4h|BUY';
			const channel = 'telegram:destination-a';
			const now = Date.now();
			service.inMemoryStore.set('old', {
				id: 'old',
				status: 'pending',
				repeatCooldown: { key, channel, reservedAt: now - 100 },
			});
			service.inMemoryStore.set('new', {
				id: 'new',
				status: 'pending',
				repeatCooldown: { key, channel, reservedAt: now + 10000 },
			});
			await service.cancelPendingRepeatCooldowns(key, [channel]);

			expect(service.inMemoryStore.get('old').status).toBe('cancelled');
			expect(service.inMemoryStore.get('new').status).toBe('pending');
		});

		it('does not supersede same-millisecond re-entry reservation created after supersession marker with higher generation', async () => {
			const key = 'BINANCE|ETHUSDT|4h|BUY';
			const channel = 'telegram:destination-a';
			const now = Date.now();
			const supersession = await service.markRepeatSupersession(key, [channel]);
			const supersessionGen = supersession.generation;

			const oldRecord = {
				id: 'old-gen',
				status: 'pending',
				repeatCooldown: { key, channel, reservedAt: now, generation: supersessionGen - 1 },
			};
			const newRecord = {
				id: 'new-gen',
				status: 'pending',
				repeatCooldown: { key, channel, reservedAt: now, generation: supersessionGen + 1 },
			};

			const oldSuperseded = await service.isRepeatCooldownSuperseded(oldRecord);
			const newSuperseded = await service.isRepeatCooldownSuperseded(newRecord);

			expect(oldSuperseded).toBe(true);
			expect(newSuperseded).toBe(false);
		});

		it('bounds cancellation scan and resolves within deadline when firestore stalls', async () => {
			const key = 'BINANCE|ETHUSDT|4h|BUY';
			const channel = 'telegram:destination-a';
			let hanging = false;
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn().mockResolvedValue(true),
					})),
					where: jest.fn().mockReturnThis(),
					get: jest.fn(() => {
						hanging = true;
						return new Promise(() => {});
					}),
				})),
			});

			const startTime = Date.now();
			const result = await service.cancelPendingRepeatCooldowns(key, [channel], Date.now() + 50);
			const elapsed = Date.now() - startTime;

			expect(hanging).toBe(true);
			expect(elapsed).toBeLessThan(300);
			expect(result).toBe(0);
		});

		it('marks all local supersessions before awaiting durable writes', async () => {
			const key = 'BINANCE|ETHUSDT|4h|BUY';
			const channels = ['telegram:destination-a', 'whatsapp:destination-b'];
			let resolveFirstWrite;
			const set = jest.fn((data) => {
				if (data.channel === channels[0]) {
					return new Promise((resolve) => {
						resolveFirstWrite = resolve;
					});
				}
				return Promise.resolve();
			});
			alertStorageService.getFirestore.mockReturnValue({
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ set })),
				})),
			});

			const supersessionPromise = service.markRepeatSupersession(key, channels);
			await new Promise((resolve) => setImmediate(resolve));

			expect(service.supersessionStore.get(service.getSupersessionId(key, channels[0]))).toBeDefined();
			expect(service.supersessionStore.get(service.getSupersessionId(key, channels[1]))).toBeDefined();
			expect(set).toHaveBeenCalledTimes(2);
			resolveFirstWrite();
			await supersessionPromise;
		});

		it('blocks a redrive recorded after an opposite-side supersession', async () => {
			const reservedAt = Date.now();
			await service.cancelPendingRepeatCooldowns('BINANCE|ETHUSDT|4h|BUY', ['telegram:destination-a']);

			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-after-flip' },
				[{ channel: 'telegram', success: false, error: 'Late failure' }],
				{
					repeatCooldown: {
						key: 'BINANCE|ETHUSDT|4h|BUY',
						channelsByName: { telegram: 'telegram:destination-a' },
						reservedAt,
					},
				},
			);

			expect(service.inMemoryStore.get('corr-after-flip_telegram').status).toBe('cancelled');
		});

		it('cancels already claimed opposite-side redrives', async () => {
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-in-flight' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{
					repeatCooldown: {
						key: 'BINANCE|ETHUSDT|4h|BUY',
						channelsByName: { telegram: 'telegram:destination-a' },
					},
				},
			);
			service.inMemoryStore.get('corr-in-flight_telegram').status = 'in_flight';
			mockDocs.set('corr-in-flight_telegram', service.inMemoryStore.get('corr-in-flight_telegram'));

			await service.cancelPendingRepeatCooldowns('BINANCE|ETHUSDT|4h|BUY', ['telegram:destination-a']);

			expect(service.inMemoryStore.get('corr-in-flight_telegram').status).toBe('cancelled');
			expect(mockDocs.get('corr-in-flight_telegram').status).toBe('cancelled');
		});

		it('skips dispatch when a claimed redrive was superseded', async () => {
			const mockTelegramSend = jest.fn();
			service.setNotificationManagerGetter(() => ({
				sendToChannels: jest.fn(),
			}));
			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-superseded' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{
					repeatCooldown: {
						key: 'BINANCE|ETHUSDT|4h|BUY',
						channelsByName: { telegram: 'telegram:destination-a' },
					},
				},
			);
			service.inMemoryStore.get('corr-superseded_telegram').nextAttemptAt = Date.now() - 1000;
			jest.spyOn(service, 'isRepeatCooldownSuperseded').mockResolvedValue(true);

			await service.sweep();

			expect(mockTelegramSend).not.toHaveBeenCalled();
			expect(service.inMemoryStore.get('corr-superseded_telegram').status).toBe('cancelled');
		});

		it('refreshes cooldown state when redrive succeeds', async () => {
			const refreshSpy = jest.spyOn(signalRepeatCooldown, 'refresh');
			const mockTelegramSend = jest.fn().mockResolvedValue({ success: true, messageId: 'redrive-msg-refresh' });
			service.setNotificationManagerGetter(() => ({
				channels: new Map([['telegram', { name: 'telegram', send: mockTelegramSend, isEnabled: () => true }]]),
				sendToChannels: jest.fn(async (payload, channels, opts) => [{ channel: 'telegram', ...(await mockTelegramSend(payload, opts)) }]),
			}));

			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-refresh' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{
					repeatCooldown: {
						key: 'BINANCE|ETHUSDT|5m|BUY',
						channelsByName: { telegram: 'telegram:destination-a' },
					},
				},
			);
			service.inMemoryStore.get('corr-refresh_telegram').nextAttemptAt = Date.now() - 1000;

			await service.sweep();

			expect(refreshSpy).toHaveBeenCalledWith('BINANCE|ETHUSDT|5m|BUY', ['telegram:destination-a']);
			refreshSpy.mockRestore();
		});

		it('dispatches only failed channels with channel isolation and isRedrive: true', async () => {
			const mockTelegramSend = jest.fn().mockResolvedValue({ success: true, messageId: 'redrive-msg-1' });
			const mockWhatsappSend = jest.fn();
			const mockNotificationManager = {
				channels: new Map([
					['telegram', { name: 'telegram', send: mockTelegramSend, isEnabled: () => true }],
					['whatsapp', { name: 'whatsapp', send: mockWhatsappSend, isEnabled: () => true }],
				]),
				sendToChannels: jest.fn(async (payload, channels, opts) => {
					if (channels.includes('telegram')) {
						const res = await mockTelegramSend(payload, opts);
						return [{ channel: 'telegram', ...res }];
					}
					return [];
				}),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);

			const alert = { text: 'BTC signal', correlationId: 'corr-99', telegramChatId: '12345' };
			const results = [{ channel: 'telegram', success: false, error: 'Rate limit' }];
			await service.recordDeliveryResults(alert, results);

			// Ensure nextAttemptAt is in past so candidate is immediately eligible
			const item = service.inMemoryStore.get('corr-99_telegram');
			item.nextAttemptAt = Date.now() - 1000;

			expect(service.getPendingCount()).toBe(1);

			const sweepResult = await service.sweep();
			expect(sweepResult.scanned).toBe(1);
			expect(sweepResult.redriven).toBe(1);
			expect(mockTelegramSend).toHaveBeenCalledTimes(1);
			expect(mockWhatsappSend).not.toHaveBeenCalled();

			const callArgs = mockTelegramSend.mock.calls[0];
			expect(callArgs[0]).toMatchObject({
				text: 'BTC signal',
				telegramChatId: '12345',
			});
			expect(callArgs[1]).toMatchObject({
				isRedrive: true,
			});

			expect(service.getPendingCount()).toBe(0);
			expect(service.totalDeliveredCount).toBe(1);
		});

		it('aborts an in-flight redrive when the signal is superseded', async () => {
			const key = 'BINANCE|ETHUSDT|4h|BUY';
			const channel = 'telegram:destination-a';
			let resolveDispatch;
			let dispatchSignal;
			const dispatchStarted = new Promise((resolve) => {
				service.setNotificationManagerGetter(() => ({
					channels: new Map([['telegram', { name: 'telegram', isEnabled: () => true }]]),
					sendToChannels: jest.fn((payload, channels, options) => {
						dispatchSignal = options.signal;
						resolve();
						return new Promise((dispatchResolve) => {
							resolveDispatch = dispatchResolve;
						});
					}),
				}));
			});

			await service.recordDeliveryResults(
				{ text: 'BUY signal', correlationId: 'corr-abort' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
				{ repeatCooldown: { key, channelsByName: { telegram: channel } } },
			);
			service.inMemoryStore.get('corr-abort_telegram').nextAttemptAt = Date.now() - 1000;

			const sweepPromise = service.sweep();
			await dispatchStarted;
			await service.cancelPendingRepeatCooldowns(key, [channel]);
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(dispatchSignal).toBeDefined();
			expect(dispatchSignal.aborted).toBe(true);
			resolveDispatch([{ channel: 'telegram', success: false, error: 'Aborted' }]);
			await sweepPromise;
			expect(service.inMemoryStore.get('corr-abort_telegram').status).toBe('cancelled');
		});

		it('handles retry failure with backoff increment', async () => {
			const mockTelegramSend = jest.fn().mockResolvedValue({ success: false, error: 'Still failing' });
			const mockNotificationManager = {
				channels: new Map([
					['telegram', { name: 'telegram', send: mockTelegramSend, isEnabled: () => true }],
				]),
				sendToChannels: jest.fn(async (payload, channels, opts) => {
					const res = await mockTelegramSend(payload, opts);
					return [{ channel: 'telegram', ...res }];
				}),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);

			const alert = { text: 'BTC signal', correlationId: 'corr-retry' };
			await service.recordDeliveryResults(alert, [{ channel: 'telegram', success: false, error: 'Initial error' }]);

			const item = service.inMemoryStore.get('corr-retry_telegram');
			item.nextAttemptAt = Date.now() - 1000;

			const sweepResult = await service.sweep();
			expect(sweepResult.scanned).toBe(1);
			expect(sweepResult.errors).toBe(1);
			expect(service.getPendingCount()).toBe(1);

			const updatedItem = service.inMemoryStore.get('corr-retry_telegram');
			expect(updatedItem.attemptCount).toBe(1);
			expect(updatedItem.status).toBe('pending');
			expect(updatedItem.lastError).toBe('Still failing');
			expect(updatedItem.nextAttemptAt).toBeDefined();
		});

		it('transitions to exhausted and pages admin when max attempts reached', async () => {
			process.env.NOTIFICATION_REDRIVE_MAX_ATTEMPTS = '2';
			const mockTelegramSend = jest.fn().mockResolvedValue({ success: false, error: 'Fatal error' });
			const mockAdminSend = jest.fn().mockResolvedValue({ success: true });
			const mockNotificationManager = {
				channels: new Map([
					['telegram', {
						name: 'telegram',
						send: jest.fn((alertObj, opts) => {
							if (alertObj?.telegramChatId === 'admin-chat-123' || opts?.telegramChatId === 'admin-chat-123') {
								return mockAdminSend(alertObj, opts);
							}
							return mockTelegramSend(alertObj, opts);
						}),
						isEnabled: () => true,
					}],
				]),
				sendToChannels: jest.fn(async (payload, channels, opts) => {
					const res = await mockTelegramSend(payload, opts);
					return [{ channel: 'telegram', ...res }];
				}),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);

			const alert = { text: 'ETH signal', correlationId: 'corr-exhaust' };
			const releaseSpy = jest.spyOn(signalRepeatCooldown, 'release');
			await service.recordDeliveryResults(alert, [{ channel: 'telegram', success: false, error: 'Init fail' }], {
				repeatCooldown: {
					key: 'BINANCE|ETHUSDT|4h|BUY',
					channelsByName: { telegram: 'telegram:destination-a' },
				},
			});

			const item = service.inMemoryStore.get('corr-exhaust_telegram');
			item.nextAttemptAt = Date.now() - 1000;

			// Attempt 1
			await service.sweep();
			expect(service.getPendingCount()).toBe(1);

			// Force fresh nextAttemptAt to past
			const itemAfterAttempt1 = service.inMemoryStore.get('corr-exhaust_telegram');
			itemAfterAttempt1.nextAttemptAt = Date.now() - 1000;

			// Attempt 2 -> exhausts
			const sweepResult2 = await service.sweep();
			expect(sweepResult2.errors).toBe(1);
			expect(service.getPendingCount()).toBe(0);

			const itemAfterAttempt2 = service.inMemoryStore.get('corr-exhaust_telegram');
			expect(itemAfterAttempt2.status).toBe('exhausted');

			// Admin notification should have been sent
			expect(mockAdminSend).toHaveBeenCalledTimes(1);
			const adminMsg = mockAdminSend.mock.calls[0][0].text;
			expect(adminMsg).toContain('Notification Redrive Exhausted');
			expect(adminMsg).toContain('telegram');
			expect(adminMsg).toContain('Fatal error');
			expect(releaseSpy).toHaveBeenCalledWith('BINANCE|ETHUSDT|4h|BUY', ['telegram:destination-a']);
			releaseSpy.mockRestore();
		});

		it('expires dead-letter records older than maxAgeMs', async () => {
			process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS = '1000';
			const mockNotificationManager = {
				channels: new Map([
					['telegram', { name: 'telegram', send: jest.fn(), isEnabled: () => true }],
				]),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);

			const alert = { text: 'Expired alert', correlationId: 'corr-exp' };
			await service.recordDeliveryResults(alert, [{ channel: 'telegram', success: false, error: 'Err' }]);

			const item = service.inMemoryStore.get('corr-exp_telegram');
			item.expiresAt = Date.now() - 2000;

			const sweepResult = await service.sweep();
			expect(sweepResult.scanned).toBe(1);
			const expiredItem = service.inMemoryStore.get('corr-exp_telegram');
			expect(expiredItem.status).toBe('expired');
			expect(service.getPendingCount()).toBe(0);
		});

		it('operates identically on Firestore store', async () => {
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
			const mockTelegramSend = jest.fn().mockResolvedValue({ success: true, messageId: 'firestore-redrive-1' });
			const mockNotificationManager = {
				channels: new Map([
					['telegram', { name: 'telegram', send: mockTelegramSend, isEnabled: () => true }],
				]),
				sendToChannels: jest.fn(async (payload, channels, opts) => {
					const res = await mockTelegramSend(payload, opts);
					return [{ channel: 'telegram', ...res }];
				}),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);

			const alert = { text: 'Firestore signal', correlationId: 'fs-1' };
			await service.recordDeliveryResults(alert, [{ channel: 'telegram', success: false, error: 'Temp network drop' }]);

			expect(mockDocs.size).toBe(1);
			const item = mockDocs.get('fs-1_telegram');
			item.nextAttemptAt = Date.now() - 1000;

			const sweepResult = await service.sweep();
			expect(sweepResult.redriven).toBe(1);
			expect(mockTelegramSend).toHaveBeenCalledTimes(1);

			const doc = mockDocs.get('fs-1_telegram');
			expect(doc.status).toBe('delivered');
		});

		it('does not increment exhaustedCount if markTerminal fails', async () => {
			const candidate = {
				id: 'record_fail',
				channel: 'telegram',
				attemptCount: 10,
				expired: true,
				createdAt: new Date(),
			};
			jest.spyOn(service, 'getEligibleRecords').mockResolvedValue([candidate]);
			jest.spyOn(service, 'markTerminal').mockResolvedValue(false);
			const notifySpy = jest.spyOn(service, 'notifyAdminPermanentFailure');

			const initialExhausted = service.totalExhaustedCount;
			await service.sweep();

			expect(service.totalExhaustedCount).toBe(initialExhausted);
			expect(service.lastRunExhaustedCount).toBe(0);
			expect(service.lastSweepResult.exhausted).toBe(0);
			expect(service.lastRunErrorCount).toBe(1);
			expect(service.lastSweepResult.errors).toBe(1);
			expect(notifySpy).not.toHaveBeenCalled();
		});

		it('does not count a redrive as delivered if terminal persistence fails', async () => {
			const mockTelegramSend = jest.fn().mockResolvedValue({ success: true });
			const mockNotificationManager = {
				channels: new Map([
					['telegram', { name: 'telegram', send: mockTelegramSend, isEnabled: () => true }],
				]),
				sendToChannels: jest.fn(async (payload, channels, options) => {
					const result = await mockTelegramSend(payload, options);
					return [{ channel: 'telegram', ...result }];
				}),
			};
			service.setNotificationManagerGetter(() => mockNotificationManager);
			await service.recordDeliveryResults(
				{ text: 'Delivery persistence failure', correlationId: 'corr-delivery-terminal-failure' },
				[{ channel: 'telegram', success: false, error: 'Initial failure' }],
			);
			service.inMemoryStore.get('corr-delivery-terminal-failure_telegram').nextAttemptAt = Date.now() - 1000;
			jest.spyOn(service, 'markTerminal').mockResolvedValue(false);

			const sweepResult = await service.sweep();

			expect(sweepResult.redriven).toBe(0);
			expect(sweepResult.errors).toBe(1);
			expect(service.totalDeliveredCount).toBe(0);
			expect(service.lastSweepResult).toMatchObject({ succeeded: 0, errors: 1 });
			expect(service.inMemoryStore.get('corr-delivery-terminal-failure_telegram').status).toBe('in_flight');
		});

		it('increments exhaustedCount when markTerminal succeeds', async () => {
			const candidate = {
				id: 'record_success',
				channel: 'telegram',
				attemptCount: 10,
				expired: true,
				createdAt: new Date(),
			};
			jest.spyOn(service, 'getEligibleRecords').mockResolvedValue([candidate]);
			jest.spyOn(service, 'markTerminal').mockResolvedValue(true);
			const notifySpy = jest.spyOn(service, 'notifyAdminPermanentFailure').mockResolvedValue();

			const initialExhausted = service.totalExhaustedCount;
			await service.sweep();

			expect(service.totalExhaustedCount).toBe(initialExhausted + 1);
			expect(service.lastRunExhaustedCount).toBe(1);
			expect(service.lastSweepResult.exhausted).toBe(1);
			expect(notifySpy).toHaveBeenCalled();
		});

		it('reports only exhaustion completed by the current sweep', async () => {
			const candidate = {
				id: 'record_remote-count',
				channel: 'telegram',
				attemptCount: 10,
				expired: true,
				createdAt: new Date(),
			};
			jest.spyOn(service, 'getEligibleRecords').mockResolvedValue([candidate]);
			jest.spyOn(service, 'markTerminal').mockImplementation(async () => {
				// Simulate a late heartbeat completion merging a remote cumulative count.
				service.totalExhaustedCount = 25;
				return true;
			});
			jest.spyOn(service, 'notifyAdminPermanentFailure').mockResolvedValue();

			await service.sweep();

			expect(service.totalExhaustedCount).toBe(26);
			expect(service.lastRunExhaustedCount).toBe(1);
			expect(service.lastSweepResult.exhausted).toBe(1);
		});
	});

	describe('worker lifecycle', () => {
		it('starts worker when role is web and redrive is enabled', () => {
			jest.useFakeTimers();
			const started = service.startWorker();
			expect(started).toBe(true);
			expect(service.running).toBe(true);

			jest.advanceTimersByTime(60000);
			service.stopWorker({ drain: false });
			expect(service.running).toBe(false);
			jest.useRealTimers();
		});

		it('does not start worker when role is disabled', () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'disabled';
			const started = service.startWorker();
			expect(started).toBe(false);
			expect(service.running).toBe(false);
		});

		it('drains active sweep on stopWorker', async () => {
			service.activeSweepPromise = new Promise((resolve) => {
				setTimeout(resolve, 20);
			});

			const stopPromise = service.stopWorker({ drain: true, timeoutMs: 500 });
			await expect(stopPromise).resolves.toBeUndefined();
			expect(service.running).toBe(false);
		});

		it('persists worker telemetry to Firestore upon sweep and syncs worker state for status reporting', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const storedHeartbeats = new Map();
			const mockFirestore = {
				collection: jest.fn((colName) => {
					if (colName === 'workerHeartbeats') {
						return {
							doc: jest.fn((docId) => ({
								set: jest.fn(async (data) => {
									storedHeartbeats.set(docId, data);
								}),
								get: jest.fn(async () => {
									const data = storedHeartbeats.get(docId);
									return {
										exists: Boolean(data),
										data: () => data,
									};
								}),
							})),
						};
					}
					return {
						doc: jest.fn(() => ({ set: jest.fn() })),
					};
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			service.lastRunAt = new Date('2026-09-13T10:00:00.000Z');
			service.lastSweepAt = new Date('2026-09-13T10:00:05.000Z');
			service.lastSweepResult = {
				processed: 3,
				succeeded: 2,
				exhausted: 1,
				errors: 0,
			};
			service.lastRunDurationMs = 5000;
			service.lastRunScannedCount = 3;
			service.lastRunRedrivenCount = 2;
			service.lastRunExhaustedCount = 1;
			service.totalDeliveredCount = 2;
			service.totalExhaustedCount = 1;

			const persisted = await service.persistWorkerTelemetry();
			expect(persisted).toBe(true);
			expect(storedHeartbeats.get('notification-redrive')).toMatchObject({
				worker: 'notification-redrive',
				role: 'worker',
				workerRole: 'worker',
				lastSweepAt: '2026-09-13T10:00:05.000Z',
				lastSweepResult: {
					processed: 3,
					succeeded: 2,
					exhausted: 1,
					errors: 0,
				},
				deliveredCount: 2,
				exhaustedCount: 1,
			});

			const webService = new NotificationRedriveService();
			jest.spyOn(webService, 'getFirestore').mockReturnValue(mockFirestore);

			const synced = await webService.syncWorkerTelemetry();
			expect(synced).toBe(true);

			const webStatus = webService.getStatus();
			expect(webStatus.role).toBe('worker');
			expect(webStatus.workerRole).toBe('worker');
			expect(webStatus.lastSweepAt).toBe('2026-09-13T10:00:05.000Z');
			expect(webStatus.lastSweepResult).toEqual({
				processed: 3,
				succeeded: 2,
				exhausted: 1,
				errors: 0,
			});
			expect(webStatus.deliveredCount).toBe(2);
			expect(webStatus.exhaustedCount).toBe(1);
			expect(webStatus.lastRunDurationMs).toBe(5000);
			expect(webStatus.lastRunScannedCount).toBe(3);
			expect(webStatus.lastRunRedrivenCount).toBe(2);
			expect(webStatus.lastRunExhaustedCount).toBe(1);

			webService.resetForTesting();
		});

		it('starts telemetry sync in web process when role is worker', () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const startSyncSpy = jest.spyOn(service, '_startTelemetrySync').mockImplementation(() => {});

			const started = service.startWorker({ source: 'web' });
			expect(started).toBe(false);
			expect(startSyncSpy).toHaveBeenCalled();
		});

		it('records sweep completion time in lastSweepAt and awaits persistWorkerTelemetry', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let persistCalled = false;
			jest.spyOn(service, 'persistWorkerTelemetry').mockImplementation(async () => {
				persistCalled = true;
				return true;
			});
			jest.spyOn(service, 'getEligibleRecords').mockImplementation(async () => {
				await new Promise((r) => setTimeout(r, 50));
				return [];
			});

			const startTimeBefore = Date.now();
			await service._executeSweep();

			expect(persistCalled).toBe(true);
			expect(service.lastSweepAt).toBeInstanceOf(Date);
			expect(service.lastSweepAt.getTime()).toBeGreaterThanOrEqual(startTimeBefore + 40);
			expect(service.lastRunDurationMs).toBeGreaterThanOrEqual(40);
		});

		it('serializes telemetry writes and prevents timed-out writes from overwriting newer metrics', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let committedSequence = 0;
			const commits = [];

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn(),
					})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: committedSequence > 0,
							data: () => ({ sequence: committedSequence }),
						})),
						set: jest.fn((ref, payload) => {
							committedSequence = payload.sequence;
							commits.push(payload);
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const p1 = service.persistWorkerTelemetry();
			const p2 = service.persistWorkerTelemetry();

			await Promise.all([p1, p2]);

			expect(commits.length).toBeGreaterThan(0);
			expect(committedSequence).toBe(2);
			expect(commits[commits.length - 1].sequence).toBe(2);
		});

		it('allows restarted worker with lower sequence to update heartbeat when lastSweepAt is newer', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let committedPayload = null;

			const preRestartTimestamp = new Date(Date.now() - 3600000).toISOString();
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn(),
					})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({
								sequence: 500, // High sequence from pre-restart worker
								lastSweepAt: preRestartTimestamp,
							}),
						})),
						set: jest.fn((ref, payload) => {
							committedPayload = payload;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// New process starts with sequence 0, will increment to 1
			service._telemetryWriteSequence = 0;
			service.lastSweepAt = new Date();

			const success = await service.persistWorkerTelemetry();
			expect(success).toBe(true);
			expect(committedPayload).not.toBeNull();
			expect(committedPayload.sequence).toBe(1);
			expect(new Date(committedPayload.lastSweepAt).getTime()).toBeGreaterThan(new Date(preRestartTimestamp).getTime());
		});

		it('drops stale telemetry write if existing heartbeat has newer lastSweepAt', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let transactionSetCalled = false;

			const futureTimestamp = new Date(Date.now() + 60000).toISOString();
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn(),
					})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({
								sequence: 1,
								lastSweepAt: futureTimestamp,
							}),
						})),
						set: jest.fn(() => {
							transactionSetCalled = true;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			service.lastSweepAt = new Date(); // Older than futureTimestamp
			const success = await service.persistWorkerTelemetry();
			expect(success).toBe(true);
			expect(transactionSetCalled).toBe(false);
		});

		it('unblocks subsequent telemetry writes when a previous write times out', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let secondWriteCommitted = false;

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn(),
					})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({ exists: false })),
						set: jest.fn(() => {
							secondWriteCommitted = true;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// First write: simulate hung write that times out after 20ms
			const hangingPromise = new Promise(() => {}); // never resolves
			service._activeTelemetryWritePromise = hangingPromise;

			// Second write with 20ms timeout should unblock itself via race and succeed
			const success = await service.persistWorkerTelemetry({ timeoutMs: 20 });
			expect(success).toBe(true);
			expect(secondWriteCommitted).toBe(true);
			expect(service._activeTelemetryWritePromise).toBeNull();
		});

		it('reserves separate write budget and avoids zombie writes when waiting for previous write', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let secondWriteCommitted = false;

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						set: jest.fn(),
					})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					await new Promise((resolve) => setTimeout(resolve, 15));
					const mockTx = {
						get: jest.fn(async () => ({ exists: false })),
						set: jest.fn(() => {
							secondWriteCommitted = true;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// First write takes 20ms to resolve
			service._activeTelemetryWritePromise = new Promise((resolve) => {
				setTimeout(resolve, 20);
			});

			// Second write with waitTimeoutMs: 30 and timeoutMs: 30 succeeds and commits
			const success = await service.persistWorkerTelemetry({ waitTimeoutMs: 30, timeoutMs: 30 });
			expect(success).toBe(true);
			expect(secondWriteCommitted).toBe(true);
			expect(service._activeTelemetryWritePromise).toBeNull();
		});

		it('drains both active sweep and active telemetry promise on stopWorker', async () => {
			let sweepResolved = false;
			let telemetryResolved = false;

			service.activeSweepPromise = new Promise((resolve) => {
				setTimeout(() => {
					sweepResolved = true;
					resolve();
				}, 20);
			});

			service._activeTelemetryWritePromise = new Promise((resolve) => {
				setTimeout(() => {
					telemetryResolved = true;
					resolve();
				}, 30);
			});

			await service.stopWorker({ drain: true, timeoutMs: 500 });
			expect(sweepResolved).toBe(true);
			expect(telemetryResolved).toBe(true);
			expect(service.running).toBe(false);
		});

		it('flushes scheduled zero-channel retries before shutdown completes', async () => {
			jest.useFakeTimers();
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);
			const persistSpy = jest
				.spyOn(service, '_persistZeroChannelIncrement')
				.mockResolvedValue({ persisted: true, retryable: false });

			service._pendingZeroChannelWriteDelta = 2;
			service._scheduleZeroChannelRetry();

			expect(service._zeroChannelRetryTimer).not.toBeNull();

			try {
				await service.stopWorker({ drain: true, timeoutMs: 500 });

				expect(persistSpy).toHaveBeenCalledWith(2);
				expect(service._pendingZeroChannelWriteDelta).toBe(0);
				expect(service._zeroChannelRetryTimer).toBeNull();
			} finally {
				jest.useRealTimers();
			}
		});

		it('deduplicates concurrent syncWorkerTelemetry calls into a single-flight read', async () => {
			let readCount = 0;
			const delayedRead = new Promise((resolve) => {
				setTimeout(() => {
					readCount += 1;
					resolve({
						exists: true,
						data: () => ({
							lastSweepAt: new Date().toISOString(),
							lastRunDurationMs: 1234,
						}),
					});
				}, 20);
			});

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						get: jest.fn(() => delayedRead),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const [r1, r2] = await Promise.all([
				service.syncWorkerTelemetry(),
				service.syncWorkerTelemetry(),
			]);

			expect(r1).toBe(true);
			expect(r2).toBe(true);
			expect(readCount).toBe(1);
		});

		it('discards stale telemetry snapshots with older lastSweepAt', async () => {
			const cachedDate = new Date('2026-09-13T12:00:00.000Z');
			service.persistedLastSweepAt = cachedDate;
			service.persistedLastRunDurationMs = 5000;

			const staleDate = new Date('2026-09-13T11:00:00.000Z'); // 1 hour older
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({
								lastSweepAt: staleDate.toISOString(),
								lastRunDurationMs: 9999,
							}),
						})),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const result = await service.syncWorkerTelemetry();
			expect(result).toBe(false);
			expect(service.persistedLastSweepAt).toEqual(cachedDate);
			expect(service.persistedLastRunDurationMs).toBe(5000);
		});

		it('preserves local pending-count adjustments when syncing the same heartbeat snapshot', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const cachedDate = new Date('2026-09-13T12:00:00.000Z');
			service.persistedLastSweepAt = cachedDate;
			service.persistedPendingCount = 7;
			service.inMemoryStore.set('corr-sync-local_telegram', {
				status: 'pending',
				expiresAt: new Date(Date.now() + 60000),
			});
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({
								lastSweepAt: cachedDate.toISOString(),
								pendingCount: 7,
							}),
						})),
						set: jest.fn().mockResolvedValue(undefined),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			await service.markTerminal('corr-sync-local_telegram', 'cancelled');
			expect(service.persistedPendingCount).toBe(6);

			const synced = await service.syncWorkerTelemetry();

			expect(synced).toBe(true);
			expect(service.persistedPendingCount).toBe(6);
		});

		it('reports durable queue pending count from worker heartbeat in status and counts unexpired durable records', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';

			// Verify getStatus uses persistedPendingCount when role is worker
			service.persistedPendingCount = 7;
			const status = service.getStatus();
			expect(status.pendingCount).toBe(7);

			// Verify countDurablePendingRecords queries firestore and counts unexpired records
			const unexpiredDate = new Date(Date.now() + 60000).toISOString();
			const expiredDate = new Date(Date.now() - 60000).toISOString();
			const mockFirestore = {
				collection: jest.fn((colName) => {
					if (colName === 'notificationDeadLetters') {
						return {
							where: jest.fn(() => ({
								get: jest.fn(async () => ({
									empty: false,
									docs: [
										{ data: () => ({ status: 'pending', expiresAt: unexpiredDate }) },
										{ data: () => ({ status: 'in_flight', expiresAt: unexpiredDate }) },
										{ data: () => ({ status: 'pending', expiresAt: expiredDate }) }, // expired, excluded
									],
								})),
							})),
						};
					}
					return {};
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const durableCount = await service.countDurablePendingRecords();
			expect(durableCount).toBe(2);
		});

		it('uses Firestore count aggregation for durable pending depth when available', async () => {
			const aggregate = {
				get: jest.fn(async () => ({ data: () => ({ count: 7 }) })),
			};
			const query = {
				count: jest.fn(() => aggregate),
				get: jest.fn(async () => ({ empty: false, docs: [] })),
			};
			const mockFirestore = {
				collection: jest.fn(() => ({
					where: jest.fn(() => query),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const durableCount = await service.countDurablePendingRecords();

			expect(durableCount).toBe(7);
			expect(query.count).toHaveBeenCalledTimes(1);
			expect(aggregate.get).toHaveBeenCalledTimes(1);
			expect(query.get).not.toHaveBeenCalled();
		});

		it('filters expired records before durable pending aggregation', async () => {
			const aggregate = {
				get: jest.fn(async () => ({ data: () => ({ count: 2 }) })),
			};
			const expiryAwareQuery = {
				count: jest.fn(() => aggregate),
			};
			const statusQuery = {
				where: jest.fn(() => expiryAwareQuery),
			};
			const mockFirestore = {
				collection: jest.fn(() => ({
					where: jest.fn(() => statusQuery),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const durableCount = await service.countDurablePendingRecords();

			expect(durableCount).toBe(2);
			expect(statusQuery.where).toHaveBeenCalledWith('expiresAt', '>', expect.anything());
			expect(expiryAwareQuery.count).toHaveBeenCalledTimes(1);
			expect(aggregate.get).toHaveBeenCalledTimes(1);
		});

		it('preserves cumulative counters across worker restarts and merges with persisted heartbeat totals', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';

			let persistedHeartbeat = {
				deliveredCount: 25,
				exhaustedCount: 10,
				zeroChannelBroadcasts: 5,
				lastSweepAt: new Date(Date.now() - 60000).toISOString(),
			};

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						get: jest.fn(async () => ({
							exists: true,
							data: () => persistedHeartbeat,
						})),
					})),
					where: jest.fn(() => ({
						get: jest.fn(async () => ({ empty: true, docs: [] })),
					})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: true,
							data: () => persistedHeartbeat,
						})),
						set: jest.fn((docRef, payload, options) => {
							persistedHeartbeat = options?.merge
								? { ...persistedHeartbeat, ...payload }
								: { ...payload };
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// Seed counters from existing heartbeat on worker startup
			await service.seedCountersFromHeartbeat();
			expect(service.totalDeliveredCount).toBe(25);
			expect(service.totalExhaustedCount).toBe(10);
			expect(service.totalZeroChannelBroadcasts).toBe(5);

			// Worker performs sweep and delivers 2 more items
			service.totalDeliveredCount += 2;
			service.lastSweepAt = new Date();

			await service.persistWorkerTelemetry({ timeoutMs: 100 });
			expect(persistedHeartbeat.deliveredCount).toBe(27);
			expect(persistedHeartbeat.exhaustedCount).toBe(10);
			expect(persistedHeartbeat.zeroChannelBroadcasts).toBe(5);
			expect(service.totalDeliveredCount).toBe(27);
		});

		it('keeps timed-out Firestore reads single-flight until settled', async () => {
			let readCount = 0;
			let resolveSlowRead;
			const slowRead = new Promise((resolve) => {
				resolveSlowRead = resolve;
			});

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						get: jest.fn(() => {
							readCount += 1;
							return slowRead;
						}),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// First read times out after 20ms
			const firstResult = await service.syncWorkerTelemetry({ timeoutMs: 20 });
			expect(firstResult).toBe(false);
			expect(readCount).toBe(1);

			// Second read while first is still pending should NOT start a new Firestore read
			const secondResult = await service.syncWorkerTelemetry({ timeoutMs: 20 });
			expect(secondResult).toBe(false);
			expect(readCount).toBe(1);

			// Now resolve the slow read
			resolveSlowRead({
				exists: true,
				data: () => ({
					lastSweepAt: new Date().toISOString(),
					lastRunDurationMs: 1234,
				}),
			});

			// Wait for the active promise to settle
			await service._activeTelemetryReadPromise;
			expect(service._activeTelemetryReadPromise).toBeNull();
		});

		it('preserves pending depth fallback when durable query times out', async () => {
			let resolveSlowQuery;
			const slowQuery = new Promise((resolve) => {
				resolveSlowQuery = resolve;
			});

			const mockFirestore = {
				collection: jest.fn(() => ({
					where: jest.fn(() => ({
						get: jest.fn(() => slowQuery),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// Seed known fallback pending count
			service.persistedPendingCount = 9;

			// Advance time or trigger timeout in countDurablePendingRecords
			const fallbackCount = await service.countDurablePendingRecords();
			expect(fallbackCount).toBe(9);

			// Now resolve query with genuinely empty snapshot
			resolveSlowQuery({
				empty: true,
				docs: [],
			});

			// Next call with fast empty response should update count to 0
			mockFirestore.collection.mockReturnValueOnce({
				where: jest.fn(() => ({
					get: jest.fn(async () => ({ empty: true, docs: [] })),
				})),
			});
			const emptyCount = await service.countDurablePendingRecords();
			expect(emptyCount).toBe(0);
			expect(service.persistedPendingCount).toBe(0);
		});

		it('treats heartbeat transaction timeouts as failures', async () => {
			let transactionAttempts = 0;
			let resolveSlowTx;
			const slowTx = new Promise((resolve) => {
				resolveSlowTx = resolve;
			});

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({})),
					where: jest.fn(() => ({
						get: jest.fn(async () => ({ empty: true, docs: [] })),
					})),
				})),
				runTransaction: jest.fn(() => {
					transactionAttempts += 1;
					return slowTx;
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// Write times out after 20ms
			const writeResult = await service.persistWorkerTelemetry({ timeoutMs: 20 });
			expect(writeResult).toBe(false);
			expect(transactionAttempts).toBe(1);

			// Clean up pending transaction
			resolveSlowTx();
		});

		it('does not leak unhandled rejection when tracked write operation rejects after timing out', async () => {
			let rejectTx;
			const delayedTx = new Promise((_, reject) => {
				rejectTx = reject;
			});

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({})),
				})),
				runTransaction: jest.fn(() => delayedTx),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const result = await service.persistWorkerTelemetry({ timeoutMs: 15 });
			expect(result).toBe(false);

			// Now trigger late rejection in background
			expect(() => {
				rejectTx(new Error('Transaction aborted by Firestore'));
			}).not.toThrow();

			// Wait a tick for microtasks so any unhandled rejection would surface
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(service._activeTelemetryWriteOperation).toBeNull();
		});

		it('keeps pending-count queries single-flight when first query times out', async () => {
			let resolveSlowQuery;
			let queryCount = 0;
			const slowQuery = new Promise((resolve) => {
				resolveSlowQuery = resolve;
			});

			const mockFirestore = {
				collection: jest.fn(() => ({
					where: jest.fn(() => ({
						get: jest.fn(() => {
							queryCount += 1;
							return slowQuery;
						}),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);
			service.persistedPendingCount = 5;

			// First call times out and returns fallback
			const first = await service.countDurablePendingRecords();
			expect(first).toBe(5);
			expect(queryCount).toBe(1);

			// Second call while first query is still running does NOT spawn another query
			const second = await service.countDurablePendingRecords();
			expect(second).toBe(5);
			expect(queryCount).toBe(1);

			// Resolve original query
			resolveSlowQuery({
				empty: false,
				docs: [{ data: () => ({ expiresAt: Date.now() + 60000 }) }],
			});

			// Await single-flight promise settling
			await service._activePendingCountPromise;
			expect(service.persistedPendingCount).toBe(1);
			expect(service._activePendingCountPromise).toBeNull();
		});

		it('merges session delivery and exhaustion counters atomically into existing heartbeat counters', async () => {
			let committedPayload = null;
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({
								deliveredCount: 10,
								exhaustedCount: 5,
								zeroChannelBroadcasts: 2,
								lastSweepAt: new Date(Date.now() - 10000).toISOString(),
							}),
						})),
						set: jest.fn((docRef, payload) => {
							committedPayload = payload;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// Simulate worker delivered 3 alerts and exhausted 1 without having pre-seeded
			service.totalDeliveredCount = 3;
			service._sessionDeliveredDelta = 3;
			service.totalExhaustedCount = 1;
			service._sessionExhaustedDelta = 1;

			const success = await service.persistWorkerTelemetry({ timeoutMs: 100 });
			expect(success).toBe(true);
			expect(committedPayload).not.toBeNull();
			// 10 existing + 3 session delta = 13 delivered
			expect(committedPayload.deliveredCount).toBe(13);
			// 5 existing + 1 session delta = 6 exhausted
			expect(committedPayload.exhaustedCount).toBe(6);
			// Service counters updated to reflect merged totals
			expect(service.totalDeliveredCount).toBe(13);
			expect(service.totalExhaustedCount).toBe(6);
			expect(service._sessionDeliveredDelta).toBe(0);
			expect(service._sessionExhaustedDelta).toBe(0);
		});

		it('normalizes Firestore Timestamp objects and non-string timestamps in getStatus and telemetry sync', async () => {
			const sweepTimestamp = {
				toDate: () => new Date(1700000000000),
				toMillis: () => 1700000000000,
			};
			const runTimestamp = {
				_seconds: 1700000050,
				_nanoseconds: 0,
			};

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({
								lastSweepAt: sweepTimestamp,
								lastRunAt: runTimestamp,
								deliveredCount: 42,
							}),
						})),
					})),
				})),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const synced = await service.syncWorkerTelemetry({ timeoutMs: 100 });
			expect(synced).toBe(true);

			const status = service.getStatus();
			expect(status.lastSweepAt).toBe(new Date(1700000000000).toISOString());
			expect(status.lastRunAt).toBe(new Date(1700000050000).toISOString());
			expect(status.deliveredCount).toBe(42);
		});

		it('keeps timed-out heartbeat writes single-flight and does not start concurrent write while operation is active', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let activeOperations = 0;
			let maxConcurrentOperations = 0;
			let resolveFirstTx;

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({})),
				})),
				runTransaction: jest.fn((updateFn) => {
					activeOperations++;
					maxConcurrentOperations = Math.max(maxConcurrentOperations, activeOperations);
					return new Promise((resolve) => {
						resolveFirstTx = () => {
							activeOperations--;
							resolve();
						};
					});
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			// First write times out in 20ms
			const firstWritePromise = service.persistWorkerTelemetry({ timeoutMs: 20 });
			const firstResult = await firstWritePromise;
			expect(firstResult).toBe(false);
			expect(service._activeTelemetryWriteOperation).not.toBeNull();

			// Second write while first transaction is still pending in Firestore
			const secondResult = await service.persistWorkerTelemetry({ waitTimeoutMs: 20, timeoutMs: 20 });
			// Second write must not have started a second concurrent transaction!
			expect(secondResult).toBe(false);
			expect(maxConcurrentOperations).toBe(1);

			// Resolve the hanging first transaction
			resolveFirstTx();
			await service._activeTelemetryWriteOperation;
			expect(service._activeTelemetryWriteOperation).toBeNull();
		});

		it('persists delta counters without overwriting newer sweep metadata when older heartbeat loses to newer sweep', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let persistedDeltaPayload = null;

			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({
								lastSweepAt: '2026-09-13T12:00:00.000Z',
								deliveredCount: 10,
								exhaustedCount: 5,
								zeroChannelBroadcasts: 2,
							}),
						})),
						set: jest.fn((docRef, payload, options) => {
							persistedDeltaPayload = payload;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			service.lastSweepAt = '2026-09-13T11:59:00.000Z';
			service._sessionDeliveredDelta = 3;
			service._sessionExhaustedDelta = 1;

			const success = await service.persistWorkerTelemetry({ timeoutMs: 100 });
			expect(success).toBe(true);
			expect(persistedDeltaPayload).toEqual({
					deliveredCount: 13,
				exhaustedCount: 6,
			});
			expect(persistedDeltaPayload.lastSweepAt).toBeUndefined();
			expect(service._sessionDeliveredDelta).toBe(0);
			expect(service._sessionExhaustedDelta).toBe(0);
		});

		it('does not replay a zero-channel increment through heartbeat telemetry', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			const heartbeat = { zeroChannelBroadcasts: 1 };
			let persistedPayload = null;
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({})),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: true,
							data: () => heartbeat,
						})),
						set: jest.fn((docRef, payload) => {
							persistedPayload = payload;
							Object.assign(heartbeat, payload);
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);
			jest.spyOn(service, 'countDurablePendingRecords').mockResolvedValue(0);

			// The point-increment write already committed this event; telemetry must not add it again.
			service.totalZeroChannelBroadcasts = 1;
			service._sessionZeroChannelDelta = 1;

			await service.persistWorkerTelemetry({ timeoutMs: 100 });

			expect(heartbeat.zeroChannelBroadcasts).toBe(1);
			expect(persistedPayload?.zeroChannelBroadcasts).not.toBe(2);
		});

		it('persists zero-channel increments from web processes to Firestore and reflects across replicas in getStatus', async () => {
			process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
			let persistedPayload = null;

			const mockDocRef = {
				set: jest.fn(async (payload) => {
					persistedPayload = payload;
				}),
			};
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => mockDocRef),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					const mockTx = {
						get: jest.fn(async () => ({
							exists: true,
							data: () => ({ zeroChannelBroadcasts: 4 }),
						})),
						set: jest.fn((docRef, payload) => {
							persistedPayload = payload;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			await service.incrementZeroChannelBroadcasts();
			expect(mockFirestore.runTransaction).toHaveBeenCalled();
			expect(persistedPayload).toEqual({ zeroChannelBroadcasts: 5 });
			expect(service.getZeroChannelBroadcastsCount()).toBe(1);

			// In a web replica where persisted count was synced from Firestore
			service.totalZeroChannelBroadcasts = 0;
			service.persistedZeroChannelBroadcasts = 5;
			const status = service.getStatus();
			expect(status.zeroChannelBroadcasts).toBe(5);
		});

		it('serializes fallback zero-channel increments to avoid lost updates', async () => {
			let activeTransactions = 0;
			let maxActiveTransactions = 0;
			let persistedCount = 0;
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ id: 'notification-redrive' })),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					activeTransactions += 1;
					maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
					await new Promise((resolve) => setImmediate(resolve));
					const mockTx = {
						get: jest.fn(async () => ({
							exists: persistedCount > 0,
							data: () => ({ zeroChannelBroadcasts: persistedCount }),
						})),
						set: jest.fn((docRef, payload) => {
							persistedCount = payload.zeroChannelBroadcasts;
						}),
					};
					await updateFn(mockTx);
					activeTransactions -= 1;
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			await Promise.all([
				service.incrementZeroChannelBroadcasts(),
				service.incrementZeroChannelBroadcasts(),
			]);

			expect(maxActiveTransactions).toBe(1);
			expect(persistedCount).toBe(2);
		});

		it('coalesces zero-channel increments while a durable write is pending', async () => {
			let transactionCalls = 0;
			let persistedCount = 0;
			let releaseFirstTransaction;
			const firstTransaction = new Promise((resolve) => {
				releaseFirstTransaction = resolve;
			});
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ id: 'notification-redrive' })),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					transactionCalls += 1;
					if (transactionCalls === 1) await firstTransaction;
					const mockTx = {
						get: jest.fn(async () => ({
							exists: persistedCount > 0,
							data: () => ({ zeroChannelBroadcasts: persistedCount }),
						})),
						set: jest.fn((docRef, payload) => {
							persistedCount = payload.zeroChannelBroadcasts;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			const firstWrite = service.incrementZeroChannelBroadcasts();
			await new Promise((resolve) => setImmediate(resolve));
			for (let index = 0; index < 100; index += 1) {
				service.incrementZeroChannelBroadcasts();
			}

			expect(transactionCalls).toBe(1);

			releaseFirstTransaction();
			await firstWrite;
			if (service._activeZeroChannelWritePromise) {
				await service._activeZeroChannelWritePromise;
			}

			expect(transactionCalls).toBe(2);
			expect(persistedCount).toBe(101);
		});

		it('retries failed zero-channel persistence without another event', async () => {
			jest.useFakeTimers();
			let transactionCalls = 0;
			let persistedCount = 0;
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ id: 'notification-redrive' })),
				})),
					runTransaction: jest.fn(async (updateFn) => {
					transactionCalls += 1;
					if (transactionCalls === 1) {
						const error = new Error('validation rejected before commit');
						error.code = 'failed-precondition';
						throw error;
					}
					const mockTx = {
						get: jest.fn(async () => ({
							exists: persistedCount > 0,
							data: () => ({ zeroChannelBroadcasts: persistedCount }),
						})),
						set: jest.fn((docRef, payload) => {
							persistedCount = payload.zeroChannelBroadcasts;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			await service.incrementZeroChannelBroadcasts();
			expect(transactionCalls).toBe(1);

			await jest.advanceTimersByTimeAsync(5000);
			if (service._activeZeroChannelWritePromise) {
				await service._activeZeroChannelWritePromise;
			}

			expect(transactionCalls).toBe(2);
			expect(persistedCount).toBe(1);
			jest.useRealTimers();
		});

		it('does not retry ambiguous zero-channel persistence failures', async () => {
			jest.useFakeTimers();
			let transactionCalls = 0;
			let persistedCount = 0;
			const mockFirestore = {
				collection: jest.fn(() => ({
					doc: jest.fn(() => ({ id: 'notification-redrive' })),
				})),
				runTransaction: jest.fn(async (updateFn) => {
					transactionCalls += 1;
					if (transactionCalls === 1) {
						const error = new Error('ambiguous transport failure');
						error.code = 'unavailable';
						throw error;
					}
					const mockTx = {
						get: jest.fn(async () => ({
							exists: persistedCount > 0,
							data: () => ({ zeroChannelBroadcasts: persistedCount }),
						})),
						set: jest.fn((docRef, payload) => {
							persistedCount = payload.zeroChannelBroadcasts;
						}),
					};
					await updateFn(mockTx);
				}),
			};
			jest.spyOn(service, 'getFirestore').mockReturnValue(mockFirestore);

			await service.incrementZeroChannelBroadcasts();
			await jest.advanceTimersByTimeAsync(20000);

			expect(transactionCalls).toBe(1);
			expect(service._pendingZeroChannelWriteDelta).toBe(0);

			await service.incrementZeroChannelBroadcasts();
			expect(transactionCalls).toBe(2);
			expect(persistedCount).toBe(1);
			jest.useRealTimers();
		});
	});

	describe('helpers', () => {
		it('calculates exponential backoff with jitter bounded', () => {
			const b0 = calculateBackoffMs(0);
			expect(b0).toBeGreaterThanOrEqual(30000);
			expect(b0).toBeLessThan(35000);

			const b10 = calculateBackoffMs(10);
			expect(b10).toBeGreaterThanOrEqual(600000);
			expect(b10).toBeLessThan(605000);
		});

		it('deeply strips undefined fields from nested objects and arrays', () => {
			const obj = {
				a: 1,
				b: undefined,
				c: {
					d: undefined,
					e: [1, undefined, 2, { f: undefined, g: 'ok' }],
				},
			};
			const cleaned = stripUndefinedFieldsDeep(obj);
			expect(cleaned).toEqual({
				a: 1,
				c: {
					e: [1, 2, { g: 'ok' }],
				},
			});
		});
	});
});
