'use strict';

const { TradeLedgerService, buildFillRecords } = require('../../src/services/trading/TradeLedgerService');
const { FirestoreWriteMetricsService } = require('../../src/services/storage/FirestoreWriteMetricsService');

const ORDER = {
	symbol: 'BTCUSDT',
	orderId: 123,
	clientOrderId: 'cid-1',
	side: 'BUY',
	transactTime: Date.parse('2026-10-01T00:00:00.000Z'),
	fills: [
		{ price: '100', qty: '0.6', commission: '0.06', commissionAsset: 'USDT', tradeId: 11 },
		{ price: '101', qty: '0.4', commission: '0.0004', commissionAsset: 'BTC', tradeId: 12 },
		{ price: '101', qty: '0.1', commission: '0.00001', commissionAsset: 'BNB', tradeId: 13 },
	],
};

function createFirestoreMock({ createImpl } = {}) {
	const docs = new Map();
	const create = jest.fn(createImpl || (async function create(id, data) {
		if (docs.has(id)) {
			const err = new Error('already exists');
			err.code = 6;
			throw err;
		}
		docs.set(id, data);
	}));
	const queryState = {};
	const query = {
		where: jest.fn((field, op, value) => { queryState.where = [field, op, value]; return query; }),
		orderBy: jest.fn((field, dir) => { queryState.orderBy = [field, dir]; return query; }),
		limit: jest.fn((n) => { queryState.limit = n; return query; }),
		get: jest.fn(async () => {
			const [, , env] = queryState.where;
			const rows = [...docs.values()]
				.filter((d) => d.environment === env)
				.sort((a, b) => b.filledAt.localeCompare(a.filledAt))
				.slice(0, queryState.limit);
			return { docs: rows.map((d) => ({ data: () => d })) };
		}),
	};
	return {
		docs,
		queryState,
		create,
		firestore: {
			collection: jest.fn(() => ({
				doc: jest.fn((id) => ({ create: (data) => create(id, data) })),
				...query,
			})),
		},
	};
}

describe('buildFillRecords', () => {
	it('normalizes FULL order fills into idempotent ledger records', () => {
		const records = buildFillRecords({ environment: 'testnet', order: ORDER, origin: 'manual', alertId: null });
		expect(records.map((r) => r.id)).toEqual(['testnet:BTCUSDT:11', 'testnet:BTCUSDT:12', 'testnet:BTCUSDT:13']);
		const [quoteFee, baseFee, bnbFee] = records.map((r) => r.data);
		expect(quoteFee).toMatchObject({
			environment: 'testnet',
			symbol: 'BTCUSDT',
			baseAsset: 'BTC',
			quoteAsset: 'USDT',
			side: 'BUY',
			price: '100',
			qty: '0.6',
			quoteQty: '60',
			commission: '0.06',
			commissionAsset: 'USDT',
			commissionQuote: '0.06',
			binanceOrderId: '123',
			clientOrderId: 'cid-1',
			alertId: null,
			origin: 'manual',
			tradeId: 11,
			filledAt: '2026-10-01T00:00:00.000Z',
		});
		expect(baseFee.commissionQuote).toBe('0.0404');
		expect(bnbFee.commissionQuote).toBeNull();
		for (const { data } of records) {
			expect(Object.values(data)).not.toContain(undefined);
		}
	});

	it('returns no records for dry runs or orders without fills', () => {
		expect(buildFillRecords({ environment: 'testnet', order: { symbol: 'BTCUSDT', side: 'BUY' } })).toEqual([]);
		expect(buildFillRecords({ environment: 'testnet', order: null })).toEqual([]);
	});

	it('coerces unknown origins to manual', () => {
		const [record] = buildFillRecords({ environment: 'live', order: ORDER, origin: 'hacker' });
		expect(record.data.origin).toBe('manual');
	});
});

describe('TradeLedgerService', () => {
	const ORIGINAL_ENV = { ...process.env };
	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	it('is disabled by default and records nothing', async () => {
		delete process.env.ENABLE_TRADE_LEDGER;
		const mock = createFirestoreMock();
		const service = new TradeLedgerService({ firestore: mock.firestore });
		expect(service.isEnabled()).toBe(false);
		expect(await service.recordOrderFills({ environment: 'testnet', order: ORDER })).toEqual({ written: 0, duplicates: 0, failed: 0 });
		expect(mock.create).not.toHaveBeenCalled();
	});

	it('writes fills once and treats replays as duplicates', async () => {
		process.env.ENABLE_TRADE_LEDGER = 'true';
		const mock = createFirestoreMock();
		const metrics = new FirestoreWriteMetricsService();
		const service = new TradeLedgerService({ firestore: mock.firestore, metrics });
		expect(await service.recordOrderFills({ environment: 'testnet', order: ORDER })).toEqual({ written: 3, duplicates: 0, failed: 0 });
		expect(await service.recordOrderFills({ environment: 'testnet', order: ORDER })).toEqual({ written: 0, duplicates: 3, failed: 0 });
		expect(mock.docs.size).toBe(3);
		expect(metrics.getSnapshot().byDomain.trades).toMatchObject({ success: 6, failure: 0 });
	});

	it('fails open and counts failures when Firestore rejects the write', async () => {
		process.env.ENABLE_TRADE_LEDGER = 'true';
		const mock = createFirestoreMock({ createImpl: async () => { throw new Error('boom'); } });
		const metrics = new FirestoreWriteMetricsService();
		const service = new TradeLedgerService({ firestore: mock.firestore, metrics });
		await expect(service.recordOrderFills({ environment: 'testnet', order: ORDER })).resolves.toEqual({ written: 0, duplicates: 0, failed: 3 });
		expect(metrics.getSnapshot().byDomain.trades).toMatchObject({ success: 0, failure: 3 });
	});

	it('lists fills for a single environment bounded by TRADE_LEDGER_MAX_SCAN', async () => {
		process.env.ENABLE_TRADE_LEDGER = 'true';
		process.env.TRADE_LEDGER_MAX_SCAN = '2';
		const mock = createFirestoreMock();
		const service = new TradeLedgerService({ firestore: mock.firestore });
		await service.recordOrderFills({ environment: 'testnet', order: ORDER });
		await service.recordOrderFills({ environment: 'live', order: ORDER });
		const result = await service.listFills({ environment: 'testnet' });
		expect(mock.queryState.where).toEqual(['environment', '==', 'testnet']);
		expect(mock.queryState.orderBy).toEqual(['filledAt', 'asc']);
		expect(result.fills).toHaveLength(2);
		expect(result.fills.every((f) => f.environment === 'testnet')).toBe(true);
		expect(result.scanTruncated).toBe(true);
	});

	it('falls back to aggregate execution fields when fills array is absent', () => {
		const records = buildFillRecords({
			environment: 'testnet',
			order: {
				symbol: 'BTCUSDT',
				side: 'BUY',
				orderId: 88,
				clientOrderId: 'cabros-test-1',
				status: 'FILLED',
				executedQty: '0.00200000',
				cummulativeQuoteQty: '100.00',
			},
		});
		expect(records).toHaveLength(1);
		expect(records[0].data.qty).toBe('0.002');
		expect(records[0].data.price).toBe('50000');
		expect(records[0].data.quoteQty).toBe('100');
		expect(records[0].data.binanceOrderId).toBe('88');
	});

	it('falls back to the default scan bound on invalid values', () => {
		process.env.TRADE_LEDGER_MAX_SCAN = 'nope';
		expect(new TradeLedgerService().getMaxScan()).toBe(5000);
		process.env.TRADE_LEDGER_MAX_SCAN = '999999';
		expect(new TradeLedgerService().getMaxScan()).toBe(5000);
	});
});
