'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('signal outcome worker bootstrap', () => {
	it('loads shared monitoring before the scheduler service', () => {
		const workerPath = path.join(__dirname, '../../src/workers/signalOutcomeWorker.js');
		const source = fs.readFileSync(workerPath, 'utf8');
		const instrumentationImport = source.indexOf("require('../../instrument.js')");
		const serviceImport = source.indexOf("require('../services/storage/SignalOutcomeService')");

		expect(instrumentationImport).toBeGreaterThanOrEqual(0);
		expect(instrumentationImport).toBeLessThan(serviceImport);
	});

	it('refuses to run when the service role is not worker', () => {
		const result = spawnSync(
			process.execPath,
			[path.join(__dirname, '../../src/workers/signalOutcomeWorker.js')],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					ENABLE_SIGNAL_OUTCOME_TRACKING: 'true',
					SIGNAL_OUTCOME_WORKER_ROLE: 'web',
				},
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain('expected worker');
	});
});
