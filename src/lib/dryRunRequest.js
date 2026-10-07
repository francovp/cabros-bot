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

function isDryRunValue(value) {
	return DRY_RUN_ENABLED_VALUES.has(value);
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
	resolveDryRun,
};