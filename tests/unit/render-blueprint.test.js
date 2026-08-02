'use strict';

const fs = require('fs');
const path = require('path');

describe('Render signal outcome worker blueprint', () => {
	it('defines an explicit paid worker with dedicated scheduler role', () => {
		const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');

		expect(blueprint).toContain('- type: worker');
		expect(blueprint).toContain('startCommand: corepack enable && pnpm run start:signal-outcome-worker');
		expect(blueprint).toContain('SIGNAL_OUTCOME_WORKER_ROLE');
		expect(blueprint).toContain('value: worker');
		expect(blueprint).toContain('plan: starter');
		expect(blueprint).toContain('maxShutdownDelaySeconds: 60');
		expect(blueprint).toContain('numInstances: 1');
		expect(blueprint).toContain('generation: off');
	});
});
