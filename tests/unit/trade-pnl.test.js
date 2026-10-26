'use strict';

const {
	toUnits,
	fromUnits,
	matchFifo,
	buildPositions,
	summarize,
} = require('../../src/services/trading/tradePnl');

function fill(overrides) {
	return {
		environment: 'testnet',
		symbol: 'BTCUSDT',
		baseAsset: 'BTC',
		quoteAsset: 'USDT',
		side: 'BUY',
		price: '100',
		qty: '1',
		quoteQty: '100',
		commission: '0',
		commissionAsset: 'USDT',
		commissionQuote: '0',
		binanceOrderId: '1',
		clientOrderId: 'c1',
		alertId: null,
		origin: 'manual',
		filledAt: '2026-10-01T00:00:00.000Z',
		tradeId: 1,
		...overrides,
	};
}

describe('tradePnl decimal helpers', () => {
	it('round-trips decimal strings without float drift', () => {
		expect(fromUnits(toUnits('0.1') + toUnits('0.2'))).toBe('0.3');
		expect(fromUnits(toUnits('-1.50'))).toBe('-1.5');
		expect(fromUnits(toUnits('42'))).toBe('42');
	});

	it('rejects non-decimal input', () => {
		expect(toUnits('abc')).toBeNull();
		expect(toUnits('1e5')).toBeNull();
		expect(toUnits(undefined)).toBeNull();
	});
});

describe('matchFifo', () => {
	it('turns a MARKET BUY then SELL into one round-trip with realized P&L net of fees', () => {
		const { roundTrips, openLots } = matchFifo([
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', commission: '0.1', commissionQuote: '0.1', binanceOrderId: '1', tradeId: 1 }),
			fill({ side: 'SELL', price: '110', qty: '1', quoteQty: '110', commission: '0.11', commissionQuote: '0.11', binanceOrderId: '2', tradeId: 2, filledAt: '2026-10-01T01:00:00.000Z' }),
		]);
		expect(roundTrips).toHaveLength(1);
		const [rt] = roundTrips;
		expect(rt.qty).toBe('1');
		expect(rt.costBasis).toBe('100.1');
		expect(rt.proceeds).toBe('109.89');
		expect(rt.realizedPnl).toBe('9.79');
		expect(rt.fees).toBe('0.21');
		expect(rt.holdMs).toBe(3600000);
		expect(rt.entryPrice).toBe('100');
		expect(rt.exitPrice).toBe('110');
		expect(openLots).toHaveLength(0);
	});

	it('splits lots FIFO on partial sells', () => {
		const { roundTrips, openLots } = matchFifo([
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', binanceOrderId: '1', tradeId: 1 }),
			fill({ side: 'BUY', price: '200', qty: '1', quoteQty: '200', binanceOrderId: '2', tradeId: 2, filledAt: '2026-10-01T00:30:00.000Z' }),
			fill({ side: 'SELL', price: '150', qty: '1.5', quoteQty: '225', binanceOrderId: '3', tradeId: 3, filledAt: '2026-10-01T01:00:00.000Z' }),
		]);
		expect(roundTrips).toHaveLength(1);
		// cost = 100 (lot1) + 0.5 * 200 (half of lot2) = 200; proceeds 225
		expect(roundTrips[0].costBasis).toBe('200');
		expect(roundTrips[0].realizedPnl).toBe('25');
		expect(openLots).toHaveLength(1);
		expect(openLots[0].qty).toBe('0.5');
		expect(openLots[0].cost).toBe('100');
	});

	it('groups multiple fills of the same SELL order into one round-trip', () => {
		const { roundTrips } = matchFifo([
			fill({ side: 'BUY', qty: '2', quoteQty: '200', binanceOrderId: '1', tradeId: 1 }),
			fill({ side: 'SELL', price: '120', qty: '1', quoteQty: '120', binanceOrderId: '9', tradeId: 2, filledAt: '2026-10-01T02:00:00.000Z' }),
			fill({ side: 'SELL', price: '130', qty: '1', quoteQty: '130', binanceOrderId: '9', tradeId: 3, filledAt: '2026-10-01T02:00:00.000Z' }),
		]);
		expect(roundTrips).toHaveLength(1);
		expect(roundTrips[0].realizedPnl).toBe('50');
		expect(roundTrips[0].exitPrice).toBe('125');
	});

	it('reduces lot quantity when the BUY commission is charged in the base asset', () => {
		const { openLots } = matchFifo([
			fill({ side: 'BUY', qty: '1', quoteQty: '100', commission: '0.001', commissionAsset: 'BTC', commissionQuote: '0.1' }),
		]);
		expect(openLots[0].qty).toBe('0.999');
		expect(openLots[0].cost).toBe('100');
	});

	it('ignores duplicate tradeIds so replays never double-count', () => {
		const buy = fill({ side: 'BUY' });
		const { openLots } = matchFifo([buy, { ...buy }]);
		expect(openLots).toHaveLength(1);
		expect(openLots[0].qty).toBe('1');
	});

	it('reports unmatched sell quantity instead of inventing cost basis', () => {
		const { roundTrips, unmatchedSellQty } = matchFifo([
			fill({ side: 'SELL', qty: '1', quoteQty: '100', binanceOrderId: '5' }),
		]);
		expect(roundTrips).toHaveLength(0);
		expect(unmatchedSellQty).toEqual({ BTCUSDT: '1' });
	});

	it('flags round-trips whose fees could not be converted to the quote asset', () => {
		const { roundTrips } = matchFifo([
			fill({ side: 'BUY', commission: '0.0001', commissionAsset: 'BNB', commissionQuote: null }),
			fill({ side: 'SELL', binanceOrderId: '2', tradeId: 2, filledAt: '2026-10-01T01:00:00.000Z' }),
		]);
		expect(roundTrips[0].feesComplete).toBe(false);
	});

	it('throws when environments are mixed', () => {
		expect(() => matchFifo([fill({}), fill({ environment: 'live', tradeId: 2 })])).toThrow(/environment/);
	});
});

describe('buildPositions', () => {
	it('aggregates open lots per symbol and applies the mark price', () => {
		const { openLots } = matchFifo([
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', alertId: 'a1', tradeId: 1 }),
			fill({ side: 'BUY', price: '200', qty: '1', quoteQty: '200', alertId: 'a2', tradeId: 2, binanceOrderId: '2' }),
		]);
		const [pos] = buildPositions(openLots, { BTCUSDT: '160' });
		expect(pos.qty).toBe('2');
		expect(pos.costBasis).toBe('300');
		expect(pos.avgEntryPrice).toBe('150');
		expect(pos.markPrice).toBe('160');
		expect(pos.unrealizedPnl).toBe('20');
		expect(pos.alertIds).toEqual(['a1', 'a2']);
	});

	it('fails open with null unrealized P&L when no mark price is available', () => {
		const { openLots } = matchFifo([fill({})]);
		const [pos] = buildPositions(openLots, {});
		expect(pos.markPrice).toBeNull();
		expect(pos.unrealizedPnl).toBeNull();
	});
});

describe('summarize', () => {
	const fills = [
		fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', tradeId: 1, binanceOrderId: '1', origin: 'manual' }),
		fill({ side: 'SELL', price: '120', qty: '1', quoteQty: '120', tradeId: 2, binanceOrderId: '2', filledAt: '2026-10-01T01:00:00.000Z' }),
		fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', tradeId: 3, binanceOrderId: '3', filledAt: '2026-10-02T00:00:00.000Z', origin: 'auto_trade' }),
		fill({ side: 'SELL', price: '90', qty: '1', quoteQty: '90', tradeId: 4, binanceOrderId: '4', filledAt: '2026-10-02T02:00:00.000Z', origin: 'auto_trade' }),
	];

	it('computes realized P&L, ROI, win rate, profit factor and drawdown', () => {
		const { roundTrips, openLots } = matchFifo(fills);
		const summary = summarize({ roundTrips, positions: buildPositions(openLots, {}) });
		expect(summary.tradeCount).toBe(2);
		expect(summary.realizedPnl).toBe('10');
		expect(summary.roiPct).toBe('5');
		expect(summary.winRate).toBe(0.5);
		expect(summary.profitFactor).toBe('2');
		expect(summary.maxDrawdown).toBe('10');
		expect(summary.unrealizedPnl).toBe('0');
		expect(summary.equitySeries).toEqual([
			{ date: '2026-10-01', realizedPnl: '20', cumulativePnl: '20' },
			{ date: '2026-10-02', realizedPnl: '-10', cumulativePnl: '10' },
		]);
	});

	it('groups by origin and day', () => {
		const { roundTrips } = matchFifo(fills);
		const byOrigin = summarize({ roundTrips, positions: [], groupBy: 'origin' });
		expect(byOrigin.groups.map((g) => [g.key, g.realizedPnl])).toEqual([
			['auto_trade', '-10'],
			['manual', '20'],
		]);
		const byDay = summarize({ roundTrips, positions: [], groupBy: 'day' });
		expect(byDay.groups.map((g) => g.key)).toEqual(['2026-10-01', '2026-10-02']);
	});

	it('attributes realized trades to their opening lots rather than closing order origin', () => {
		const autoBuyManualSell = [
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', tradeId: 10, binanceOrderId: '10', origin: 'auto_trade' }),
			fill({ side: 'SELL', price: '120', qty: '1', quoteQty: '120', tradeId: 11, binanceOrderId: '11', origin: 'manual', filledAt: '2026-10-03T01:00:00.000Z' }),
		];
		const { roundTrips } = matchFifo(autoBuyManualSell);
		expect(roundTrips).toHaveLength(1);
		expect(roundTrips[0].origin).toBe('auto_trade');
		const byOrigin = summarize({ roundTrips, positions: [], groupBy: 'origin' });
		expect(byOrigin.groups.map((g) => [g.key, g.realizedPnl])).toEqual([['auto_trade', '20']]);
	});

	it('assigns mixed origin when a closing order spans lots with different origins', () => {
		const mixedFills = [
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', tradeId: 20, binanceOrderId: '20', origin: 'auto_trade' }),
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', tradeId: 21, binanceOrderId: '21', origin: 'manual' }),
			fill({ side: 'SELL', price: '110', qty: '2', quoteQty: '220', tradeId: 22, binanceOrderId: '22', origin: 'manual', filledAt: '2026-10-03T02:00:00.000Z' }),
		];
		const { roundTrips } = matchFifo(mixedFills);
		expect(roundTrips).toHaveLength(1);
		expect(roundTrips[0].origin).toBe('mixed');
		const byOrigin = summarize({ roundTrips, positions: [], groupBy: 'origin' });
		expect(byOrigin.groups.map((g) => [g.key, g.realizedPnl])).toEqual([['mixed', '20']]);
	});

	it('assigns mixed setupType when a closing order spans lots with different setups', () => {
		const mixedSetups = [
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', tradeId: 30, binanceOrderId: '30', setupType: 'breakout' }),
			fill({ side: 'BUY', price: '100', qty: '1', quoteQty: '100', tradeId: 31, binanceOrderId: '31', setupType: 'pullback' }),
			fill({ side: 'SELL', price: '110', qty: '2', quoteQty: '220', tradeId: 32, binanceOrderId: '32', filledAt: '2026-10-03T03:00:00.000Z' }),
		];
		const { roundTrips } = matchFifo(mixedSetups);
		expect(roundTrips).toHaveLength(1);
		expect(roundTrips[0].setupType).toBe('mixed');
		const bySetup = summarize({ roundTrips, positions: [], groupBy: 'setupType' });
		expect(bySetup.groups.map((g) => [g.key, g.realizedPnl])).toEqual([['mixed', '20']]);
	});

	it('returns null ROI and profit factor when there is no denominator', () => {
		const summary = summarize({ roundTrips: [], positions: [] });
		expect(summary.roiPct).toBeNull();
		expect(summary.profitFactor).toBeNull();
		expect(summary.winRate).toBeNull();
	});
});
