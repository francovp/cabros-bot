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

module.exports = {
	isDryRunValue,
	isRecognisedDryRunValue,
	resolveDryRun,
};