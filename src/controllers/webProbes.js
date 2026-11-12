'use strict';

const readiness = require('./readiness');
const bootstrap = require('../lib/bootstrapReadiness');
const lifecycle = require('../lib/processLifecycle');

function getLiveness(req, res) {
	return res.json({ status: 'alive', uptimeMs: Math.floor(process.uptime() * 1000) });
}

async function getWebReadiness(req, res) {
	let dependencies = [];
	let dependenciesReady = false;
	try {
		const report = await readiness.collectReadiness(req.app.locals.readinessOverrides);
		dependenciesReady = report.ready === true;
		dependencies = Object.entries(report.dependencies).map(([name, dependency]) => ({
			name,
			status: dependency.skipped === true ? 'unconfigured' : dependency.ready === true ? 'ready' : 'fail',
		}));
	} catch {
		// Public probes expose fixed check names/statuses, never provider errors.
	}
	// Read these after awaiting probes: shutdown/bootstrap failure can occur in flight.
	const checks = [
		{ name: 'bootstrap', status: bootstrap.getStatus().ready ? 'ready' : 'fail' },
		{ name: 'processLifecycle', status: lifecycle.isShuttingDownForPublicStatus() ? 'fail' : 'ready' },
		{ name: 'dependencies', status: dependenciesReady ? 'ready' : 'fail' },
		...dependencies,
	];
	const ready = checks.every((check) => check.status !== 'fail');
	res.set('Cache-Control', 'no-store');
	return res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
}

module.exports = { getLiveness, getWebReadiness };
