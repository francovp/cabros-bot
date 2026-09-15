'use strict';

/**
 * tests/helpers/perfBudget.js
 *
 * Lightweight per-endpoint latency-budget helper used by integration tests
 * and the dedicated `tests/integration/perf-budget.test.js` suite.
 *
 * Budgets live in `tests/performance/budgets.json`. This helper centralizes
 * lookup, soft/hard tolerance math, and the
 * `process.env.PERF_BUDGET_RELAXED` escape hatch so individual specs do
 * not reimplement the math.
 *
 * - Soft tolerance: 1.5x - a 50% regression on a quiet runner trips a
 *   `console.warn` but does not fail.
 * - Hard tolerance: 2x - anything worse fails the test unless
 *   `PERF_BUDGET_RELAXED=true` is set, in which case it short-circuits to
 *   a warning at any multiple (used by slow CI runners).
 */

const path = require('path');

const BUDGET_FILE = path.join(__dirname, '..', 'performance', 'budgets.json');

let cachedBudgets = null;

function loadBudgets() {
	if (cachedBudgets) return cachedBudgets;
	// eslint-disable-next-line global-require
	const raw = require(BUDGET_FILE);
	if (!raw || typeof raw !== 'object') {
		throw new Error('perfBudget: budgets.json must be an object, got ' + typeof raw);
	}
	cachedBudgets = raw;
	return cachedBudgets;
}

function clearBudgetCache() {
	cachedBudgets = null;
}

function getBudget(route) {
	if (!route || typeof route !== 'string') {
		throw new Error('perfBudget.getBudget(route) requires a non-empty string, got ' + route);
	}
	const budgets = loadBudgets();
	const entry = budgets[route];
	if (!entry) {
		throw new Error(
			'perfBudget: no budget declared for route "' + route + '". Add it to tests/performance/budgets.json.'
		);
	}
	if (typeof entry.p95Ms !== 'number' || !Number.isFinite(entry.p95Ms) || entry.p95Ms <= 0) {
		throw new Error(
			'perfBudget: route "' + route + '" budget.p95Ms must be a positive finite number, got ' + entry.p95Ms
		);
	}
	return entry;
}

function isRelaxed() {
	return process.env.PERF_BUDGET_RELAXED === 'true';
}

/**
 * Throws when `durationMs` exceeds the declared p95 budget for `route`.
 *
 * - soft (1.5x budget): console.warn, returns ok.
 * - hard (2x budget): throws unless `PERF_BUDGET_RELAXED=true`.
 */
function assertWithinBudget(route, durationMs) {
	if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
		throw new Error(
			'perfBudget.assertWithinBudget: durationMs must be a finite non-negative number, got ' + durationMs
		);
	}
	const entry = getBudget(route);
	const budget = entry.p95Ms;
	const softLimit = budget * 1.5;
	const hardLimit = budget * 2;

	if (durationMs <= budget) {
		return { ok: true, level: 'ok', budget: entry.p95Ms, durationMs };
	}
	if (durationMs <= softLimit) {
		const msg = '[perfBudget] soft-fail: route="' + route + '" duration=' + durationMs + 'ms budget=' + budget + 'ms (rationale: ' + (entry.rationale || 'n/a') + ')';
		if (typeof console !== 'undefined' && console.warn) console.warn(msg);
		return { ok: true, level: 'soft', budget: entry.p95Ms, durationMs };
	}
	if (durationMs <= hardLimit) {
		const msg = '[perfBudget] hard-soft: route="' + route + '" duration=' + durationMs + 'ms exceeds 1.5x soft envelope (' + softLimit + 'ms) but within 2x hard limit (' + hardLimit + 'ms; rationale: ' + (entry.rationale || 'n/a') + ')';
		if (typeof console !== 'undefined' && console.warn) console.warn(msg);
		return { ok: true, level: 'warn', budget: entry.p95Ms, durationMs };
	}
	const msg = '[perfBudget] HARD FAIL: route="' + route + '" duration=' + durationMs + 'ms exceeds 2x budget (' + hardLimit + 'ms; rationale: ' + (entry.rationale || 'n/a') + ')';
	if (isRelaxed()) {
		if (typeof console !== 'undefined' && console.warn) console.warn('[perfBudget] relaxed: ' + msg);
		return { ok: true, level: 'relaxed', budget: entry.p95Ms, durationMs };
	}
	throw new Error(msg);
}

/**
 * Wall-clock mark. Pair with `since(mark)` to measure an interval that
 * is not a `request(app)` call (e.g. middleware-only paths).
 */
function mark() {
	if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
		return performance.now();
	}
	return Date.now();
}

function sinceFn(startMark) {
	if (typeof startMark !== 'number' || !Number.isFinite(startMark)) {
		return 0;
	}
	const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
	return Math.max(0, now - startMark);
}

module.exports = {
	BUDGET_FILE,
	loadBudgets,
	clearBudgetCache,
	getBudget,
	assertWithinBudget,
	mark,
	since: sinceFn,
	isRelaxed,
};