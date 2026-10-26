'use strict';

const mockRecords = new Map();
let mockUnavailable = false;
let transactionQueue = Promise.resolve();

const mockFirestore = {
	collection: (name) => ({
		doc: (id) => ({
			id: `${name}/${id}`,
			get: async () => ({
				exists: mockRecords.has(`${name}/${id}`),
				id,
				data: () => mockRecords.get(`${name}/${id}`),
			}),
			update: async (data) => mockRecords.set(`${name}/${id}`, { ...mockRecords.get(`${name}/${id}`), ...data }),
			delete: async () => mockRecords.delete(`${name}/${id}`),
		}),
		where: (field, op, value) => {
			const filters = [{ field, op, value }];
			const createQuery = () => ({
				where: (nextField, nextOp, nextValue) => {
					filters.push({ field: nextField, op: nextOp, value: nextValue });
					return createQuery();
				},
				limit: (lim) => ({
					get: async () => {
						const docs = [];
						for (const [key, data] of mockRecords.entries()) {
							if (!key.startsWith(`${name}/`)) continue;
							const match = filters.every((f) => {
								if (f.field.includes('.')) {
									const parts = f.field.split('.');
									let val = data;
									for (const part of parts) {
										val = val?.[part];
									}
									return f.op === '==' ? val === f.value : false;
								}
								return f.op === '==' ? data[f.field] === f.value : false;
							});
							if (match) {
								docs.push({ id: key.replace(`${name}/`, ''), data: () => data });
							}
							if (docs.length >= lim) break;
						}
						return { docs };
					},
				}),
				get: async () => {
					const docs = [];
					for (const [key, data] of mockRecords.entries()) {
						if (!key.startsWith(`${name}/`)) continue;
						const match = filters.every((f) => {
							if (f.field.includes('.')) {
								const parts = f.field.split('.');
								let val = data;
								for (const part of parts) {
									val = val?.[part];
								}
								return f.op === '==' ? val === f.value : false;
							}
							return f.op === '==' ? data[f.field] === f.value : false;
						});
						if (match) {
							docs.push({ id: key.replace(`${name}/`, ''), data: () => data });
						}
					}
					return { docs };
				},
			});
			return createQuery();
		},
		limit: (lim) => ({
			get: async () => {
				const docs = [];
				for (const [key, data] of mockRecords.entries()) {
					if (!key.startsWith(`${name}/`)) continue;
					docs.push({ id: key.replace(`${name}/`, ''), data: () => data });
					if (docs.length >= lim) break;
				}
				return { docs };
			},
		}),
	}),
	runTransaction: (callback) => {
		const run = transactionQueue.then(() => callback({
			get: async (ref) => ({
				exists: mockRecords.has(ref.id),
				id: ref.id.includes('/') ? ref.id.split('/')[1] : ref.id,
				data: () => mockRecords.get(ref.id),
			}),
			set: (ref, data) => mockRecords.set(ref.id, data),
			update: (ref, data) => mockRecords.set(ref.id, { ...mockRecords.get(ref.id), ...data }),
			delete: (ref) => mockRecords.delete(ref.id),
		}));
		transactionQueue = run.catch(() => {});
		return run;
	},
};

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	getFirestore: () => mockUnavailable ? null : mockFirestore,
}));

const {
	reserveAutoTrade,
	finishAutoTrade,
	listAmbiguousReservations,
	getAmbiguousReservation,
	resolveAmbiguousReservation,
	getAmbiguousCount,
	notifyAdminOfAmbiguousReservation,
	digest,
	__resetForTesting,
} = require('../../src/services/trading/AutoTradeReservationService');

beforeEach(() => {
	mockRecords.clear();
	mockUnavailable = false;
	transactionQueue = Promise.resolve();
	if (typeof __resetForTesting === 'function') __resetForTesting();
});

const windowOptions = { cooldownKey: 'BINANCE|BTCUSDT|1h|BUY', cooldownMs: 3600000 };

it('atomically reserves one occurrence across concurrent callers', async () => {
	const [first, second] = await Promise.all([
		reserveAutoTrade('bar-123', 'intent-a', windowOptions),
		reserveAutoTrade('bar-123', 'intent-a', windowOptions),
	]);
	expect([first.state, second.state].sort()).toEqual(['duplicate', 'reserved']);
	expect(mockRecords.size).toBe(2);
});

it('atomically suppresses a distinct occurrence in the same shared cooldown', async () => {
	const [first, second] = await Promise.all([
		reserveAutoTrade('bar-123', 'intent-a', windowOptions),
		reserveAutoTrade('bar-124', 'intent-a', windowOptions),
	]);
	expect([first.state, second.state].sort()).toEqual(['cooldown', 'reserved']);
	expect(mockRecords.size).toBe(2);
});

it('allows a later occurrence after the shared cooldown expires', async () => {
	const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(3601001);
	try {
		expect((await reserveAutoTrade('bar-123', 'intent-a', windowOptions)).state).toBe('reserved');
		expect((await reserveAutoTrade('bar-124', 'intent-a', windowOptions)).state).toBe('reserved');
	} finally { clock.mockRestore(); }
});

it('rejects reuse of an occurrence ID for a different intent', async () => {
	await reserveAutoTrade('bar-123', 'intent-a', windowOptions);
	expect(await reserveAutoTrade('bar-123', 'intent-b', windowOptions)).toMatchObject({ state: 'conflict' });
});

it('keeps a completed reservation so the same occurrence cannot submit again', async () => {
	const first = await reserveAutoTrade('bar-123', 'intent-a', windowOptions);
	await finishAutoTrade(first, 'submitted', { orderId: 42 });
	expect(await reserveAutoTrade('bar-123', 'intent-a', windowOptions)).toMatchObject({ state: 'duplicate', status: 'submitted' });
});

it('fails closed when durable storage is unavailable', async () => {
	mockUnavailable = true;
	expect(await reserveAutoTrade('bar-123', 'intent-a', windowOptions)).toMatchObject({ state: 'unavailable' });
});

describe('ambiguous reservations and reconciliation (#1466)', () => {
	it('records an ambiguous reservation on indeterminate status with reason and lastAttempt', async () => {
		const reservation = await reserveAutoTrade('bar-amb-1', 'intent-a', {
			...windowOptions,
			context: { symbol: 'BTCUSDT', side: 'BUY', timeframe: '1h' },
		});
		expect(reservation.state).toBe('reserved');

		const finished = await finishAutoTrade(reservation, 'unknown', {
			errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
			errorMessage: 'Execution status unknown',
			clientOrderId: 'cl-123',
			lastAttempt: {
				errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
				errorMessage: 'Execution status unknown',
				clientOrderId: 'cl-123',
			},
		});
		expect(finished).toBe(true);

		const record = await getAmbiguousReservation('bar-amb-1');
		expect(record).toMatchObject({
			status: 'unknown',
			ambiguous: true,
			ambiguousReason: 'BINANCE_ORDER_STATUS_UNKNOWN',
			signalContext: { symbol: 'BTCUSDT', side: 'BUY' },
			lastAttempt: {
				errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
				clientOrderId: 'cl-123',
			},
		});
		expect(getAmbiguousCount()).toBeGreaterThanOrEqual(1);
	});

	it('lists ambiguous reservations with filtering', async () => {
		const res1 = await reserveAutoTrade('bar-amb-list-1', 'intent-1', {
			...windowOptions,
			context: { symbol: 'BTCUSDT', side: 'BUY' },
		});
		await finishAutoTrade(res1, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		const res2 = await reserveAutoTrade('bar-amb-list-2', 'intent-2', {
			...windowOptions,
			context: { symbol: 'ETHUSDT', side: 'BUY' },
		});
		await finishAutoTrade(res2, 'submitted', { orderId: 101 });

		const list = await listAmbiguousReservations();
		expect(list.success).toBe(true);
		expect(list.reservations.some((r) => r.signalId === 'bar-amb-list-1')).toBe(true);
		expect(list.reservations.some((r) => r.signalId === 'bar-amb-list-2')).toBe(false);
	});

	it('resolves an ambiguous reservation as placed, updating status and orderId', async () => {
		const reservation = await reserveAutoTrade('bar-amb-placed', 'intent-placed', windowOptions);
		await finishAutoTrade(reservation, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		const outcome = await resolveAmbiguousReservation('bar-amb-placed', {
			resolvedAs: 'placed',
			orderId: 998877,
			notes: 'Confirmed on Binance web terminal',
			actor: 'admin.operator',
		});

		expect(outcome.idempotent).toBe(false);
		expect(outcome.reservation).toMatchObject({
			status: 'submitted',
			ambiguous: false,
			resolvedAs: 'placed',
			resolvedBy: 'admin.operator',
			orderId: 998877,
			notes: 'Confirmed on Binance web terminal',
		});

		// Idempotent re-resolution with same outcome succeeds
		const reOutcome = await resolveAmbiguousReservation('bar-amb-placed', {
			resolvedAs: 'placed',
			orderId: 998877,
		});
		expect(reOutcome.idempotent).toBe(true);
		expect(reOutcome.reservation.resolvedAs).toBe('placed');
	});

	it('resolves an ambiguous reservation as not_placed, settling the cooldown slot', async () => {
		const reservation = await reserveAutoTrade('bar-amb-notplaced', 'intent-notplaced', windowOptions);
		await finishAutoTrade(reservation, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		const outcome = await resolveAmbiguousReservation('bar-amb-notplaced', {
			resolvedAs: 'not_placed',
			notes: 'No order reached Binance',
			actor: 'admin.operator',
		});

		expect(outcome.reservation).toMatchObject({
			status: 'failed',
			ambiguous: false,
			resolvedAs: 'not_placed',
		});

		// Now a new reservation for the same cooldown slot should succeed because cooldown was settled!
		const newRes = await reserveAutoTrade('bar-amb-next', 'intent-next', windowOptions);
		expect(newRes.state).toBe('reserved');
	});

	it('rejects conflict when attempting to change an already resolved reservation', async () => {
		const reservation = await reserveAutoTrade('bar-amb-conflict', 'intent-conflict', windowOptions);
		await finishAutoTrade(reservation, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		await resolveAmbiguousReservation('bar-amb-conflict', {
			resolvedAs: 'placed',
			orderId: 12345,
		});

		await expect(resolveAmbiguousReservation('bar-amb-conflict', {
			resolvedAs: 'not_placed',
		})).rejects.toMatchObject({
			code: 'RESERVATION_ALREADY_RESOLVED',
			statusCode: 409,
		});
	});

	it('rejects resolving a non-ambiguous reservation', async () => {
		const reservation = await reserveAutoTrade('bar-normal', 'intent-normal', windowOptions);
		await finishAutoTrade(reservation, 'submitted', { orderId: 777 });

		await expect(resolveAmbiguousReservation('bar-normal', {
			resolvedAs: 'not_placed',
		})).rejects.toMatchObject({
			code: 'NOT_AMBIGUOUS',
			statusCode: 400,
		});
	});

	it('deduplicates admin notification on repeated reports of an ambiguous row (#827 pattern)', async () => {
		const savedChat = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345678';
		try {
			const res = await notifyAdminOfAmbiguousReservation({
				reservationId: 'res-dedup-test',
				signalId: 'sig-1',
				signalContext: { symbol: 'BTCUSDT', side: 'BUY' },
				reason: 'BINANCE_ORDER_STATUS_UNKNOWN',
			});
			// Second call with same reservationId is deduplicated (returns false)
			const res2 = await notifyAdminOfAmbiguousReservation({
				reservationId: 'res-dedup-test',
				signalId: 'sig-1',
				signalContext: { symbol: 'BTCUSDT', side: 'BUY' },
				reason: 'BINANCE_ORDER_STATUS_UNKNOWN',
			});
			expect(res2).toBe(false);
		} finally {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = savedChat;
		}
	});

	it('validates limit strictly and rejects non-integer or out-of-range limits', async () => {
		await expect(listAmbiguousReservations({ limit: 'abc' })).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
			statusCode: 400,
		});
		await expect(listAmbiguousReservations({ limit: -5 })).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
			statusCode: 400,
		});
		await expect(listAmbiguousReservations({ limit: '1.5' })).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
			statusCode: 400,
		});
		await expect(listAmbiguousReservations({ limit: 101 })).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
			statusCode: 400,
		});
	});

	it('includes legacy status: unknown reservations in ambiguous listing', async () => {
		const legacyDocId = digest('legacy-sig-1');
		mockRecords.set('autoTradeReservations/' + legacyDocId, {
			fingerprint: 'legacy-fp',
			signalId: 'legacy-sig-1',
			status: 'unknown',
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const list = await listAmbiguousReservations({ limit: 50 });
		const found = list.reservations.find((r) => r.signalId === 'legacy-sig-1');
		expect(found).toBeDefined();
		expect(found.status).toBe('unknown');
	});

	it('verifies cooldown ownership before clearing shared cooldown slot', async () => {
		const resA = await reserveAutoTrade('bar-owner-A', 'intent-A', { cooldownKey: 'owner-cd-slot', cooldownMs: 60000 });
		await finishAutoTrade(resA, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		// Simulate another reservation B later claiming the same cooldown slot
		const cooldownDocId = digest('owner-cd-slot');
		mockRecords.set('autoTradeCooldowns/' + cooldownDocId, {
			firedAtMs: Date.now(),
			reservationId: 'different-reservation-B',
			signalId: 'signal-B',
		});

		// Now resolve A as not_placed
		await resolveAmbiguousReservation('bar-owner-A', {
			resolvedAs: 'not_placed',
		});

		// Cooldown slot should STILL exist and belong to B!
		const cdDoc = mockRecords.get('autoTradeCooldowns/' + cooldownDocId);
		expect(cdDoc).toBeDefined();
		expect(cdDoc.reservationId).toBe('different-reservation-B');
	});

	it('falls back to digest for 64-character raw signalId lookups and resolutions', async () => {
		const raw64CharSignalId = 'a'.repeat(64);
		const reservation = await reserveAutoTrade(raw64CharSignalId, 'intent-64', windowOptions);
		await finishAutoTrade(reservation, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		// Lookup by raw signalId
		const lookedUp = await getAmbiguousReservation(raw64CharSignalId);
		expect(lookedUp).toBeDefined();
		expect(lookedUp.signalId).toBe(raw64CharSignalId);

		// Resolve by raw signalId
		const outcome = await resolveAmbiguousReservation(raw64CharSignalId, {
			resolvedAs: 'placed',
			orderId: 98765,
		});
		expect(outcome.reservation.status).toBe('submitted');
		expect(outcome.reservation.orderId).toBe(98765);
	});

	it('does not update global cached ambiguous count from symbol-filtered listings', async () => {
		const res1 = await reserveAutoTrade('bar-sym-1', 'intent-sym-1', { ...windowOptions, cooldownKey: 'cd-sym-1', context: { symbol: 'BTCUSDT' } });
		await finishAutoTrade(res1, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });
		const res2 = await reserveAutoTrade('bar-sym-2', 'intent-sym-2', { ...windowOptions, cooldownKey: 'cd-sym-2', context: { symbol: 'ETHUSDT' } });
		await finishAutoTrade(res2, 'unknown', { errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN' });

		await listAmbiguousReservations({ limit: 50 });
		const globalCountBefore = getAmbiguousCount();
		expect(globalCountBefore).toBeGreaterThanOrEqual(2);

		const filtered = await listAmbiguousReservations({ limit: 50, symbol: 'NONEXISTENT' });
		expect(filtered.count).toBe(0);
		expect(getAmbiguousCount()).toBe(globalCountBefore);
	});
});
