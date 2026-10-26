'use strict';

const crypto = require('crypto');
const {
	createBinanceBracketOrderStorageService,
} = require('../../src/services/trading/BinanceBracketOrderStorageService');

function createFirestore() {
	const docs = new Map();
	const ref = (collection, id) => ({
		collection,
		id,
		key: `${collection}/${id}`,
		async get() {
			const value = docs.get(`${collection}/${id}`);
			return { exists: value !== undefined, data: () => value };
		},
		async set(value, options = {}) {
			const key = `${collection}/${id}`;
			docs.set(key, options.merge ? { ...docs.get(key), ...value } : value);
		},
	});
	return {
		docs,
		firestore: {
			collection(name) {
				return { doc: (id) => ref(name, id) };
			},
			async runTransaction(callback) {
				return callback({
					get: (documentRef) => documentRef.get(),
					create(documentRef, value) {
						if (docs.has(documentRef.key)) {
							const error = new Error('already exists');
						throw error;
						}
						docs.set(documentRef.key, value);
					},
					set: (documentRef, value, options) => documentRef.set(value, options),
					update(documentRef, value) {
						return documentRef.set(value, { merge: true });
					},
				});
			},
		},
	};
}

describe('BinanceBracketOrderStorageService', () => {
	const idempotencyKey = 'sensitive-idempotency-key';
	const requestFingerprint = 'a'.repeat(64);
	let memory;
	let now;
	let storage;

	beforeEach(() => {
		memory = createFirestore();
		now = 1_800_000_000_000;
		storage = createBinanceBracketOrderStorageService({
			getFirestore: () => memory.firestore,
			now: () => now,
		});
	});

	it('permanently reserves only the key hash and request fingerprint', async () => {
		const reservation = await storage.reserve({
			idempotencyKey,
			requestFingerprint,
			listClientOrderId: 'cb_list_123',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		});

		const keyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
		expect(reservation).toMatchObject({ outcome: 'reserved', state: 'RESERVED', keyHash, requestFingerprint });
		expect(memory.docs.get(`binanceBracketReservations/${keyHash}`)).toEqual(expect.objectContaining({
			keyHash,
			requestFingerprint,
			listClientOrderId: 'cb_list_123',
			state: 'RESERVED',
		}));
		expect(JSON.stringify(memory.docs)).not.toContain(idempotencyKey);
	});

	it('returns an existing matching reservation and conflicts on a different fingerprint', async () => {
		const input = {
			idempotencyKey,
			requestFingerprint,
			listClientOrderId: 'cb_list_123',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		};
		await storage.reserve(input);

		await expect(storage.reserve(input)).resolves.toMatchObject({
			outcome: 'existing',
			state: 'RESERVED',
			requestFingerprint,
		});
		await expect(storage.reserve({ ...input, requestFingerprint: 'b'.repeat(64) }))
			.rejects.toMatchObject({ code: 'BINANCE_ORDER_CONFLICT', statusCode: 409 });
	});

	it('keeps nonterminal details without expiry and sets one-hour expiry after terminal state', async () => {
		const input = {
			idempotencyKey,
			requestFingerprint,
			listClientOrderId: 'cb_list_123',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		};
		const reservation = await storage.reserve(input);
		const orderList = {
			orderListId: 123,
			listClientOrderId: 'cb_list_123',
			listOrderStatus: 'EXECUTING',
			orders: [{ orderId: 1 }, { orderId: 2 }, { orderId: 3 }],
			orderReports: [
				{ orderId: 1, status: 'NEW' },
				{ orderId: 2, status: 'PENDING_NEW' },
				{ orderId: 3, status: 'PENDING_NEW' },
			],
			unexpectedSecret: 'must-not-be-stored',
		};

		await storage.recordOrderList({ ...input, keyHash: reservation.keyHash, orderList });
		const detailIdentity = crypto.createHash('sha256').update('cb_list_123').digest('hex').slice(0, 32);
		const detailPath = `binanceBracketOrders/testnet_${detailIdentity}`;
		const openDetail = memory.docs.get(detailPath);
		expect(openDetail.expiresAt).toBeUndefined();
		expect(openDetail.orderList.orderReports).toHaveLength(3);
		expect(JSON.stringify(openDetail)).not.toContain('unexpectedSecret');

		now += 5000;
		await storage.recordOrderList({
			...input,
			keyHash: reservation.keyHash,
			orderList: {
				...orderList,
				listOrderStatus: 'ALL_DONE',
				orderReports: [
					{ orderId: 1, status: 'FILLED' },
					{ orderId: 2, status: 'CANCELED' },
					{ orderId: 3, status: 'FILLED' },
				],
			},
		});
		const terminalDetail = memory.docs.get(detailPath);
		expect(terminalDetail.terminalAt).toEqual(new Date(now));
		expect(terminalDetail.expiresAt).toEqual(new Date(now + 60 * 60 * 1000));
		expect(memory.docs.get(`binanceBracketReservations/${reservation.keyHash}`)).toEqual(expect.objectContaining({
			terminalAt: terminalDetail.terminalAt,
			expiresAt: terminalDetail.expiresAt,
		}));
	});

	it('expires an OTOCO list marked ALL_DONE even when Binance returns fewer than three order reports', async () => {
		const reservation = await storage.reserve({
			idempotencyKey,
			requestFingerprint,
			listClientOrderId: 'cb_list_456',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		});

		await storage.recordOrderList({
			keyHash: reservation.keyHash,
			symbol: 'BTCUSDT',
			environment: 'testnet',
			orderList: {
				orderListId: 456,
				listClientOrderId: 'cb_list_456',
				listOrderStatus: 'ALL_DONE',
				orderReports: [{ orderId: 4, status: 'CANCELED' }],
			},
		});

		const detailIdentity = crypto.createHash('sha256').update('cb_list_456').digest('hex').slice(0, 32);
		const detail = memory.docs.get(`binanceBracketOrders/testnet_${detailIdentity}`);
		expect(detail.terminalAt).toEqual(new Date(now));
		expect(detail.expiresAt).toEqual(new Date(now + 60 * 60 * 1000));
	});

	it('preserves the original terminal expiry when reconciliation follows TTL cleanup', async () => {
		const reservation = await storage.reserve({
			idempotencyKey,
			requestFingerprint,
			listClientOrderId: 'cb_list_789',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		});
		const orderList = {
			orderListId: 789,
			listClientOrderId: 'cb_list_789',
			listOrderStatus: 'ALL_DONE',
			orderReports: [{ orderId: 7, status: 'CANCELED' }],
		};
		await storage.recordOrderList({
			keyHash: reservation.keyHash,
			symbol: 'BTCUSDT',
			environment: 'testnet',
			orderList,
		});
		const detailIdentity = crypto.createHash('sha256').update('cb_list_789').digest('hex').slice(0, 32);
		const detailPath = `binanceBracketOrders/testnet_${detailIdentity}`;
		const originalTerminalAt = new Date(now);
		const originalExpiresAt = new Date(now + 60 * 60 * 1000);

		now += 2 * 60 * 60 * 1000;
		memory.docs.delete(detailPath);
		await storage.recordOrderList({
			keyHash: reservation.keyHash,
			symbol: 'BTCUSDT',
			environment: 'testnet',
			orderList,
		});

		expect(memory.docs.get(detailPath).terminalAt).toEqual(originalTerminalAt);
		expect(memory.docs.get(detailPath).expiresAt).toEqual(originalExpiresAt);
	});

	it('does not recreate a TTL-deleted terminal detail from an unkeyed status lookup', async () => {
		const reservation = await storage.reserve({
			idempotencyKey,
			requestFingerprint,
			listClientOrderId: 'cb_list_890',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		});
		const orderList = {
			orderListId: 890,
			listClientOrderId: 'cb_list_890',
			listOrderStatus: 'ALL_DONE',
			orderReports: [{ orderId: 8, status: 'CANCELED' }],
		};
		await storage.recordOrderList({
			keyHash: reservation.keyHash,
			symbol: 'BTCUSDT',
			environment: 'testnet',
			orderList,
		});
		const detailIdentity = crypto.createHash('sha256').update('cb_list_890').digest('hex').slice(0, 32);
		const detailPath = `binanceBracketOrders/testnet_${detailIdentity}`;
		memory.docs.delete(detailPath);
		now += 2 * 60 * 60 * 1000;

		await storage.recordOrderList({ symbol: 'BTCUSDT', environment: 'testnet', orderList });

		expect(memory.docs.has(detailPath)).toBe(false);
	});

	it('preserves request metadata across subsequent recordOrderList calls and recovers via getBracketOrder', async () => {
		const reservation = await storage.reserve({
			idempotencyKey: 'bracket-meta-key',
			requestFingerprint: 'b'.repeat(64),
			listClientOrderId: 'cb_list_meta',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		});
		const orderList = {
			orderListId: 555,
			listClientOrderId: 'cb_list_meta',
			listOrderStatus: 'EXECUTING',
			orderReports: [{ orderId: 10, status: 'NEW' }],
		};
		const initialRecord = await storage.recordOrderList({
			keyHash: reservation.keyHash,
			requestFingerprint: 'b'.repeat(64),
			symbol: 'BTCUSDT',
			environment: 'testnet',
			request: {
				symbol: 'BTCUSDT',
				side: 'BUY',
				origin: 'admin_alert',
				alertId: 'alert-meta-1',
				setupType: 'breakout',
			},
			orderList,
		});
		expect(initialRecord.request).toMatchObject({
			origin: 'admin_alert',
			alertId: 'alert-meta-1',
			setupType: 'breakout',
		});

		// Subsequent record without request preserves existing metadata
		const updatedRecord = await storage.recordOrderList({
			symbol: 'BTCUSDT',
			environment: 'testnet',
			orderList: {
				...orderList,
				listOrderStatus: 'ALL_DONE',
			},
		});
		expect(updatedRecord.request).toMatchObject({
			origin: 'admin_alert',
			alertId: 'alert-meta-1',
			setupType: 'breakout',
		});

		const fetched = await storage.getBracketOrder({
			environment: 'testnet',
			listClientOrderId: 'cb_list_meta',
		});
		expect(fetched.request).toMatchObject({
			origin: 'admin_alert',
			alertId: 'alert-meta-1',
			setupType: 'breakout',
		});
	});

	it('fails closed when Firestore cannot provide transactional reservations', async () => {
		const unavailable = createBinanceBracketOrderStorageService({ getFirestore: () => null });
		await expect(unavailable.reserve({
			idempotencyKey,
			requestFingerprint,
			listClientOrderId: 'cb_list_123',
			symbol: 'BTCUSDT',
			environment: 'testnet',
		})).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', statusCode: 503 });
	});
});
