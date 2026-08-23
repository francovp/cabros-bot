const { NotificationRedriveService, notificationRedriveService, calculateBackoffMs, stripUndefinedFieldsDeep } = require('../../src/services/notification/NotificationRedriveService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

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
	});

	describe('sweep and redrive', () => {
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
			await service.recordDeliveryResults(alert, [{ channel: 'telegram', success: false, error: 'Init fail' }]);

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
});
