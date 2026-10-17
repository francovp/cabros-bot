'use strict';

const { createReadinessService } = require('../lib/readiness');
const { redactString } = require('../lib/logging');

let cachedService = null;
let cachedOverrides = undefined;

// Keyed on the overrides object's identity rather than a hand-maintained
// projection of it. The previous string key had to be edited whenever an
// override was added and silently omitted `isFirestoreConfigured` /
// `getFirestoreClient`, which could return a service built for stale
// dependencies. `attachReadinessOverrides` installs exactly one object per
// process, so identity is the correct key.
function getReadinessService(overrides) {
	if (cachedService && cachedOverrides === overrides) {
		return cachedService;
	}
	cachedService = createReadinessService(overrides || {});
	cachedOverrides = overrides;
	return cachedService;
}

function resetReadinessService() {
	cachedService = null;
	cachedOverrides = undefined;
}

async function collectReadiness(overrides) {
	const service = getReadinessService(overrides);
	return service.collectReadiness();
}

/**
 * `failClosed: true`  -> degraded dependencies produce 503 (traffic-gating).
 * `failClosed: false` -> degraded dependencies still return 200 and only the
 *   body reports `ready: false`. A flaky third-party provider must never pull
 *   a healthy replica out of load-balancer rotation, so the report surface is
 *   advisory while the gate surface keeps 503 semantics.
 *
 * When `bootstrap` is supplied (the `/ready?depth=dependencies` surface), the
 * dependency verdict is ANDed with the startup gate and the bootstrap payload
 * is echoed. The dependency probe must never launder a failed or still-pending
 * bootstrap into a 200: that is the exact traffic-cutover failure the gate
 * exists to prevent.
 */
async function handleDependencyReadiness(req, res, options) {
	const startedAt = Date.now();
	const failClosed = Boolean(options && options.failClosed);
	const bootstrap = options && options.bootstrap ? options.bootstrap() : null;
	const overrides = (req && req.app && req.app.locals && req.app.locals.readinessOverrides) || undefined;
	const respond = (statusCode, body) => res.status(statusCode).json(body);
	const withBootstrap = (body) => (bootstrap
		? Object.assign({
			status: bootstrap.status,
			components: bootstrap.components,
			bootstrapReady: bootstrap.ready === true,
		}, body)
		: body);

	try {
		const report = await collectReadiness(overrides);
		const bootstrapReady = bootstrap ? bootstrap.ready === true : true;
		const ready = report.ready && bootstrapReady;
		respond(failClosed && !ready ? 503 : 200, withBootstrap({
			ready,
			failClosed,
			checkedAt: new Date(startedAt).toISOString(),
			latencyMs: Date.now() - startedAt,
			dependencies: report.dependencies,
		}));
	} catch (error) {
		respond(failClosed ? 503 : 200, withBootstrap({
			ready: false,
			failClosed,
			checkedAt: new Date(startedAt).toISOString(),
			latencyMs: Date.now() - startedAt,
			error: redactString(error && error.message ? error.message : String(error)),
		}));
	}
}

function attachReadinessOverrides(app, overrides) {
	if (!app || !app.locals) {
		return;
	}
	app.locals.readinessOverrides = overrides;
	resetReadinessService();
}

module.exports = {
	collectReadiness,
	handleDependencyReadiness,
	attachReadinessOverrides,
	getReadinessService,
	resetReadinessService,
};
