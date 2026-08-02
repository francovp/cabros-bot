'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

describe('signal outcome worker bootstrap', () => {
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
