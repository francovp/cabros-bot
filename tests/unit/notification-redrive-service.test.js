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
				lastRunDurationMs: null,
				lastRunScannedCount: 0,
				lastRunRedrivenCount: 0,
				lastRunErrorCount: 0,
			});
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

	describe('chunk resume', () => {
		it('persists chunk metadata on the dead-letter record when the failed delivery is chunked', async () => {
			const alert = { text: 'Chunked alert', correlationId: 'corr-chunk-1' };
			const results = [
				{
					channel: 'whatsapp',
					success: false,
					error: 'Mid-sequence chunk failed',
					statusCode: 502,
					messageIds: ['msg-a', 'msg-b'],
					messageCount: 2,
					splitMessageCount: 5,
					failedPart: 3,
				},
			];

			await service.recordDeliveryResults(alert, results);

			const stored = service.inMemoryStore.get('corr-chunk-1_whatsapp');
			expect(stored.chunkResume).toEqual({
				splitMessageCount: 5,
				failedPart: 3,
				messageCount: 2,
				resumeFromChunk: 2,
				deliveredMessageIds: ['msg-a', 'msg-b'],
			});
		});

		it('omits chunk metadata when the failed delivery is not chunked', async () => {
			const alert = { text: 'Single alert', correlationId: 'corr-single' };
			const results = [
				{ channel: 'whatsapp', success: false, error: 'Single chunk failed', statusCode: 500 },
			];

			await service.recordDeliveryResults(alert, results);

			const stored = service.inMemoryStore.get('corr-single_whatsapp');
			expect(stored.chunkResume).toBeNull();
		});

		it('passes startChunk = failedPart - 1 to the channel service on redrive', async () => {
			const whatsappSend = jest.fn().mockResolvedValue({
				success: true,
				channel: 'whatsapp',
				messageIds: ['msg-c', 'msg-d', 'msg-e'],
				messageCount: 3,
				splitMessageCount: 5,
			});
			const notificationManager = {
				channels: new Map([['whatsapp', { name: 'whatsapp', send: whatsappSend, isEnabled: () => true }]]),
				sendToChannels: jest.fn(async (payload, channels, opts) => [{
					channel: channels[0],
					...(await whatsappSend(payload, opts)),
				}]),
			};
			service.setNotificationManagerGetter(() => notificationManager);

			await service.recordDeliveryResults(
				{ text: 'Chunked', correlationId: 'corr-resume' },
				[{
					channel: 'whatsapp',
					success: false,
					error: 'Part 3 failed',
					statusCode: 502,
					messageIds: ['msg-a', 'msg-b'],
					messageCount: 2,
					splitMessageCount: 5,
					failedPart: 3,
				}],
			);

			const item = service.inMemoryStore.get('corr-resume_whatsapp');
			item.nextAttemptAt = Date.now() - 1000;
			await service.sweep();

			expect(whatsappSend).toHaveBeenCalledTimes(1);
			expect(whatsappSend.mock.calls[0][1]).toMatchObject({ startChunk: 2, isRedrive: true });
		});

		it('advances the resume point after a later redrive chunk fails', async () => {
			const whatsappSend = jest.fn()
				.mockResolvedValueOnce({
					success: false,
					channel: 'whatsapp',
					error: 'Part 4 failed',
					statusCode: 502,
					messageIds: ['msg-c'],
					messageCount: 1,
					splitMessageCount: 5,
					failedPart: 4,
				})
				.mockResolvedValueOnce({
					success: true,
					channel: 'whatsapp',
					messageIds: ['msg-d', 'msg-e'],
					messageCount: 2,
					splitMessageCount: 5,
				});
			const notificationManager = {
				channels: new Map([['whatsapp', { name: 'whatsapp', send: whatsappSend, isEnabled: () => true }]]),
				sendToChannels: jest.fn(async (payload, channels, opts) => [{
					channel: channels[0],
					...(await whatsappSend(payload, opts)),
				}]),
			};
			service.setNotificationManagerGetter(() => notificationManager);

			await service.recordDeliveryResults(
				{ text: 'Chunked', correlationId: 'corr-resume-progress' },
				[{
					channel: 'whatsapp',
					success: false,
					error: 'Part 3 failed',
					statusCode: 502,
					messageIds: ['msg-a', 'msg-b'],
					messageCount: 2,
					splitMessageCount: 5,
					failedPart: 3,
				}],
			);

			service.inMemoryStore.get('corr-resume-progress_whatsapp').nextAttemptAt = Date.now() - 1000;
			await service.sweep();
			service.inMemoryStore.get('corr-resume-progress_whatsapp').nextAttemptAt = Date.now() - 1000;
			await service.sweep();

			expect(whatsappSend.mock.calls).toHaveLength(2);
			expect(whatsappSend.mock.calls[0][1]).toMatchObject({ startChunk: 2, isRedrive: true });
			expect(whatsappSend.mock.calls[1][1]).toMatchObject({ startChunk: 3, isRedrive: true });
		});

		it('does not pass startChunk on legacy dead-letter records without chunk metadata', async () => {
			const whatsappSend = jest.fn().mockResolvedValue({
				success: true,
				channel: 'whatsapp',
				messageIds: ['msg-z'],
				messageCount: 1,
			});
			const notificationManager = {
				channels: new Map([['whatsapp', { name: 'whatsapp', send: whatsappSend, isEnabled: () => true }]]),
				sendToChannels: jest.fn(async (payload, channels, opts) => [{
					channel: channels[0],
					...(await whatsappSend(payload, opts)),
				}]),
			};
			service.setNotificationManagerGetter(() => notificationManager);

			// Inject a legacy record directly (no chunkResume)
			const nowMs = Date.now();
			mockDocs.set('legacy_whatsapp', {
				id: 'legacy_whatsapp',
				alertId: 'legacy',
				channel: 'whatsapp',
				status: 'pending',
				alert: { text: 'Legacy alert' },
				attemptCount: 0,
				lastError: 'Legacy failure',
				createdAt: { toDate: () => new Date(nowMs - 60000) },
				updatedAt: { toDate: () => new Date(nowMs - 60000) },
				nextAttemptAt: { toDate: () => new Date(nowMs - 1000) },
				expiresAt: { toDate: () => new Date(nowMs + 600000) },
				claimedAt: null,
				leaseUntil: null,
				workerId: null,
				terminalAt: null,
				deliveredAt: null,
			});
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);

			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				await service.sweep();
				expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Legacy dead-letter legacy_whatsapp'));
			} finally {
				warnSpy.mockRestore();
			}

			expect(whatsappSend).toHaveBeenCalledTimes(1);
			expect(whatsappSend.mock.calls[0][1]).not.toHaveProperty('startChunk');
			expect(whatsappSend.mock.calls[0][1].isRedrive).toBe(true);
		});

		it('skips startChunk for non-chunkable channels like telegram', async () => {
			const telegramSend = jest.fn().mockResolvedValue({
				success: true,
				channel: 'telegram',
				messageId: 'msg-x',
			});
			const notificationManager = {
				channels: new Map([['telegram', { name: 'telegram', send: telegramSend, isEnabled: () => true }]]),
				sendToChannels: jest.fn(async (payload, channels, opts) => [{
					channel: channels[0],
					...(await telegramSend(payload, opts)),
				}]),
			};
			service.setNotificationManagerGetter(() => notificationManager);

			await service.recordDeliveryResults(
				{ text: 'Telegram', correlationId: 'corr-tg' },
				[{
					channel: 'telegram',
					success: false,
					error: 'Network',
					// Even if a chunk-like payload is supplied, telegram is single-shot
					splitMessageCount: 1,
					failedPart: 1,
				}],
			);

			const item = service.inMemoryStore.get('corr-tg_telegram');
			item.nextAttemptAt = Date.now() - 1000;
			await service.sweep();

			expect(telegramSend).toHaveBeenCalledTimes(1);
			expect(telegramSend.mock.calls[0][1]).not.toHaveProperty('startChunk');
		});

		it('records a delivered dead-letter after a chunk-resume redrive succeeds', async () => {
			const whatsappSend = jest.fn().mockResolvedValue({
				success: true,
				channel: 'whatsapp',
				messageIds: ['msg-c', 'msg-d', 'msg-e'],
				messageCount: 3,
				splitMessageCount: 5,
			});
			const notificationManager = {
				channels: new Map([['whatsapp', { name: 'whatsapp', send: whatsappSend, isEnabled: () => true }]]),
				sendToChannels: jest.fn(async (payload, channels, opts) => [{
					channel: channels[0],
					...(await whatsappSend(payload, opts)),
				}]),
			};
			service.setNotificationManagerGetter(() => notificationManager);

			await service.recordDeliveryResults(
				{ text: 'Chunked', correlationId: 'corr-resume-ok' },
				[{
					channel: 'whatsapp',
					success: false,
					error: 'Part 3 failed',
					statusCode: 502,
					messageIds: ['msg-a', 'msg-b'],
					messageCount: 2,
					splitMessageCount: 5,
					failedPart: 3,
				}],
			);

			const item = service.inMemoryStore.get('corr-resume-ok_whatsapp');
			item.nextAttemptAt = Date.now() - 1000;
			await service.sweep();

			const finalState = service.inMemoryStore.get('corr-resume-ok_whatsapp');
			expect(finalState.status).toBe('delivered');
			expect(whatsappSend.mock.calls[0][1].startChunk).toBe(2);
		});
	});
});
