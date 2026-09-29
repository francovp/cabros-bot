'use strict';

const { createReadinessService } = require('../lib/readiness');

let cachedService = null;
let cachedServiceKey = null;

function buildServiceKey(overrides) {
	if (!overrides) {
		return 'default';
	}
	return [
		overrides.timeoutMs === undefined ? 'auto' : String(overrides.timeoutMs),
		typeof overrides.getTradingViewReadiness === 'function' ? 'tv:fn' : 'tv:none',
		typeof overrides.getBot === 'function' ? 'bot:fn' : 'bot:none',
		typeof overrides.isBotEnabled === 'function' ? 'enabled:fn' : 'enabled:none',
	].join('|');
}

function getReadinessService(overrides) {
	const key = buildServiceKey(overrides);
	if (cachedService && cachedServiceKey === key) {
		return cachedService;
	}
	cachedService = createReadinessService(overrides || {});
	cachedServiceKey = key;
	return cachedService;
}

function resetReadinessService() {
	cachedService = null;
	cachedServiceKey = null;
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
 */
async function handleDependencyReadiness(req, res, options) {
	const startedAt = Date.now();
	const failClosed = Boolean(options && options.failClosed);
	const overrides = (req && req.app && req.app.locals && req.app.locals.readinessOverrides) || undefined;
	const respond = (statusCode, body) => res.status(statusCode).json(body);
	try {
		const report = await collectReadiness(overrides);
		respond(failClosed && !report.ready ? 503 : 200, {
			ready: report.ready,
			failClosed,
			checkedAt: new Date(startedAt).toISOString(),
			latencyMs: Date.now() - startedAt,
			dependencies: report.dependencies,
		});
	} catch (error) {
		respond(failClosed ? 503 : 200, {
			ready: false,
			failClosed,
			checkedAt: new Date(startedAt).toISOString(),
			latencyMs: Date.now() - startedAt,
			error: error && error.message ? error.message : String(error),
		});
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
