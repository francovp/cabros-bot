'use strict';

// Shared directional risk/reward math for alert enrichment (GH-599).
//
// Three call sites need the same two primitives, and previously each carried its
// own copy: the alert-handling adapter needs to decide whether a provider block is
// salvageable, and AlertStorageService needs to fill a missing ratio at persist
// time. Keeping one implementation is what makes them agree — a block the adapter
// calls complete is exactly the block storage will not recompute.

// Normalize a price-like value to a finite, strictly-positive number, or null.
// Accepts numbers and numeric strings (tolerating `$` and thousands separators,
// since providers quote `"$1,234.50"` as often as `1234.5`). Everything else —
// zero, negatives, NaN, Infinity, booleans, objects, blank strings — is null.
function toPositiveFiniteNumber(value) {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value > 0 ? value : null;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) {
			return null;
		}
		const numeric = Number(trimmed.replace(/[$,]/g, ''));
		return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
	}
	return null;
}

// Direction-aware R:R from entry, invalidation (stop), and target.
//
// Returns null — rather than a misleading number — whenever the inputs cannot
// support one: a non-positive or unparseable entry/level, an unknown side, a flat
// stop (zero risk), or levels sitting on the wrong side of entry. A BUY whose stop
// is above entry has no risk/reward to express, and silently dividing anyway is how
// a plausible-looking but inverted ratio reaches a stored alert.
function computeDeterministicRiskReward({ entry, invalidation, target, side }) {
	const entryPrice = toPositiveFiniteNumber(entry);
	const stop = toPositiveFiniteNumber(invalidation);
	const goal = toPositiveFiniteNumber(target);

	if (entryPrice === null || stop === null || goal === null) {
		return null;
	}

	const upperSide = typeof side === 'string' ? side.trim().toUpperCase() : '';
	if (upperSide === 'BUY' || upperSide === 'LONG') {
		const reward = goal - entryPrice;
		const risk = entryPrice - stop;
		if (reward > 0 && risk > 0) {
			const ratio = reward / risk;
			return Number.isFinite(ratio) ? ratio : null;
		}
		return null;
	}
	if (upperSide === 'SELL' || upperSide === 'SHORT') {
		const reward = entryPrice - goal;
		const risk = stop - entryPrice;
		if (reward > 0 && risk > 0) {
			const ratio = reward / risk;
			return Number.isFinite(ratio) ? ratio : null;
		}
		return null;
	}
	return null;
}

module.exports = {
	toPositiveFiniteNumber,
	computeDeterministicRiskReward,
};