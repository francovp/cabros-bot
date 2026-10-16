'use strict';

/**
 * Pure FIFO lot-matching and P&L engine for the durable trade ledger (#1275).
 *
 * All money/quantity math uses BigInt fixed-point (18 decimals) so ledger
 * summaries never accumulate float drift. Inputs and outputs are decimal
 * strings. The engine never mixes environments: callers must pass fills from a
 * single environment and `matchFifo` throws otherwise.
 */

const DECIMALS = 18;
const SCALE = 10n ** BigInt(DECIMALS);
const RATIO_DP = 8;
const PCT_DP = 4;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

function toUnits(value) {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return null;
		value = String(value);
	}
	if (typeof value !== 'string') return null;
	const str = value.trim();
	if (!DECIMAL_PATTERN.test(str)) return null;
	const negative = str.startsWith('-');
	const [whole, frac = ''] = (negative ? str.slice(1) : str).split('.');
	const units = BigInt(whole) * SCALE + BigInt((frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS));
	return negative ? -units : units;
}

function fromUnits(units, maxDp = DECIMALS) {
	if (units === null || units === undefined) return null;
	const negative = units < 0n;
	const abs = negative ? -units : units;
	const whole = abs / SCALE;
	let frac = (abs % SCALE).toString().padStart(DECIMALS, '0').slice(0, maxDp).replace(/0+$/, '');
	const body = frac ? `${whole}.${frac}` : `${whole}`;
	return negative && body !== '0' ? `-${body}` : body;
}

const mul = (a, b) => (a * b) / SCALE;
const div = (a, b) => (a * SCALE) / b;
const prorate = (amount, part, whole) => (whole === 0n ? 0n : (amount * part) / whole);
const units = (value) => toUnits(value) ?? 0n;

function toMs(value) {
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? 0 : ms;
}

function dayKey(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

function sortFills(fills) {
	return [...fills].sort((a, b) => (toMs(a.filledAt) - toMs(b.filledAt))
		|| (Number(a.tradeId) - Number(b.tradeId)));
}

/**
 * Match BUY lots against SELL fills (FIFO, per symbol). Fills from the same
 * SELL order are grouped into one closed round-trip.
 */
function matchFifo(fills = []) {
	const environments = new Set(fills.map((f) => f.environment));
	if (environments.size > 1) {
		throw new Error('matchFifo received fills from more than one environment');
	}

	const seen = new Set();
	const lotsBySymbol = new Map();
	const tripsByKey = new Map();
	const unmatched = new Map();

	for (const f of sortFills(fills)) {
		const dedupeKey = `${f.symbol}:${f.tradeId}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);

		const qty = units(f.qty);
		const gross = units(f.quoteQty);
		const feeKnown = f.commissionQuote !== null && f.commissionQuote !== undefined
			&& toUnits(f.commissionQuote) !== null;
		const feeQuote = feeKnown ? toUnits(f.commissionQuote) : 0n;
		const feeInBase = Boolean(f.baseAsset) && f.commissionAsset === f.baseAsset;
		const filledMs = toMs(f.filledAt);
		if (qty <= 0n) continue;

		if (!lotsBySymbol.has(f.symbol)) lotsBySymbol.set(f.symbol, []);
		const lots = lotsBySymbol.get(f.symbol);

		if (f.side === 'BUY') {
			const lotQty = feeInBase ? qty - units(f.commission) : qty;
			if (lotQty <= 0n) continue;
			lots.push({
				symbol: f.symbol,
				qty: lotQty,
				cost: feeInBase ? gross : gross + feeQuote,
				gross,
				feeQuote,
				feesComplete: feeKnown,
				filledMs,
				alertId: f.alertId || null,
				origin: f.origin || 'manual',
				setupType: f.setupType || null,
				invalidationLevel: f.invalidationLevel ?? null,
				tradeId: f.tradeId,
				binanceOrderId: f.binanceOrderId ?? null,
			});
			continue;
		}

		if (f.side !== 'SELL') continue;
		let remaining = qty;
		let matched = 0n;
		const pieces = [];
		while (remaining > 0n && lots.length > 0) {
			const lot = lots[0];
			const take = remaining < lot.qty ? remaining : lot.qty;
			const piece = {
				qty: take,
				cost: prorate(lot.cost, take, lot.qty),
				gross: prorate(lot.gross, take, lot.qty),
				fee: prorate(lot.feeQuote, take, lot.qty),
				lot,
			};
			lot.cost -= piece.cost;
			lot.gross -= piece.gross;
			lot.feeQuote -= piece.fee;
			lot.qty -= take;
			remaining -= take;
			matched += take;
			pieces.push(piece);
			if (lot.qty === 0n) lots.shift();
		}
		if (remaining > 0n) {
			unmatched.set(f.symbol, (unmatched.get(f.symbol) || 0n) + remaining);
		}
		if (matched === 0n) continue;

		const tripKey = `${f.symbol}:${f.binanceOrderId ?? f.tradeId}`;
		let trip = tripsByKey.get(tripKey);
		if (!trip) {
			trip = {
				id: tripKey,
				symbol: f.symbol,
				environment: f.environment,
				exitOrderId: f.binanceOrderId ?? null,
				exitOrigin: f.origin || 'manual',
				qty: 0n,
				costBasis: 0n,
				entryGross: 0n,
				exitGross: 0n,
				proceeds: 0n,
				fees: 0n,
				feesComplete: true,
				entryMs: Infinity,
				exitMs: 0,
				alertIds: new Set(),
				origins: new Set(),
				setupType: null,
				invalidationLevel: null,
			};
			tripsByKey.set(tripKey, trip);
		}
		const exitGross = prorate(gross, matched, qty);
		const exitFee = prorate(feeQuote, matched, qty);
		trip.qty += matched;
		trip.exitGross += exitGross;
		trip.proceeds += exitGross - exitFee;
		trip.fees += exitFee;
		trip.feesComplete = trip.feesComplete && feeKnown;
		trip.exitMs = Math.max(trip.exitMs, filledMs);
		if (f.alertId) trip.alertIds.add(f.alertId);
		for (const piece of pieces) {
			trip.costBasis += piece.cost;
			trip.entryGross += piece.gross;
			trip.fees += piece.fee;
			trip.feesComplete = trip.feesComplete && piece.lot.feesComplete;
			trip.entryMs = Math.min(trip.entryMs, piece.lot.filledMs);
			if (piece.lot.alertId) trip.alertIds.add(piece.lot.alertId);
			if (piece.lot.origin) trip.origins.add(piece.lot.origin);
			trip.setupType = trip.setupType || piece.lot.setupType;
			trip.invalidationLevel = trip.invalidationLevel ?? piece.lot.invalidationLevel;
		}
	}

	const roundTrips = [...tripsByKey.values()].map(formatTrip);
	const openLots = [];
	for (const lots of lotsBySymbol.values()) {
		for (const lot of lots) {
			openLots.push({
				symbol: lot.symbol,
				qty: fromUnits(lot.qty),
				cost: fromUnits(lot.cost),
				entryGross: fromUnits(lot.gross),
				feesComplete: lot.feesComplete,
				filledAt: new Date(lot.filledMs).toISOString(),
				alertId: lot.alertId,
				origin: lot.origin,
				tradeId: lot.tradeId,
				binanceOrderId: lot.binanceOrderId,
			});
		}
	}
	const unmatchedSellQty = Object.fromEntries([...unmatched].map(([s, q]) => [s, fromUnits(q)]));
	return { roundTrips, openLots, unmatchedSellQty };
}

function formatTrip(trip) {
	let origin;
	if (trip.origins && trip.origins.size === 1) {
		origin = [...trip.origins][0];
	} else if (trip.origins && trip.origins.size > 1) {
		origin = 'mixed';
	} else {
		origin = trip.origin || trip.exitOrigin || 'manual';
	}
	const realized = trip.proceeds - trip.costBasis;
	const entryPrice = div(trip.entryGross, trip.qty);
	const exitPrice = div(trip.exitGross, trip.qty);
	let rMultiple = null;
	const invalidation = toUnits(trip.invalidationLevel);
	if (invalidation !== null && entryPrice > invalidation) {
		rMultiple = fromUnits(div(exitPrice - entryPrice, entryPrice - invalidation), PCT_DP);
	}
	return {
		id: trip.id,
		environment: trip.environment,
		symbol: trip.symbol,
		origin,
		setupType: trip.setupType || 'unknown',
		exitOrderId: trip.exitOrderId,
		qty: fromUnits(trip.qty),
		entryPrice: fromUnits(entryPrice, RATIO_DP),
		exitPrice: fromUnits(exitPrice, RATIO_DP),
		costBasis: fromUnits(trip.costBasis),
		proceeds: fromUnits(trip.proceeds),
		fees: fromUnits(trip.fees),
		feesComplete: trip.feesComplete,
		realizedPnl: fromUnits(realized),
		roiPct: trip.costBasis > 0n ? fromUnits(div(realized * 100n, trip.costBasis), PCT_DP) : null,
		rMultiple,
		entryAt: new Date(trip.entryMs).toISOString(),
		exitAt: new Date(trip.exitMs).toISOString(),
		holdMs: trip.exitMs - trip.entryMs,
		alertIds: [...trip.alertIds],
	};
}

function buildPositions(openLots = [], markPrices = {}) {
	const bySymbol = new Map();
	for (const lot of openLots) {
		let pos = bySymbol.get(lot.symbol);
		if (!pos) {
			pos = { symbol: lot.symbol, qty: 0n, cost: 0n, gross: 0n, lots: 0, alertIds: new Set(), feesComplete: true };
			bySymbol.set(lot.symbol, pos);
		}
		pos.qty += units(lot.qty);
		pos.cost += units(lot.cost);
		pos.gross += units(lot.entryGross);
		pos.lots += 1;
		pos.feesComplete = pos.feesComplete && lot.feesComplete !== false;
		if (lot.alertId) pos.alertIds.add(lot.alertId);
	}
	return [...bySymbol.values()]
		.filter((pos) => pos.qty > 0n)
		.sort((a, b) => a.symbol.localeCompare(b.symbol))
		.map((pos) => {
			const mark = toUnits(markPrices[pos.symbol]);
			return {
				symbol: pos.symbol,
				qty: fromUnits(pos.qty),
				lotCount: pos.lots,
				costBasis: fromUnits(pos.cost),
				avgEntryPrice: fromUnits(div(pos.cost, pos.qty), RATIO_DP),
				markPrice: mark === null ? null : fromUnits(mark),
				unrealizedPnl: mark === null ? null : fromUnits(mul(mark, pos.qty) - pos.cost),
				feesComplete: pos.feesComplete,
				alertIds: [...pos.alertIds],
			};
		});
}

const GROUP_KEYS = {
	symbol: (t) => t.symbol,
	origin: (t) => t.origin,
	setupType: (t) => t.setupType || 'unknown',
	day: (t) => t.exitAt.slice(0, 10),
};

function aggregate(trips) {
	let realized = 0n;
	let cost = 0n;
	let fees = 0n;
	let wins = 0;
	for (const t of trips) {
		realized += units(t.realizedPnl);
		cost += units(t.costBasis);
		fees += units(t.fees);
		if (units(t.realizedPnl) > 0n) wins += 1;
	}
	return {
		tradeCount: trips.length,
		realizedPnl: fromUnits(realized),
		costBasisClosed: fromUnits(cost),
		roiPct: cost > 0n ? fromUnits(div(realized * 100n, cost), PCT_DP) : null,
		winRate: trips.length ? wins / trips.length : null,
		totalFees: fromUnits(fees),
	};
}

function summarize({ roundTrips = [], positions = [], groupBy = null } = {}) {
	const trips = [...roundTrips].sort((a, b) => toMs(a.exitAt) - toMs(b.exitAt));
	const base = aggregate(trips);

	let grossProfit = 0n;
	let grossLoss = 0n;
	let cumulative = 0n;
	let peak = 0n;
	let maxDrawdown = 0n;
	const daily = new Map();
	for (const t of trips) {
		const pnl = units(t.realizedPnl);
		if (pnl > 0n) grossProfit += pnl; else grossLoss -= pnl;
		cumulative += pnl;
		if (cumulative > peak) peak = cumulative;
		if (peak - cumulative > maxDrawdown) maxDrawdown = peak - cumulative;
		const day = dayKey(toMs(t.exitAt));
		daily.set(day, (daily.get(day) || 0n) + pnl);
	}

	let running = 0n;
	const equitySeries = [...daily.entries()].map(([date, pnl]) => {
		running += pnl;
		return { date, realizedPnl: fromUnits(pnl), cumulativePnl: fromUnits(running) };
	});

	const unrealizedKnown = positions.every((p) => p.unrealizedPnl !== null);
	const unrealizedPnl = unrealizedKnown
		? fromUnits(positions.reduce((sum, p) => sum + units(p.unrealizedPnl), 0n))
		: null;

	const summary = {
		...base,
		unrealizedPnl,
		profitFactor: grossLoss > 0n ? fromUnits(div(grossProfit, grossLoss), PCT_DP) : null,
		avgHoldMs: trips.length ? Math.round(trips.reduce((s, t) => s + t.holdMs, 0) / trips.length) : null,
		maxDrawdown: fromUnits(maxDrawdown),
		feesComplete: trips.every((t) => t.feesComplete !== false),
		openPositionCount: positions.length,
		equitySeries,
	};

	if (groupBy && GROUP_KEYS[groupBy]) {
		const buckets = new Map();
		for (const t of trips) {
			const key = GROUP_KEYS[groupBy](t);
			if (!buckets.has(key)) buckets.set(key, []);
			buckets.get(key).push(t);
		}
		summary.groupBy = groupBy;
		summary.groups = [...buckets.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, group]) => ({ key, ...aggregate(group) }));
	}
	return summary;
}

module.exports = {
	GROUP_BY_VALUES: Object.keys(GROUP_KEYS),
	toUnits,
	fromUnits,
	matchFifo,
	buildPositions,
	summarize,
};
