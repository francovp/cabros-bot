'use strict';

const mockRecords = new Map();
let mockUnavailable = false;
let transactionQueue = Promise.resolve();

const mockFirestore = {
	collection: (name) => ({ doc: (id) => ({
		id: `${name}/${id}`,
		update: async (data) => mockRecords.set(`${name}/${id}`, { ...mockRecords.get(`${name}/${id}`), ...data }),
	}) }),
	runTransaction: (callback) => {
		const run = transactionQueue.then(() => callback({
			get: async (ref) => ({ exists: mockRecords.has(ref.id), data: () => mockRecords.get(ref.id) }),
			set: (ref, data) => mockRecords.set(ref.id, data),
		}));
		transactionQueue = run.catch(() => {});
		return run;
	},
};

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	getFirestore: () => mockUnavailable ? null : mockFirestore,
}));

const { reserveAutoTrade, finishAutoTrade } = require('../../src/services/trading/AutoTradeReservationService');

beforeEach(() => {
	mockRecords.clear();
	mockUnavailable = false;
	transactionQueue = Promise.resolve();
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
