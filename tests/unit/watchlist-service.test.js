const { WatchlistService } = require('../../src/services/watchlist/WatchlistService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

describe('WatchlistService', () => {
	let service;

	beforeEach(() => {
		service = new WatchlistService({ firestoreEnabled: false });
	});

	it('normalizes symbols and isolates each chat', async () => {
		await service.add('-10012345', ['btcusdt', 'NASDAQ:nvda']);
		expect(await service.get('-10012345')).toEqual(['BTCUSDT', 'NASDAQ:NVDA']);
		expect(await service.get('-10099999')).toEqual([]);
		expect(await service.matches('-10012345', 'BINANCE:BTCUSDT')).toBe(true);
		expect(await service.matches('-10012345', 'ETHUSDT')).toBe(false);
		expect(await service.matches('-10012345', 'NYSE:NVDA')).toBe(false);
		expect(await service.matches('-10099999', 'ETHUSDT')).toBe(true);
	});

	it('removes and clears symbols', async () => {
		await service.add('12345', ['BTCUSDT', 'ETHUSDT']);
		await service.remove('12345', ['BTCUSDT']);
		expect(await service.get('12345')).toEqual(['ETHUSDT']);
		await service.clear('12345');
		expect(await service.get('12345')).toEqual([]);
	});

	it('rejects invalid symbols without mutating a list', async () => {
		await expect(service.add('12345', ['BTCUSDT', 'bad/thing'])).rejects.toThrow();
		expect(await service.get('12345')).toEqual([]);
	});

	it('allows delivery when the alert symbol is unknown', async () => {
		await service.add('12345', ['BTCUSDT']);
		expect(await service.matches('12345', null)).toBe(true);
	});

	it('lets the watchlist gate initialize the shared Firestore client', () => {
		const previous = process.env.ENABLE_FIRESTORE_WATCHLIST;
		process.env.ENABLE_FIRESTORE_WATCHLIST = 'true';
		try {
			expect(alertStorageService.canInitializeFirestore()).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.ENABLE_FIRESTORE_WATCHLIST;
			else process.env.ENABLE_FIRESTORE_WATCHLIST = previous;
		}
	});

	it('persists a list and falls back to memory when Firestore fails', async () => {
		const doc = { get: jest.fn().mockRejectedValue(new Error('unavailable')), set: jest.fn().mockRejectedValue(new Error('unavailable')) };
		const firestore = { collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue(doc) }) };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await service.add('12345', ['BTCUSDT']);
		expect(await service.get('12345')).toEqual(['BTCUSDT']);
		expect(await service.matches('12345', 'ETHUSDT')).toBe(true);
	});

	it('retains acknowledged local changes after Firestore recovers', async () => {
		const doc = { get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ symbols: [] }) }),
			set: jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined) };
		const firestore = { collection: () => ({ doc: () => doc }) };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await service.add('12345', ['BTCUSDT']);
		expect(await service.get('12345')).toEqual(['BTCUSDT']);
	});

	it('fails open promptly when Firestore read stalls', async () => {
		const firestore = { collection: () => ({ doc: () => ({ get: () => new Promise(() => {}) }) }) };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore, readTimeoutMs: 10 });
		await expect(service.matches('12345', 'ETHUSDT')).resolves.toBe(true);
	});

	it('matches many alert references with one Firestore read', async () => {
		const get = jest.fn().mockResolvedValue({ exists: true,
			data: () => ({ symbols: ['NASDAQ:NVDA'] }) });
		const firestore = { collection: () => ({ doc: () => ({ get }) }) };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		const references = Array.from({ length: 100 }, (_, index) => `NYSE:COIN${index}`);
		await expect(service.matchesAny('12345', [...references, 'NYSE:NVDA'])).resolves.toBe(false);
		await expect(service.matchesAny('12345', ['NYSE:NVDA', 'NASDAQ:NVDA'])).resolves.toBe(true);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it('matches a recognized slash pair against its compact watchlist symbol', async () => {
		await service.add('12345', ['BTCUSDT']);
		expect(await service.matches('12345', 'BTC/USDT')).toBe(true);
		expect(await service.matches('12345', 'ETH/USDT')).toBe(false);
		expect(await service.matches('12345', 'BINANCE:BTC/USDT')).toBe(true);
	});

	it('lets clear supersede an outage addition that exceeds the persisted limit', async () => {
		let stored = Array.from({ length: 50 }, (_, index) => `COIN${index}`);
		const firestore = { collection: () => ({ doc: () => ({}) }),
			runTransaction: jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockImplementation(async (callback) => callback({
				get: async () => ({ exists: true, data: () => ({ symbols: stored }) }),
				set: (_doc, data) => { stored = data.symbols; },
				delete: () => { stored = []; },
			})),
		};
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await service.add('12345', ['NEWCOIN']);
		await expect(service.clear('12345')).resolves.toEqual([]);
		expect(stored).toEqual([]);
		expect(service.dirty.has('12345')).toBe(false);
	});

	it('lets removal repair an outage addition that exceeds the persisted limit', async () => {
		let stored = Array.from({ length: 50 }, (_, index) => `COIN${index}`);
		const firestore = { collection: () => ({ doc: () => ({}) }),
			runTransaction: jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockImplementation(async (callback) => callback({
				get: async () => ({ exists: true, data: () => ({ symbols: stored }) }),
				set: (_doc, data) => { stored = data.symbols; },
				delete: () => { stored = []; },
			})),
		};
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await service.add('12345', ['NEWCOIN']);
		await expect(service.remove('12345', ['COIN0'])).resolves.toContain('NEWCOIN');
		expect(stored).toHaveLength(50);
		expect(stored).not.toContain('COIN0');
		expect(service.dirty.has('12345')).toBe(false);
	});

	it('replays failed mutations transactionally after another replica writes', async () => {
		let stored = [];
		const doc = { get: async () => ({ exists: true, data: () => ({ symbols: stored }) }) };
		const firestore = {
			collection: () => ({ doc: () => doc }),
			runTransaction: jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockImplementation(async (callback) => callback({
				get: async () => ({ exists: true, data: () => ({ symbols: stored }) }),
				set: (_doc, data) => { stored = data.symbols; },
				delete: () => { stored = []; },
			})),
		};
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await service.add('12345', ['BTCUSDT']);
		stored = ['ETHUSDT'];
		await service.add('12345', ['SOLUSDT']);
		expect(stored).toEqual(['ETHUSDT', 'BTCUSDT', 'SOLUSDT']);
	});

	it('rejects a persisted list above the symbol limit without creating a dirty local operation', async () => {
		const stored = Array.from({ length: 50 }, (_, index) => `COIN${index}`);
		const transaction = { get: async () => ({ exists: true, data: () => ({ symbols: stored }) }),
			set: jest.fn(), delete: jest.fn() };
		const firestore = { collection: () => ({ doc: () => ({}) }),
			runTransaction: (callback) => callback(transaction) };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await expect(service.add('12345', ['NEWCOIN'])).rejects.toThrow('Watchlist cannot exceed 50 symbols');
		expect(service.dirty.has('12345')).toBe(false);
		expect(service.dirtyOps.has('12345')).toBe(false);
		expect(service.lists.has('12345')).toBe(false);
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('reconciles a failed write when the next read finds Firestore healthy', async () => {
		let stored = [];
		const doc = { get: async () => ({ exists: true, data: () => ({ symbols: stored }) }) };
		const firestore = {
			collection: () => ({ doc: () => doc }),
			runTransaction: jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockImplementation(async (callback) => callback({
				get: async () => ({ exists: true, data: () => ({ symbols: stored }) }),
				set: (_doc, data) => { stored = data.symbols; },
				delete: () => { stored = []; },
			})),
		};
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await service.add('12345', ['BTCUSDT']);
		expect(await service.matches('12345', 'ETHUSDT')).toBe(true);
		await service.recovery.get('12345');
		expect({ dirty: service.dirty.has('12345'), calls: firestore.runTransaction.mock.calls.length,
			remote: service.remotePending.has('12345') }).toEqual({ dirty: false, calls: 2, remote: false });
		expect(await service.matches('12345', 'ETHUSDT')).toBe(false);
		expect(stored).toEqual(['BTCUSDT']);
	});

	it('keeps dirty outage lookups prompt without growing pending operations', async () => {
		let attempts = 0;
		const firestore = { collection: () => ({ doc: () => ({}) }),
			runTransaction: () => { attempts += 1; return Promise.reject(new Error('unavailable')); } };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore });
		await service.add('12345', ['BTCUSDT']);
		await Promise.all(Array.from({ length: 20 }, () => service.matches('12345', 'ETHUSDT')));
		await new Promise((resolve) => setImmediate(resolve));
		expect(attempts).toBeLessThanOrEqual(2);
		expect(service.dirtyOps.get('12345')).toHaveLength(1);
	});

	it('does not overlap a timed-out transaction with later commands', async () => {
		let finishFirst;
		let stored = ['BTCUSDT'];
		const doc = {};
		const transaction = { get: async () => ({ exists: true, data: () => ({ symbols: stored }) }),
			set: (_doc, data) => { stored = data.symbols; }, delete: () => { stored = []; } };
		const runTransaction = jest.fn().mockImplementationOnce((callback) => new Promise((resolve) => {
			finishFirst = async () => {
				await callback(transaction);
				resolve();
			};
		}))
			.mockImplementation(async (callback) => callback(transaction));
		const firestore = { collection: () => ({ doc: () => doc }), runTransaction };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore, writeTimeoutMs: 10 });
		await service.clear('12345');
		await service.add('12345', ['ETHUSDT']);
		expect(runTransaction).toHaveBeenCalledTimes(1);
		await finishFirst();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		expect(stored).toEqual(['ETHUSDT']);
		await service.add('12345', ['SOLUSDT']);
		expect(stored).toEqual(['ETHUSDT', 'SOLUSDT']);
	});

	it('replies after a bounded Firestore mutation stall', async () => {
		const firestore = { collection: () => ({ doc: () => ({}) }), runTransaction: () => new Promise(() => {}) };
		service = new WatchlistService({ firestoreEnabled: true, getFirestore: () => firestore, writeTimeoutMs: 10 });
		await expect(service.add('12345', ['BTCUSDT'])).resolves.toEqual(['BTCUSDT']);
	});
});
