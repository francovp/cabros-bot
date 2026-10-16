'use strict';

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const {
	UserPriceAlertService,
	userPriceAlertService,
	parseUserPriceAlertInput,
	UserPriceAlertError,
} = require('../../src/services/alerts/UserPriceAlertService');
const fetchPriceModule = require('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol');

describe('UserPriceAlertService - Unit Tests', () => {
	let service;
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_USER_PRICE_ALERTS = 'true';
		process.env.USER_PRICE_ALERT_WORKER_ROLE = 'web';
		process.env.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS = '60000';
		process.env.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT = '50';
		process.env.USER_PRICE_ALERT_MAX_PER_CHAT = '5';

		service = new UserPriceAlertService();
		service._resetForTesting();
	});

	afterEach(async () => {
		if (service) {
			await service.stopWorker({ drain: false });
		}
		process.env = savedEnv;
		jest.restoreAllMocks();
	});

	describe('Input Parsing & Operator Normalization', () => {
		it('normalizes valid operators through the parser', () => {
			const cases = [
				['<', '<'], ['<=', '<='], ['>', '>'], ['>=', '>='],
				['menor', '<'], ['mayor', '>'], ['debajo', '<'], ['encima', '>'],
			];
			for (const [input, expected] of cases) {
				const parsed = parseUserPriceAlertInput(['BTCUSDT', input, '60000']);
				expect(parsed.valid).toBe(true);
				expect(parsed.operator).toBe(expected);
			}
			// Unrecognized verbs must not be silently accepted as an operator.
			expect(parseUserPriceAlertInput(['BTCUSDT', 'invalid', '60000']).valid).toBe(false);
		});

		it('parses separated args: SYMBOL OPERATOR PRICE', () => {
			const parsed = parseUserPriceAlertInput(['BTCUSDT', '<', '60000']);
			expect(parsed.valid).toBe(true);
			expect(parsed.rawSymbol).toBe('BTCUSDT');
			expect(parsed.operator).toBe('<');
			expect(parsed.targetPrice).toBe(60000);
		});

		it('parses combined operator and price: SYMBOL <60000', () => {
			const parsed = parseUserPriceAlertInput(['BTCUSDT', '<60000']);
			expect(parsed.valid).toBe(true);
			expect(parsed.rawSymbol).toBe('BTCUSDT');
			expect(parsed.operator).toBe('<');
			expect(parsed.targetPrice).toBe(60000);
		});

		it('parses implicit operator when current price is provided', () => {
			// When target price is lower than current price, default to '<'
			const parsedLower = parseUserPriceAlertInput(['BTCUSDT', '55000'], { currentPrice: 60000 });
			expect(parsedLower.valid).toBe(true);
			expect(parsedLower.operator).toBe('<');
			expect(parsedLower.targetPrice).toBe(55000);

			// When target price is higher than current price, default to '>'
			const parsedHigher = parseUserPriceAlertInput(['BTCUSDT', '65000'], { currentPrice: 60000 });
			expect(parsedHigher.valid).toBe(true);
			expect(parsedHigher.operator).toBe('>');
			expect(parsedHigher.targetPrice).toBe(65000);
		});

		it('handles formatted numbers with commas (e.g. 60,000.50 or 60.000,50)', () => {
			const parsed1 = parseUserPriceAlertInput(['BTCUSDT', '<', '60,000.50']);
			expect(parsed1.valid).toBe(true);
			expect(parsed1.targetPrice).toBe(60000.5);

			const parsed2 = parseUserPriceAlertInput(['ETHUSDT', '>', '3,500']);
			expect(parsed2.valid).toBe(true);
			expect(parsed2.targetPrice).toBe(3500);
		});

		it('rejects invalid prices or missing symbols', () => {
			expect(parseUserPriceAlertInput([]).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT']).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT', '<', 'not-a-number']).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT', '<', '-100']).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT', '<', '0']).valid).toBe(false);
		});
	});

	describe('Alert Creation & Scoping', () => {
		it('creates an active armed alert in memory when Firestore is not configured', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: '12345',
				telegramThreadId: 10,
				symbol: 'BTCUSDT',
				rawSymbol: 'BINANCE:BTCUSDT',
				exchange: 'BINANCE',
				assetClass: 'crypto',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			expect(alert).toBeDefined();
			expect(alert.id).toBeDefined();
			expect(alert.chatId).toBe('12345');
			expect(alert.telegramThreadId).toBe(10);
			expect(alert.symbol).toBe('BTCUSDT');
			expect(alert.operator).toBe('<');
			expect(alert.targetPrice).toBe(60000);
			expect(alert.initialPrice).toBe(64000);
			expect(alert.status).toBe('armed');
			expect(alert.createdAt).toBeDefined();

			const list = await service.listAlerts({ chatId: '12345' });
			expect(list.length).toBe(1);
			expect(list[0].id).toBe(alert.id);
		});

		it('enforces per-chat active alert quota', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);
			process.env.USER_PRICE_ALERT_MAX_PER_CHAT = '2';

			await service.createAlert({
				chatId: 'chat-quota',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});
			await service.createAlert({
				chatId: 'chat-quota',
				symbol: 'ETHUSDT',
				operator: '>',
				targetPrice: 3500,
				initialPrice: 3000,
			});

			await expect(
				service.createAlert({
					chatId: 'chat-quota',
					symbol: 'SOLUSDT',
					operator: '>',
					targetPrice: 200,
					initialPrice: 150,
				}),
			).rejects.toThrow(/Límite de alertas activas alcanzado/i);
		});

		it('allows a new alert once the quota is raised above the active count', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);
			process.env.USER_PRICE_ALERT_MAX_PER_CHAT = '2';

			await service.createAlert({ chatId: 'chat-quota2', symbol: 'BTCUSDT', operator: '<', targetPrice: 60000 });
			await service.createAlert({ chatId: 'chat-quota2', symbol: 'ETHUSDT', operator: '>', targetPrice: 3500 });
			await expect(
				service.createAlert({ chatId: 'chat-quota2', symbol: 'SOLUSDT', operator: '>', targetPrice: 200 }),
			).rejects.toThrow(/Límite de alertas activas alcanzado/i);

			// Pin the bound to the configured value rather than the default of 20.
			process.env.USER_PRICE_ALERT_MAX_PER_CHAT = '3';
			await expect(
				service.createAlert({ chatId: 'chat-quota2', symbol: 'SOLUSDT', operator: '>', targetPrice: 200 }),
			).resolves.toMatchObject({ status: 'armed' });
		});

		it('allows cancelling an existing alert', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: 'chat-cancel',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			const cancelled = await service.cancelAlert({
				chatId: 'chat-cancel',
				alertId: alert.id,
			});

			expect(cancelled.status).toBe('cancelled');
			expect(cancelled.cancelledAt).toBeDefined();

			const activeList = await service.listAlerts({ chatId: 'chat-cancel', status: 'armed' });
			expect(activeList.length).toBe(0);
		});

		it('rejects cancelling an alert belonging to a different chat', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: 'chat-owner',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			await expect(
				service.cancelAlert({
					chatId: 'other-chat',
					alertId: alert.id,
				}),
			).rejects.toThrow(/No se encontró una alerta activa con ese ID/i);
		});
	});

	describe('Evaluation Loop & Notification Triggering', () => {
		it('evaluates armed alerts and triggers notifications when threshold is crossed', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const mockBot = {
				telegram: {
					sendMessage: jest.fn().mockResolvedValue({ message_id: 99 }),
				},
			};
			service.setBotGetter(() => mockBot);

			// Alert 1: BTCUSDT < 60000 (Crossed if price is 59000)
			await service.createAlert({
				chatId: 'chat-eval-1',
				telegramThreadId: 5,
				symbol: 'BTCUSDT',
				rawSymbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			// Alert 2: ETHUSDT > 3500 (Not crossed if price is 3200)
			await service.createAlert({
				chatId: 'chat-eval-2',
				symbol: 'ETHUSDT',
				rawSymbol: 'ETHUSDT',
				operator: '>',
				targetPrice: 3500,
				initialPrice: 3000,
			});

			// Mock price resolver
			const mockPrices = {
				BTCUSDT: { symbol: 'BTCUSDT', price: 59000, assetClass: 'crypto' },
				ETHUSDT: { symbol: 'ETHUSDT', price: 3200, assetClass: 'crypto' },
			};
			jest.spyOn(service, '_fetchCurrentPrice').mockImplementation(async (item) => {
				return mockPrices[item.symbol] || { symbol: item.symbol, price: 100 };
			});

			const results = await service.evaluateAlerts();

			expect(results.evaluatedCount).toBe(2);
			expect(results.triggeredCount).toBe(1);
			expect(results.errorsCount).toBe(0);

			// Check that mockBot sent message for BTCUSDT
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
			const [chatId, text, options] = mockBot.telegram.sendMessage.mock.calls[0];
			expect(chatId).toBe('chat-eval-1');
			expect(text).toContain('BTCUSDT');
			expect(text).toContain('59');
			expect(options.message_thread_id).toBe(5);
			expect(options.parse_mode).toBe('MarkdownV2');

			// Verify status updated to triggered
			const activeList = await service.listAlerts({ chatId: 'chat-eval-1', status: 'armed' });
			expect(activeList.length).toBe(0);
		});

		it('marks expired alerts without sending notifications', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: 'chat-expired',
				symbol: 'SOLUSDT',
				operator: '>',
				targetPrice: 200,
				initialPrice: 150,
			});

			// Manually age alert expiresAt to the past
			alert.expiresAt = new Date(Date.now() - 10000).toISOString();

			const results = await service.evaluateAlerts();
			expect(results.triggeredCount).toBe(0);
			expect(alert.status).toBe('expired');
		});
	});

	describe('Worker Gating and Status', () => {
		it('reports the configured status shape with the env values in effect', () => {
			// Note: the shared firebase-admin mock resolves a Firestore instance, so
			// this exercises the durable path; an ephemeral environment must report
			// `configured: false` and `degraded` so an operator cannot mistake
			// process-local alerts for durable ones.
			const status = service.getStatus();
			expect(status.enabled).toBe(true);
			expect(status.role).toBe('web');
			expect(status.intervalMs).toBe(60000);
			expect(status.batchLimit).toBe(50);
		});

		it('does not report ready when alerts are only process-local', () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);
			const status = service.getStatus();
			expect(status.storageMode).toBe('ephemeral');
			expect(status.configured).toBe(false);
			expect(status.ready).toBe(false);
			expect(status.status).toBe('degraded');
		});

		it('reports disabled status when ENABLE_USER_PRICE_ALERTS is false', () => {
			process.env.ENABLE_USER_PRICE_ALERTS = 'false';
			const status = service.getStatus();
			expect(status.enabled).toBe(false);
			expect(status.ready).toBe(false);
		});

		it('starts only when the configured role matches the process source', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			expect(service.startWorker({ source: 'web' })).toBe(true);
			await service.stopWorker({ drain: false });

			process.env.USER_PRICE_ALERT_WORKER_ROLE = 'worker';
			expect(service.startWorker({ source: 'web' })).toBe(false);

			process.env.USER_PRICE_ALERT_WORKER_ROLE = 'disabled';
			expect(service.startWorker({ source: 'worker' })).toBe(false);
		});

		it('exposes retention, lease and price-fetch concurrency with safe defaults', () => {
			delete process.env.USER_PRICE_ALERT_RETENTION_DAYS;
			delete process.env.USER_PRICE_ALERT_LEASE_MS;
			delete process.env.USER_PRICE_ALERT_PRICE_FETCH_CONCURRENCY;
			expect(service.getRetentionDays()).toBe(30);
			expect(service.getLeaseMs()).toBe(120000);
			expect(service.getPriceFetchConcurrency()).toBe(3);

			process.env.USER_PRICE_ALERT_RETENTION_DAYS = 'not-a-number';
			process.env.USER_PRICE_ALERT_LEASE_MS = '5';
			process.env.USER_PRICE_ALERT_PRICE_FETCH_CONCURRENCY = '999';
			expect(service.getRetentionDays()).toBe(30);
			expect(service.getLeaseMs()).toBe(10000);
			expect(service.getPriceFetchConcurrency()).toBe(10);
		});
	});

	describe('Firestore persistence (durable mode)', () => {
		const admin = require('firebase-admin');

		// Minimal in-memory Firestore double supporting the exact API surface the
		// service uses: where/orderBy/limit/startAfter/get, doc set/update/get, and
		// runTransaction with transactional reads/writes.
		// Seed shape: { '<collectionName>': { '<docId>': data } }
		function createMockFirestore(seed = {}) {
			const collections = new Map(
				Object.entries(seed).map(([name, docs]) => [name, new Map(
					Object.entries(docs).map(([id, data]) => [id, { ...data }]),
				)]),
			);
			const written = [];

			function docsOf(name) {
				if (!collections.has(name)) collections.set(name, new Map());
				return collections.get(name);
			}

			const db = {
				written,
				store: collections,
				collection(name) {
					const coll = docsOf(name);
					const buildDoc = (id) => ({
						id,
						data: () => (coll.get(id) || {}),
						set: async (payload, opts) => {
							written.push({ id, payload, collection: name });
							coll.set(id, opts && opts.merge
								? { ...(coll.get(id) || {}), ...payload }
								: { ...payload });
						},
						update: async (payload) => {
							written.push({ id, payload, collection: name, update: true });
							coll.set(id, { ...(coll.get(id) || {}), ...payload });
						},
						get: async () => ({ exists: coll.has(id), data: () => (coll.get(id) || {}) }),
					});

					const makeQuery = (filters = [], startAfterId = null, max = Infinity) => ({
						where: (field, op, value) => makeQuery(
							[...filters, { field, op, value }],
							startAfterId,
							max,
						),
						orderBy: () => makeQuery(filters, startAfterId, max),
						startAfter: (afterId) => makeQuery(filters, afterId, max),
						limit: (n) => makeQuery(filters, startAfterId, n),
						get: async () => {
							let rows = Array.from(coll.entries())
								.sort((a, b) => a[0].localeCompare(b[0]));
							for (const { field, op, value } of filters) {
								rows = rows.filter(([, data]) => {
									if (op !== '==') return true;
									return data[field] === value;
								});
							}
							if (startAfterId) {
								const idx = rows.findIndex(([id]) => id === startAfterId);
								if (idx >= 0) rows = rows.slice(idx + 1);
							}
							return {
								docs: rows.slice(0, max).map(([id]) => ({ id, data: () => coll.get(id) })),
								empty: rows.length === 0,
							};
						},
					});

					return { doc: buildDoc, ...makeQuery([]) };
				},
				runTransaction: jest.fn(async (fn) => fn({
					get: async (ref) => {
						const coll = docsOf(ref.__collection);
						return { exists: coll.has(ref.id), data: () => (coll.get(ref.id) || {}) };
					},
					set: (ref, payload) => {
						const coll = docsOf(ref.__collection);
						coll.set(ref.id, { ...(coll.get(ref.id) || {}), ...payload });
					},
					update: (ref, payload) => {
						const coll = docsOf(ref.__collection);
						coll.set(ref.id, { ...(coll.get(ref.id) || {}), ...payload });
					},
				})),
			};

			// Annotate refs so the transaction stub can resolve the right collection.
			const originalCollection = db.collection.bind(db);
			db.collection = (name) => {
				const coll = originalCollection(name);
				const originalDoc = coll.doc;
				coll.doc = (id) => ({ ...originalDoc(id), __collection: name });
				return coll;
			};
			return db;
		}

		// The double builds a fresh query object per `collection()` call, so a
		// failure has to be installed on the collection factory itself. Point
		// `get()` at a rejecting stub so every query chain built from it fails.
		function makeQueriesFail(db, message) {
			const original = db.collection;
			db.collection = (name) => {
				const coll = original(name);
				const broken = { doc: coll.doc };
				const chain = () => {
					const q = {
						where: () => q,
						orderBy: () => q,
						startAfter: () => q,
						limit: () => q,
						get: async () => { throw new Error(message); },
					};
					return q;
				};
				Object.assign(broken, chain());
				return broken;
			};
		}

		it('preserves Firestore sentinel instance types in the written payload', async () => {
			// The repo's shared firebase-admin mock returns plain objects, so stub
			// sentinels as real class instances to prove the sanitizer preserves
			// prototype identity instead of rebuilding them as literals.
			class StubFieldValue { constructor() { this._type = 'serverTimestamp'; } }
			class StubTimestamp {
				constructor(date) { this._date = date; }
				toDate() { return this._date; }
			}
			const db = createMockFirestore();
			jest.spyOn(admin.firestore.FieldValue, 'serverTimestamp').mockImplementation(() => new StubFieldValue());
			jest.spyOn(admin.firestore.Timestamp, 'fromDate').mockImplementation((date) => new StubTimestamp(date));
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			await service.createAlert({
				chatId: 'chat-durable',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 65000,
			});

			const written = db.written.find((entry) => entry.collection === 'userPriceAlerts');
			expect(written).toBeDefined();
			// A plain-object rebuild would turn serverTimestamp() into {} and a
			// Timestamp into {_seconds,_nanoseconds}; the Admin SDK rejects both.
			expect(written.payload.createdAt).toBeInstanceOf(StubFieldValue);
			expect(written.payload.expiresAt).toBeInstanceOf(StubTimestamp);
			expect(typeof written.payload.expiresAt.toDate().getTime()).toBe('number');
			// undefined must still be stripped from the payload.
			expect(Object.prototype.hasOwnProperty.call(written.payload, 'userId')).toBe(false);
		});

		it('surfaces a durable write failure instead of silently losing the alert', async () => {
			const db = createMockFirestore();
			db.collection = () => ({
				doc: () => ({ set: async () => { throw new Error('Firestore unavailable'); } }),
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			await expect(service.createAlert({
				chatId: 'chat-fail',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
			})).rejects.toThrow(UserPriceAlertError);
		});

		it('reads back a durable alert through the chatId+status query', async () => {
			const db = createMockFirestore();
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			const created = await service.createAlert({
				chatId: 'chat-read',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
			});

			const listed = await service.listAlerts({ chatId: 'chat-read', status: 'armed' });
			expect(listed).toHaveLength(1);
			expect(listed[0].id).toBe(created.id);
			// Firestore Timestamp must be projected back to an ISO string.
			expect(typeof listed[0].expiresAt).toBe('string');
		});

		it('skips the sweep entirely when another replica holds the lease', async () => {
			const db = createMockFirestore({
				userPriceAlertLocks: {
					singleton: { lockedUntil: new Date(Date.now() + 60000).toISOString(), lockedBy: 'other-worker' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			const result = await service.evaluateAlerts();
			expect(result.skipped).toBe('lease-held');
			expect(result.evaluatedCount).toBe(0);
		});

		it('surfaces a durable list failure instead of reporting an empty list', async () => {
			// The in-process map is not authoritative in durable mode. Reporting an
			// empty list here would tell the user their armed alerts are gone, and
			// make them impossible to cancel.
			const db = createMockFirestore();
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			makeQueriesFail(db, 'Firestore unavailable');

			await expect(service.listAlerts({ chatId: 'chat-x', status: 'armed' }))
				.rejects.toThrow(UserPriceAlertError);
		});

		it('does not create an ephemeral alert when the durable quota read fails', async () => {
			// createAlert counts existing alerts through listAlerts. If that read
			// fails we must not proceed to the write: the user would get an
			// acknowledgement for an alert whose quota state was never verified.
			const db = createMockFirestore();
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			makeQueriesFail(db, 'Firestore unavailable');

			await expect(service.createAlert({
				chatId: 'chat-quota-read',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
			})).rejects.toThrow(UserPriceAlertError);
			expect(db.written.filter((w) => w.collection === 'userPriceAlerts')).toHaveLength(0);
		});

		it('does not answer a durable get from the stale process-local mirror', async () => {
			// Replica A cancelled the alert; replica B's mirror still says `armed`.
			// A memory-first read would let B report a bogus successful cancel.
			const alertId = 'alert_stale1';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-stale', symbol: 'BTCUSDT', operator: '<', targetPrice: 1, status: 'cancelled' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			service._memoryAlerts.set(alertId, {
				id: alertId, chatId: 'chat-stale', symbol: 'BTCUSDT', operator: '<', targetPrice: 1, status: 'armed',
			});

			const alert = await service.getAlert(alertId);
			expect(alert.status).toBe('cancelled');

			await expect(service.cancelAlert({ chatId: 'chat-stale', alertId }))
				.rejects.toThrow(UserPriceAlertError);
		});

		it('re-arms an undelivered trigger instead of consuming it when no bot is available', async () => {
			const alertId = 'alert_nobot1';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-nobot', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			// No bot: nothing was delivered, so the trigger must not be lost.
			service.setBotGetter(null);
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			const first = await service.evaluateAlerts();
			expect(first.triggeredCount).toBe(1);
			expect(db.store.get('userPriceAlerts').get(alertId).status).toBe('armed');

			// Once a bot is available the same threshold still notifies the user.
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 7 });
			service.setBotGetter({ telegram: { sendMessage } });
			service._lastScannedDocId = null;
			const second = await service.evaluateAlerts();
			expect(second.triggeredCount).toBe(1);
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		it('does not notify again when a delivery attempt fails after the claim', async () => {
			// A failed send leaves the claim at `triggered` with no `deliveredAt`.
			// The re-arm only runs on the "no bot" branch, so a rejected send must
			// stay consumed and never spam the user on the next sweep.
			const alertId = 'alert_sendfail';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-sf', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			const sendMessage = jest.fn().mockRejectedValue(new Error('Telegram 500'));
			service.setBotGetter({ telegram: { sendMessage } });
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			const first = await service.evaluateAlerts();
			expect(first.triggeredCount).toBe(1);
			expect(first.errorsCount).toBe(1);
			const stored = db.store.get('userPriceAlerts').get(alertId);
			expect(stored.status).toBe('triggered');
			expect(stored.deliveredAt).toBeUndefined();

			service._lastScannedDocId = null;
			const second = await service.evaluateAlerts();
			expect(second.triggeredCount).toBe(0);
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		it('records deliveredAt only after a successful send', async () => {
			const alertId = 'alert_delivered';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-d', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 5 });
			service.setBotGetter({ telegram: { sendMessage } });
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			await service.evaluateAlerts();
			const stored = db.store.get('userPriceAlerts').get(alertId);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(stored.status).toBe('triggered');
			expect(stored).toHaveProperty('deliveredAt');
		});

		it('never re-notifies when the Telegram bot flaps across sweeps', async () => {
			// The re-arm is the one place that could resurrect a trigger. Drive the
			// bot through an unavailable -> available -> unavailable -> available
			// cycle and assert the user is notified exactly once in total.
			const alertId = 'alert_flap';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-flap', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 11 });
			const bot = { telegram: { sendMessage } };
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			service.setBotGetter(null);
			await service.evaluateAlerts();
			service.setBotGetter(bot);
			await service.evaluateAlerts();
			service.setBotGetter(null);
			await service.evaluateAlerts();
			service.setBotGetter(bot);
			await service.evaluateAlerts();
			await service.evaluateAlerts();

			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		it('does not re-arm an alert whose delivery attempt was already recorded', async () => {
			// The double-notify window: delivery succeeded, but recording it failed.
			// The attempt marker (written before the send) must still block the
			// re-arm, so a later bot-less sweep cannot resurrect the alert.
			const alertId = 'alert_attempted';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-att', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 21 });
			service.setBotGetter({ telegram: { sendMessage } });
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			await service.evaluateAlerts();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Simulate the `deliveredAt` write being lost: drop it, keep the attempt.
			const stored = db.store.get('userPriceAlerts').get(alertId);
			delete stored.deliveredAt;
			expect(stored.deliveryAttemptedAt).toBeDefined();

			await service._rearmUndelivered(alertId);
			expect(db.store.get('userPriceAlerts').get(alertId).status).toBe('triggered');
		});

		it('does not start sweeping in a process that can never deliver', async () => {
			// A web replica with no Telegram bot must defer rather than claim and
			// re-arm the same alert every cycle.
			process.env.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS = '1000';
			const db = createMockFirestore({
				userPriceAlerts: {
					alert_nobot2: { chatId: 'c', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			service.setBotGetter(null);
			jest.spyOn(service, 'evaluateAlerts').mockResolvedValue({
				evaluatedCount: 1, triggeredCount: 0, errorsCount: 0, skipped: 'no-bot',
			});

			expect(service.startWorker()).toBe(true);
			await new Promise((resolve) => { setTimeout(resolve, 1400); });

			expect(service.evaluateAlerts).not.toHaveBeenCalled();
			expect(service.lastRunSkippedNoBot).toBeGreaterThan(0);
			// The armed row is untouched.
			expect(db.store.get('userPriceAlerts').get('alert_nobot2').status).toBe('armed');
		});

		it('keeps an alert triggered when a prior delivery succeeded', async () => {
			// The re-arm rollback must never resurrect an alert that really fired.
			const alertId = 'alert_fired1';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: {
						chatId: 'chat-fired', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed',
					},
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 9 });
			service.setBotGetter({ telegram: { sendMessage } });
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			await service.evaluateAlerts();
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(db.store.get('userPriceAlerts').get(alertId).status).toBe('triggered');

			await service._rearmUndelivered(alertId);
			expect(db.store.get('userPriceAlerts').get(alertId).status).toBe('triggered');
		});

		it('does not silently fall back to the process-local map when the sweep read fails', async () => {
			const db = createMockFirestore({
				userPriceAlerts: {
					alert_armed9: { chatId: 'chat-sweep', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 3 });
			service.setBotGetter({ telegram: { sendMessage } });
			// Durable rows must never be evaluated from the ephemeral mirror.
			service._memoryAlerts.set('alert_ghost', {
				id: 'alert_ghost', chatId: 'chat-sweep', symbol: 'ETHUSDT', operator: '>', targetPrice: 1, status: 'armed',
			});
			makeQueriesFail(db, 'Firestore unavailable');
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'ETHUSDT', price: 10, assetClass: 'crypto' });

			const result = await service.evaluateAlerts();
			expect(result.evaluatedCount).toBe(0);
			expect(result.triggeredCount).toBe(0);
			expect(sendMessage).not.toHaveBeenCalled();
		});

		it('delivers a triggered alert only once when two sweeps overlap', async () => {
			const alertId = 'alert_dup01';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-dup', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			service.setBotGetter({ telegram: { sendMessage } });
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			const first = await service.evaluateAlerts();
			expect(first.triggeredCount).toBe(1);
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// The durable row is now `triggered`, so a second sweep cannot re-fire it.
			const second = await service.evaluateAlerts();
			expect(second.triggeredCount).toBe(0);
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		it('does not notify when the trigger cannot be claimed', async () => {
			const alertId = 'alert_claim1';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-claim', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			// Simulate another replica winning the transition between read and claim.
			db.runTransaction = jest.fn(async (fn) => {
				let claimed;
				await fn({
					get: async () => ({ exists: true, data: () => ({ status: 'triggered' }) }),
					update: () => { claimed = true; },
					set: () => { claimed = true; },
				});
				return claimed !== undefined;
			});

			const sendMessage = jest.fn();
			service.setBotGetter({ telegram: { sendMessage } });
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			const result = await service.evaluateAlerts();
			expect(result.triggeredCount).toBe(0);
			expect(sendMessage).not.toHaveBeenCalled();
		});

		it('rotates the scan cursor so alerts past the batch limit are not starved', async () => {
			process.env.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT = '1';
			const db = createMockFirestore({
				userPriceAlerts: {
					alert_aaa: { chatId: 'c', symbol: 'BTCUSDT', operator: '>', targetPrice: 1e12, status: 'armed' },
					alert_bbb: { chatId: 'c', symbol: 'ETHUSDT', operator: '>', targetPrice: 1e12, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			// Track which document each sweep actually scanned.
			const scanned = [];
			jest.spyOn(service, '_fetchCurrentPrice').mockImplementation(async (query) => {
				scanned.push(query.symbol);
				return { symbol: query.symbol, price: 1, assetClass: 'crypto' };
			});

			const first = await service.evaluateAlerts();
			const cursorAfterFirst = service._lastScannedDocId;
			const second = await service.evaluateAlerts();
			const cursorAfterSecond = service._lastScannedDocId;

			expect(first.evaluatedCount).toBe(1);
			expect(second.evaluatedCount).toBe(1);
			// The cursor must ADVANCE, not merely be non-null: a fixed `.limit()`
			// without rotation would return the same document forever.
			expect(cursorAfterFirst).toBe('alert_aaa');
			expect(cursorAfterSecond).toBe('alert_bbb');
			// Each sweep must see a *different* document, proving rotation rather
			// than a repeated window.
			expect(scanned).toEqual(['BTCUSDT', 'ETHUSDT']);
		});

		it('wraps the cursor back to the start after reaching the end of the collection', async () => {
			process.env.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT = '1';
			const db = createMockFirestore({
				userPriceAlerts: {
					alert_aaa: { chatId: 'c', symbol: 'BTCUSDT', operator: '>', targetPrice: 1e12, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'X', price: 1, assetClass: 'crypto' });

			await service.evaluateAlerts();
			expect(service._lastScannedDocId).toBe('alert_aaa');
			// Nothing after the cursor: the next sweep must restart the rotation
			// instead of spinning forever on an exhausted cursor.
			await service.evaluateAlerts();
			expect(service._lastScannedDocId).toBeNull();
		});

		it('mirrors a durable cancel into memory so getAlert is not stale', async () => {
			const alertId = 'alert_cancel1';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-cancel', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			await service.cancelAlert({ chatId: 'chat-cancel', alertId });

			// getAlert is memory-first; a stale `armed` mirror would re-report a
			// cancelled alert as active.
			const after = await service.getAlert(alertId);
			expect(after.status).toBe('cancelled');
			expect(after.cancelledAt).toBeDefined();
		});

		it('projects durable timestamps to ISO strings in getAlert', async () => {
			const alertId = 'alert_ts01';
			const db = createMockFirestore();
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			const created = await service.createAlert({
				chatId: 'chat-ts',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
			});
			// Drop the local mirror so getAlert must read the durable record.
			service._memoryAlerts.delete(created.id);

			const read = await service.getAlert(created.id);
			expect(typeof read.expiresAt).toBe('string');
			expect(Number.isNaN(new Date(read.expiresAt).getTime())).toBe(false);
			expect(typeof read.createdAt).toBe('string');
		});

		it('escapes MarkdownV2 reserved characters in the delivered notification', async () => {
			const alertId = 'alert_esc01';
			// A backtick in the symbol would break an unescaped code span and make
			// Telegram reject the whole message with "can't parse entities".
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-esc', symbol: 'BTC`USDT', operator: '>', targetPrice: 1e9, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);

			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			service.setBotGetter({ telegram: { sendMessage } });
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTC`USDT', price: 2e9, assetClass: 'crypto' });

			await service.evaluateAlerts();

			expect(sendMessage).toHaveBeenCalledTimes(1);
			const sentText = sendMessage.mock.calls[0][1];
			// No unescaped backtick may survive.
			expect(sentText.replace(/\\`/g, '')).not.toContain('`');
			expect(sentText).toContain('\\`');
		});

		it('reports a dropped delivery when the bot is unavailable instead of hiding it', async () => {
			const alertId = 'alert_nobot';
			const db = createMockFirestore({
				userPriceAlerts: {
					[alertId]: { chatId: 'chat-nobot', symbol: 'BTCUSDT', operator: '>', targetPrice: 100, status: 'armed' },
				},
			});
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(db);
			service.setBotGetter(null);
			jest.spyOn(service, '_fetchCurrentPrice').mockResolvedValue({ symbol: 'BTCUSDT', price: 150, assetClass: 'crypto' });

			const result = await service.evaluateAlerts();
			expect(result.triggeredCount).toBe(1);
			expect(result.errorsCount).toBe(1);
			expect(service.getStatus().lastError).toBe('telegram_bot_unavailable');
			// The failure is visible AND the user's trigger is preserved for a later
			// sweep that does have a bot.
			expect(db.store.get('userPriceAlerts').get(alertId).status).toBe('armed');
		});
	});
});
