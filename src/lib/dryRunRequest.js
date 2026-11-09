'use strict';

/**
 * Canonical dry-run flag parsing for every alert-producing surface.
 *
 * The route-level idempotency bypass and the handlers must agree on exactly
 * which requests are probes. If they ever diverge, a request treated as a
 * probe by one layer and as a live request by the other either reserves
 * idempotency state for a delivery that never happens, or records a live
 * delivery as replayable. Sharing one definition removes that possibility.
 */
const DRY_RUN_ENABLED_VALUES = new Set(['true', true]);
const DRY_RUN_DISABLED_VALUES = new Set(['false', false]);

function isDryRunValue(value) {
	return DRY_RUN_ENABLED_VALUES.has(value);
}

/**
 * True when `value` is one of the four documented spellings of the flag.
 *
 * `isDryRunValue()` answers "is this a probe?", which is what the idempotency
 * bypass needs. This answers "did the caller spell it at all?", which is what a
 * strict handler needs: a value outside the documented set is a typo, and must
 * not be silently downgraded to a live request.
 */
function isRecognisedDryRunValue(value) {
	return isDryRunValue(value) || DRY_RUN_DISABLED_VALUES.has(value);
}

function resolveDryRun(req) {
	const query = req && req.query;
	const body = req && req.body;
	const queryFlag = Boolean(query) && isDryRunValue(query.dryRun);
	const bodyFlag = Boolean(body) && typeof body === 'object' && isDryRunValue(body.dryRun);
	return queryFlag || bodyFlag;
}

/**
 * Issue #745 — pre-flight cost estimation mode.
 *
 * `dryRun=cost` (or `estimate=true`) must not be silently downgraded to a live
 * request, and must not be treated as a plain `dryRun=true` probe by the
 * idempotency bypass. It is a distinct mode that returns only an estimate and
 * makes zero billable calls. `isDryRunCostValue` answers "is this a cost
 * probe?"; `isRecognisedDryRunCostValue` answers "did the caller spell a
 * cost-probe alias at all?" so handlers reject typos instead of executing.
 */
const DRY_RUN_COST_ENABLED_VALUES = new Set(['cost', 'estimate']);
const ESTIMATE_ENABLED_VALUES = new Set(['true', true]);

function isDryRunCostValue(value) {
	return typeof value === 'string' && DRY_RUN_COST_ENABLED_VALUES.has(value.trim().toLowerCase());
}

function isRecognisedDryRunCostValue(value) {
	if (value === undefined || value === null) {
		return true;
	}
	if (typeof value !== 'string') {
		return false;
	}
	const trimmed = value.trim().toLowerCase();
	return trimmed === '' || DRY_RUN_COST_ENABLED_VALUES.has(trimmed);
}

function resolveDryRunCost(req) {
	const query = req && req.query;
	const body = req && req.body;
	const queryCost = Boolean(query) && isDryRunCostValue(query.dryRun);
	const bodyCost = Boolean(body) && typeof body === 'object' && isDryRunCostValue(body.dryRun);
	const queryEstimate = Boolean(query) && ESTIMATE_ENABLED_VALUES.has(query.estimate);
	const bodyEstimate = Boolean(body) && typeof body === 'object' && ESTIMATE_ENABLED_VALUES.has(body.estimate);
	return queryCost || bodyCost || queryEstimate || bodyEstimate;
}

/**
 * True when a cost-capable request carries a `dryRun`/`estimate` spelling that
 * is neither a plain dry-run value nor a cost-probe value — e.g. `dryRun=costt`.
 * Handlers reject those with `400 INVALID_REQUEST` instead of silently
 * executing the live billable path.
 */
function hasUnrecognisedCostFlag(req) {
	const query = req && req.query;
	const body = req && req.body;
	const dryRunValues = [];
	if (query && query.dryRun !== undefined) {
		dryRunValues.push(query.dryRun);
	}
	if (body && typeof body === 'object' && body.dryRun !== undefined) {
		dryRunValues.push(body.dryRun);
	}
	for (const value of dryRunValues) {
		if (!isRecognisedDryRunValue(value) && !isDryRunCostValue(value)) {
			return true;
		}
	}
	const estimateValues = [];
	if (query && query.estimate !== undefined) {
		estimateValues.push(query.estimate);
	}
	if (body && typeof body === 'object' && body.estimate !== undefined) {
		estimateValues.push(body.estimate);
	}
	for (const value of estimateValues) {
		if (value !== true && value !== false && value !== 'true' && value !== 'false') {
			if (typeof value !== 'string' || !(value === 'cost' || value === 'estimate')) {
				return true;
			}
		}
	}
	return false;
}

module.exports = {
	isDryRunValue,
	isRecognisedDryRunValue,
	resolveDryRun,
	isDryRunCostValue,
	isRecognisedDryRunCostValue,
	resolveDryRunCost,
	hasUnrecognisedCostFlag,
};