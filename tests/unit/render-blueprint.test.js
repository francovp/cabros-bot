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
		expect(blueprint).toContain('- key: ENABLE_EQUITY_MARKET_DATA');
		expect(blueprint).toContain('- key: ENABLE_FIREBASE_REMOTE_CONFIG\n    sync: false');
		expect(blueprint).toContain('- key: EQUITY_MARKET_DATA_PROVIDER');
		expect(blueprint).toContain('- key: TWELVE_DATA_API_KEY');
		expect(blueprint).toContain('- key: TWELVE_DATA_BASE_URL');
		expect(blueprint).toContain('- key: EQUITY_MARKET_DATA_TIMEOUT_MS');
	});

	it('passes Sentry opt-in settings to the worker without enabling them by default', () => {
		const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');
		const workerBlueprint = blueprint.slice(blueprint.indexOf('- type: worker'));

		expect(workerBlueprint).toContain('- key: ENABLE_SENTRY\n    sync: false');
		expect(workerBlueprint).toContain('- key: SENTRY_DSN\n    sync: false');
		expect(workerBlueprint).not.toContain('- key: ENABLE_SENTRY\n    value: true');
	});

	// Issue #1111 enables durable webhook idempotency in production. Previews share the
	// production Firestore project, so a preview that reserved keys would make a
	// throwaway deployment suppress real production replays.
	it('enables durable idempotency on the web service with previews off', () => {
		const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');
		const webBlueprint = blueprint.slice(0, blueprint.indexOf('- type: worker'));
		const workerBlueprint = blueprint.slice(blueprint.indexOf('- type: worker'));

		expect(webBlueprint).toContain(
			'- key: ENABLE_FIRESTORE_IDEMPOTENCY\n    value: true\n    previewValue: false',
		);
		// `IdempotencyStorageService` is reached only through the HTTP route layer in
		// `src/routes/index.js`; `worker.js` never mounts routes, so the worker keeps
		// the ephemeral default instead of opening a second writer on the collection.
		expect(workerBlueprint).not.toContain('ENABLE_FIRESTORE_IDEMPOTENCY');
	});
});
