'use strict';

const fs = require('fs');
const path = require('path');

describe('Render BullMQ job queue blueprint (#1117)', () => {
	const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');

	function serviceBlock(name) {
		const start = blueprint.indexOf(`\n  name: ${name}\n`);
		expect(start).toBeGreaterThan(-1);
		const nextService = blueprint.indexOf('\n- type: ', start);
		return nextService === -1 ? blueprint.slice(start) : blueprint.slice(start, nextService);
	}

	const QUEUE_CONTRACT_VARS = [
		'JOB_QUEUE_ATTEMPTS',
		'JOB_QUEUE_BACKOFF_MS',
		'JOB_QUEUE_CONCURRENCY',
		'JOB_QUEUE_CLAIM_LEASE_MS',
		'JOB_QUEUE_CONNECT_TIMEOUT_MS',
		'JOB_QUEUE_PROBE_TIMEOUT_MS',
	];

	it('declares the whole BullMQ queue contract on the web service', () => {
		// These were previously undeclared in render.yaml, so the queue ran on
		// invisible in-code defaults with no dashboard-visible way to change them.
		const web = serviceBlock('cabros-crypto-bot-telegram-iac');
		for (const key of QUEUE_CONTRACT_VARS) {
			expect(web).toContain(`- key: ${key}\n`);
		}
	});

	it('mirrors the queue contract onto the jobs worker so both sides agree', () => {
		// A fromService reference for a key the web service does not declare makes
		// a Render blueprint apply fail, so the two blocks have to move together.
		const worker = serviceBlock('cabros-crypto-bot-telegram-worker');
		for (const key of QUEUE_CONTRACT_VARS) {
			expect(worker).toContain(`- key: ${key}\n    fromService:`);
			expect(worker).toContain(`envVarKey: ${key}`);
		}
	});

	it('keeps the web service on local mode and the worker on render-worker', () => {
		// The render-worker cutover is a deliberate operator step gated on the paid
		// Key Value existing; flipping the web service here would return
		// 503 JOB_QUEUE_UNAVAILABLE for every job on a deployment with no broker.
		const web = serviceBlock('cabros-crypto-bot-telegram-iac');
		const worker = serviceBlock('cabros-crypto-bot-telegram-worker');

		expect(web).toContain('- key: JOB_EXECUTION_MODE\n    value: local');
		expect(web).not.toContain('- key: JOB_EXECUTION_MODE\n    value: render-worker');
		expect(worker).toContain('- key: JOB_EXECUTION_MODE\n    value: render-worker');
	});

	it('wires both services to the same Key Value broker', () => {
		for (const name of ['cabros-crypto-bot-telegram-iac', 'cabros-crypto-bot-telegram-worker']) {
			expect(serviceBlock(name)).toContain(
				'- key: REDIS_URL\n    fromService:\n      name: cabros-crypto-bot-telegram-queue\n      type: keyvalue\n      property: connectionString',
			);
		}
		expect(blueprint).toContain('maxmemoryPolicy: noeviction');
	});
});

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
		expect(blueprint).toContain('- key: ENABLE_FIREBASE_REMOTE_CONFIG\n    value: true');
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

	// Issue #1110 enables signal outcome tracking in production. The flag gates
	// signal recording, the evaluation sweep and the whole /api/outcomes surface,
	// so it must be reviewable in the blueprint rather than dashboard-only.
	// Previews stay off: a preview would record and evaluate against the
	// production `tradingSignalOutcomes` collection.
	it('pins signal outcome tracking on the web service with previews off', () => {
		const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');
		const webBlueprint = blueprint.slice(0, blueprint.indexOf('- type: worker'));

		expect(webBlueprint).toContain(
			'- key: ENABLE_SIGNAL_OUTCOME_TRACKING\n    value: true\n    previewValue: false',
		);
	});

	// The web service sweeps and the dedicated worker below is the cutover target.
	// `SignalOutcomeService` claims the sweep with a Firestore lease, so only one of
	// them acts on a pending signal even while both are enabled.
	it('declares the web sweep role and the lease duration that keeps the sweep single-writer', () => {
		const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');
		const webBlueprint = blueprint.slice(0, blueprint.indexOf('- type: worker'));

		expect(webBlueprint).toContain('- key: SIGNAL_OUTCOME_WORKER_ROLE\n    value: web');
		expect(webBlueprint).toContain('- key: SIGNAL_OUTCOME_EVALUATION_LEASE_MS\n    value: 120000');
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

/**
 * Issue #1136: `worker.js` starts `newsMonitorSchedulerService`, which reaches
 * `analyzeNewsForSymbol()` -> `genaiClient.llmCallv2()`. Every sweep therefore
 * needs the same LLM provider configuration the web service already has.
 *
 * The worker used to inherit none of it. Two distinct failures followed:
 *
 * 1. `llmCallv2()` gates its Gemini branch on
 *    `MODEL_PROVIDER === 'gemini' && GEMINI_MODEL_NAME` (genaiClient.js:465) and
 *    throws `All LLM providers failed. Last error: No providers configured`
 *    (genaiClient.js:589) when no branch is configured. `GEMINI_MODEL_NAME` is
 *    the sharpest key here: without it the default `gemini` provider is skipped
 *    outright, so inheriting `GEMINI_API_KEY` alone still yields no provider.
 * 2. The alternative-provider credentials were absent, so the azure /
 *    openrouter / cloudflare branches could not run either — meaning an
 *    operator who switched `MODEL_PROVIDER` got a worker that silently had no
 *    working provider at all.
 *
 * These are assertions about a deploy contract, not about runtime behaviour, so
 * they read the blueprint: a `fromService` reference cannot be satisfied by a
 * hardcoded value or by a `sync: false` placeholder.
 */
describe('Render jobs worker inherits the LLM provider contract (issue #1136)', () => {
	const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');

	function serviceBlock(name) {
		const start = blueprint.indexOf(`\n  name: ${name}\n`);
		expect(start).toBeGreaterThan(-1);
		const nextService = blueprint.indexOf('\n- type: ', start);
		return nextService === -1 ? blueprint.slice(start) : blueprint.slice(start, nextService);
	}

	const worker = serviceBlock('cabros-crypto-bot-telegram-worker');

	// Grouped by the provider branch each key selects. Every one of these is read
	// on the news sweep path, so a worker missing any of them cannot run a sweep.
	const LLM_PROVIDER_VARS = [
		// Routing and model selection. MODEL_PROVIDER picks the branch; without
		// GEMINI_MODEL_NAME the default `gemini` branch is skipped (see above).
		'MODEL_PROVIDER',
		'GEMINI_MODEL_NAME',
		'GEMINI_MODEL_NAME_FALLBACK',
		'GROUNDING_MODEL_NAME',
		// Credentials.
		'GEMINI_API_KEY',
		'OPENROUTER_API_KEY',
		'AZURE_LLM_KEY',
		'CF_AIG_TOKEN',
		'BRAVE_SEARCH_API_KEY',
		// Alternative-provider model/endpoint selection, so an operator who
		// switches MODEL_PROVIDER gets the same model in the worker.
		'OPENROUTER_MODEL',
		'AZURE_LLM_MODEL',
		'AZURE_LLM_ENDPOINT',
		'CF_AIG_BASE_URL',
		'CF_AIG_MODEL',
	];

	it.each(LLM_PROVIDER_VARS)('inherits %s from the web service', (key) => {
		expect(worker).toContain(`- key: ${key}\n    fromService:`);
		expect(worker).toContain(`envVarKey: ${key}`);
	});

	it.each(LLM_PROVIDER_VARS)('does not hardcode %s in the worker', (key) => {
		// A `value:` here would be worse than the missing key: it would look
		// configured while silently diverging from whatever the web service uses.
		expect(worker).not.toContain(`- key: ${key}\n    value:`);
		expect(worker).not.toContain(`- key: ${key}\n    sync: false`);
	});

	it('inherits the news monitor scheduler role so the operator can disable it', () => {
		// The role is the only off-switch for the worker sweep. Hardcoding
		// `value: worker` meant setting `web` or `disabled` on the web service
		// still left the worker sweeping, because `startWorker({source:'worker'})`
		// matched the hardcoded role against its own source.
		expect(worker).toContain(
			'- key: NEWS_MONITOR_SCHEDULER_WORKER_ROLE\n    fromService:\n'
			+ '      name: cabros-crypto-bot-telegram-iac\n      type: web\n'
			+ '      envVarKey: NEWS_MONITOR_SCHEDULER_WORKER_ROLE',
		);
		expect(worker).not.toContain('- key: NEWS_MONITOR_SCHEDULER_WORKER_ROLE\n    value:');
	});

	it('leaves the signal-outcome worker role split alone', () => {
		// `SIGNAL_OUTCOME_WORKER_ROLE` is deliberately *different* per service:
		// both processes are configured as candidate evaluators and the
		// `signalOutcomeLocks` lease elects exactly one. Inheriting a single value
		// there would silently disable one of the two named candidates.
		const outcomeWorker = serviceBlock('cabros-crypto-bot-signal-outcome-worker');
		expect(outcomeWorker).toContain('- key: SIGNAL_OUTCOME_WORKER_ROLE\n    value: worker');
		expect(outcomeWorker).not.toContain(
			'- key: SIGNAL_OUTCOME_WORKER_ROLE\n    fromService:',
		);
	});
});

/**
 * Firebase Remote Config is a single project-wide server template read by every
 * process that calls `remoteConfigService.start()`. `getRuntimeConfig()` only
 * merges remote overrides when the gate is on, so a process that reads runtime
 * config with the gate off silently evaluates a *different* effective config
 * from one with the gate on. `SIGNAL_OUTCOME_RETENTION_DAYS` is the sharpest
 * case: the web service stamps `expiresAt` on Firestore documents while the
 * signal-outcome worker applies the same window when evaluating them, so a
 * split gate makes the two processes disagree about document lifecycle.
 *
 * These assertions therefore require the gate on every compute service that
 * starts the loader, not just on the web service.
 */
describe('Render Firebase Remote Config blueprint (issue #1113)', () => {
	const readBlueprint = () => fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');

	/**
	 * Slice one service block out of the blueprint by its `name:` so an
	 * assertion cannot be satisfied by a sibling service that happens to
	 * declare the same key.
	 */
	const serviceBlock = (blueprint, serviceName) => {
		const start = blueprint.indexOf(`  name: ${serviceName}\n`);
		expect(start).toBeGreaterThan(-1);
		const nextService = blueprint.indexOf('\n- type: ', start);
		return nextService === -1 ? blueprint.slice(start) : blueprint.slice(start, nextService);
	};

	const COMPUTE_SERVICES = [
		'cabros-crypto-bot-telegram-iac',
		'cabros-crypto-bot-telegram-worker',
		'cabros-crypto-bot-signal-outcome-worker',
	];

	it.each(COMPUTE_SERVICES)('enables the server template loader on %s', (serviceName) => {
		expect(serviceBlock(readBlueprint(), serviceName)).toContain(
			'- key: ENABLE_FIREBASE_REMOTE_CONFIG\n    value: true',
		);
	});

	it.each(COMPUTE_SERVICES)('does not leave %s dashboard-managed', (serviceName) => {
		// `sync: false` defers the value to the Render dashboard, so the shared
		// template would be read by an unknown subset of processes.
		expect(serviceBlock(readBlueprint(), serviceName)).not.toContain(
			'- key: ENABLE_FIREBASE_REMOTE_CONFIG\n    sync: false',
		);
	});

	it('keeps the flag off in pull-request previews', () => {
		const blueprint = readBlueprint();

		// Previews are throwaway environments. A preview must not honour the
		// production namespace, otherwise a PR deploy changes behaviour based on
		// production runtime tuning.
		for (const serviceName of COMPUTE_SERVICES) {
			const block = serviceBlock(blueprint, serviceName);
			if (!block.includes('- key: ENABLE_FIREBASE_REMOTE_CONFIG')) {
				continue;
			}
			expect(block).toContain('- key: ENABLE_FIREBASE_REMOTE_CONFIG\n    value: true\n    previewValue: false');
		}

		expect(serviceBlock(blueprint, 'cabros-crypto-bot-telegram-iac')).toContain(
			'- key: ENABLE_FIREBASE_REMOTE_CONFIG\n    value: true\n    previewValue: false',
		);
	});
});
