'use strict';

const {
	bindOrderProvenance,
	resolveOrderProvenance,
	resetOrderProvenanceForTesting,
	COLLECTION_NAME,
} = require('../../src/services/trading/orderProvenance');

describe('orderProvenance', () => {
	let mockFirestore;
	let docs;

	beforeEach(() => {
		resetOrderProvenanceForTesting();
		docs = new Map();
		mockFirestore = {
			collection: jest.fn((colName) => ({
				doc: jest.fn((docId) => ({
					get: jest.fn(async () => {
						const data = docs.get(`${colName}:${docId}`);
						return {
							exists: Boolean(data),
							data: () => data,
						};
					}),
					set: jest.fn(async (data, options) => {
						const key = `${colName}:${docId}`;
						if (options?.merge && docs.has(key)) {
							docs.set(key, { ...docs.get(key), ...data });
						} else {
							docs.set(key, data);
						}
					}),
				})),
				where: jest.fn(() => ({
					where: jest.fn(() => ({
						limit: jest.fn(() => ({
							get: jest.fn(async () => {
								return { empty: true, docs: [] };
							}),
						})),
					})),
				})),
			})),
		};
	});

	it('binds order provenance in memory and Firestore', async () => {
		const record = await bindOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
			firestore: mockFirestore,
		});

		expect(record).toEqual({
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
		});

		expect(mockFirestore.collection).toHaveBeenCalledWith(COLLECTION_NAME);
		expect(docs.get(`${COLLECTION_NAME}:testnet:BTCUSDT:cid-1`)).toMatchObject({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
		});
	});

	it('resolves preserved provenance when identical or omitted on retry', async () => {
		await bindOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
			firestore: mockFirestore,
		});

		// 1. Retry with omitted provenance returns original
		const resolvedOmitted = await resolveOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			firestore: mockFirestore,
		});
		expect(resolvedOmitted).toEqual({
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
		});

		// 2. Retry with matching provenance succeeds
		const resolvedMatching = await resolveOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
			firestore: mockFirestore,
		});
		expect(resolvedMatching).toEqual({
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
		});
	});

	it('rejects conflicting origin on reconciliation', async () => {
		await bindOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
			firestore: mockFirestore,
		});

		await expect(resolveOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'manual',
			firestore: mockFirestore,
		})).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
			message: expect.stringMatching(/provenance does not match/),
		});
	});

	it('rejects conflicting alertId on reconciliation', async () => {
		await bindOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
			firestore: mockFirestore,
		});

		await expect(resolveOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			alertId: 'alert-different',
			firestore: mockFirestore,
		})).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
		});
	});

	it('rejects conflicting setupType on reconciliation', async () => {
		await bindOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			origin: 'auto_trade',
			alertId: 'alert-1',
			setupType: 'breakout',
			firestore: mockFirestore,
		});

		await expect(resolveOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-1',
			setupType: 'pullback',
			firestore: mockFirestore,
		})).rejects.toMatchObject({
			code: 'BINANCE_ORDER_CONFLICT',
			statusCode: 409,
		});
	});

	it('reads from Firestore and caches in memory when not present in memoryCache', async () => {
		docs.set(`${COLLECTION_NAME}:testnet:BTCUSDT:cid-cold`, {
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-cold',
			origin: 'alert',
			alertId: 'alert-persisted',
			setupType: 'reversal',
		});

		const resolved = await resolveOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-cold',
			firestore: mockFirestore,
		});

		expect(resolved).toEqual({
			origin: 'alert',
			alertId: 'alert-persisted',
			setupType: 'reversal',
		});
	});

	it('falls back to tradeFills when orderProvenance doc is not found', async () => {
		mockFirestore.collection = jest.fn((colName) => ({
			doc: jest.fn(() => ({
				get: jest.fn(async () => ({ exists: false })),
				set: jest.fn(async () => {}),
			})),
			where: jest.fn(() => ({
				where: jest.fn(() => ({
					limit: jest.fn(() => ({
						get: jest.fn(async () => ({
							empty: false,
							docs: [{
								data: () => ({
									origin: 'auto_trade',
									alertId: 'fill-alert',
									setupType: 'breakout',
								}),
							}],
						})),
					})),
				})),
			})),
		}));

		const resolved = await resolveOrderProvenance({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			clientOrderId: 'cid-fill',
			firestore: mockFirestore,
		});

		expect(resolved).toEqual({
			origin: 'auto_trade',
			alertId: 'fill-alert',
			setupType: 'breakout',
		});
	});
});
