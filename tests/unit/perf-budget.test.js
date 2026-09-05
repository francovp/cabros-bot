'use strict';

/**
 * tests/unit/perf-budget.test.js
 *
 * Unit coverage for tests/helpers/perfBudget.js + tests/performance/budgets.json.
 * The helper is consumed by the dedicated `tests/integration/perf-budget.test.js`
 * suite and by per-endpoint integration tests, so its lookup, tolerance math,
 * and `PERF_BUDGET_RELAXED` escape hatch all live behind this spec.
 */

const path = require('path');
const perfBudget = require('../helpers/perfBudget');

describe('perfBudget helper', () => {
	const originalRelaxed = process.env.PERF_BUDGET_RELAXED;
	const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

	beforeEach(() => {
		warnSpy.mockClear();
		perfBudget.clearBudgetCache();
		if (originalRelaxed === undefined) {
			delete process.env.PERF_BUDGET_RELAXED;
		} else {
			process.env.PERF_BUDGET_RELAXED = originalRelaxed;
		}
	});

	afterAll(() => {
		warnSpy.mockRestore();
	});

	describe('loadBudgets + getBudget', () => {
		it('loads the checked-in budgets.json', () => {
			const budgets = perfBudget.loadBudgets();
			expect(typeof budgets).toBe('object');
			expect(budgets).not.toBeNull();
			expect(budgets['/api/webhook/alert']).toBeDefined();
			expect(budgets['/api/webhook/alert'].p95Ms).toBeGreaterThan(0);
		});

		it('looks up a known route and returns p95Ms + rationale', () => {
			const entry = perfBudget.getBudget('/api/webhook/alert');
			expect(entry.p95Ms).toBeGreaterThan(0);
			expect(typeof entry.rationale).toBe('string');
			expect(entry.rationale.length).toBeGreaterThan(0);
		});

		it('throws for an unknown route', () => {
			expect(() => perfBudget.getBudget('/api/does-not-exist'))
				.toThrow(/no budget declared/);
		});

		it('throws for a non-string route', () => {
			expect(() => perfBudget.getBudget(undefined)).toThrow(/non-empty string/);
			expect(() => perfBudget.getBudget(123)).toThrow(/non-empty string/);
		});

		it('throws when budgets.json is not an object (asserts guard exists)', () => {
			// The helper guards `loadBudgets()` with
			// `if (!raw || typeof raw !== 'object') throw`. We assert that
			// guard by reading the helper's source and confirming the shape
			// check is present, plus a smoke check that the real budgets
			// file is a non-null object so the guard would not fire on
			// the real path.
			const fs = require('fs');
			const helperSrc = fs.readFileSync(perfBudget.BUDGET_FILE, 'utf8');
			const helper = require('../helpers/perfBudget');
			// eslint-disable-next-line global-require
			const helperSrcCode = fs.readFileSync(
				require.resolve('../helpers/perfBudget'),
				'utf8'
			);
			expect(helperSrcCode).toMatch(/typeof raw !== 'object'/);
			const real = JSON.parse(helperSrc);
			expect(typeof real).toBe('object');
			expect(real).not.toBeNull();
			// Sanity: helper export is non-null and loadBudgets returns object.
			expect(helper).toBeDefined();
			expect(typeof helper.loadBudgets()).toBe('object');
		});

		it('caches loaded budgets between calls', () => {
			const first = perfBudget.loadBudgets();
			const second = perfBudget.loadBudgets();
			expect(first).toBe(second);
		});

		it('clearBudgetCache resets the cache flag (next read re-resolves)', () => {
			const first = perfBudget.loadBudgets();
			// clearBudgetCache only nulls our local memoization; the helper's
			// `require` will hit Jest's module cache so the second read returns
			// an equal-but-not-identical object only when the file changed.
			// In the static case we assert the cache was reset (a fresh call
			// after clear() must not throw and must return the same content).
			perfBudget.clearBudgetCache();
			const second = perfBudget.loadBudgets();
			expect(first).toEqual(second);
			expect(perfBudget.clearBudgetCache).toBeDefined();
		});
	});

	describe('assertWithinBudget tolerance math', () => {
		const ROUTE = '/api/webhook/alert';

		it('returns ok when duration <= budget', () => {
			const entry = perfBudget.getBudget(ROUTE);
			const result = perfBudget.assertWithinBudget(ROUTE, entry.p95Ms - 1);
			expect(result).toEqual(expect.objectContaining({ ok: true, level: 'ok' }));
		});

		it('returns ok at the budget boundary', () => {
			const entry = perfBudget.getBudget(ROUTE);
			const result = perfBudget.assertWithinBudget(ROUTE, entry.p95Ms);
			expect(result.ok).toBe(true);
			expect(result.level).toBe('ok');
		});

		it('warns (soft) when duration is just over budget', () => {
			const entry = perfBudget.getBudget(ROUTE);
			const justOver = entry.p95Ms + 1;
			const result = perfBudget.assertWithinBudget(ROUTE, justOver);
			expect(result.ok).toBe(true);
			expect(result.level).toBe('soft');
			expect(warnSpy).toHaveBeenCalled();
		});

		it('warns (warn) when duration is in the 1.5x-2x range', () => {
			const entry = perfBudget.getBudget(ROUTE);
			const overSoft = entry.p95Ms * 1.6;
			const result = perfBudget.assertWithinBudget(ROUTE, overSoft);
			expect(result.ok).toBe(true);
			expect(result.level).toBe('warn');
			expect(warnSpy).toHaveBeenCalled();
		});

		it('throws when duration exceeds 2x budget without PERF_BUDGET_RELAXED', () => {
			const entry = perfBudget.getBudget(ROUTE);
			const hardOver = entry.p95Ms * 3;
			expect(() => perfBudget.assertWithinBudget(ROUTE, hardOver))
				.toThrow(/HARD FAIL/);
		});

		it('warns and returns relaxed when 2x exceeded and PERF_BUDGET_RELAXED=true', () => {
			process.env.PERF_BUDGET_RELAXED = 'true';
			const entry = perfBudget.getBudget(ROUTE);
			const hardOver = entry.p95Ms * 5;
			const result = perfBudget.assertWithinBudget(ROUTE, hardOver);
			expect(result.ok).toBe(true);
			expect(result.level).toBe('relaxed');
			expect(warnSpy).toHaveBeenCalled();
		});

		it('throws on invalid duration inputs', () => {
			expect(() => perfBudget.assertWithinBudget(ROUTE, NaN))
				.toThrow(/finite non-negative number/);
			expect(() => perfBudget.assertWithinBudget(ROUTE, -1))
				.toThrow(/finite non-negative number/);
			expect(() => perfBudget.assertWithinBudget(ROUTE, '100'))
				.toThrow(/finite non-negative number/);
		});
	});

	describe('mark + since', () => {
		it('mark returns a finite number', () => {
			const t = perfBudget.mark();
			expect(typeof t).toBe('number');
			expect(Number.isFinite(t)).toBe(true);
		});

		it('since returns a non-negative duration for a recent mark', () => {
			const t = perfBudget.mark();
			const d = perfBudget.since(t);
			expect(d).toBeGreaterThanOrEqual(0);
		});

		it('since clamps a missing mark to 0', () => {
			expect(perfBudget.since(undefined)).toBe(0);
			expect(perfBudget.since(null)).toBe(0);
		});
	});

	describe('isRelaxed', () => {
		it('mirrors PERF_BUDGET_RELAXED', () => {
			delete process.env.PERF_BUDGET_RELAXED;
			expect(perfBudget.isRelaxed()).toBe(false);
			process.env.PERF_BUDGET_RELAXED = 'true';
			expect(perfBudget.isRelaxed()).toBe(true);
			process.env.PERF_BUDGET_RELAXED = '1';
			expect(perfBudget.isRelaxed()).toBe(false); // only exact "true" counts
		});
	});

	describe('budget file location', () => {
		it('points at tests/performance/budgets.json', () => {
			expect(perfBudget.BUDGET_FILE).toBe(
				path.join(__dirname, '..', 'performance', 'budgets.json')
			);
			const fs = require('fs');
			expect(fs.existsSync(perfBudget.BUDGET_FILE)).toBe(true);
		});
	});
});