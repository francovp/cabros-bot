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

async function handleReadiness(req, res) {
	const startedAt = Date.now();
	const overrides = (req && req.app && req.app.locals && req.app.locals.readinessOverrides) || undefined;
	try {
		const report = await collectReadiness(overrides);
		const status = report.ready ? 200 : 503;
		res.status(status).json({
			ready: report.ready,
			checkedAt: new Date(startedAt).toISOString(),
			latencyMs: Date.now() - startedAt,
			dependencies: report.dependencies,
		});
	} catch (error) {
		res.status(503).json({
			ready: false,
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
	handleReadiness,
	attachReadinessOverrides,
	getReadinessService,
	resetReadinessService,
};
