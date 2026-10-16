'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Issue #1178 enables Langfuse dynamic prompts in production.
 *
 * The gate has to be declared on every compute service that can resolve a prompt.
 * `PromptService.resolvePrompt()` falls back to the local file on any remote
 * failure, so a service left without the gate does not fail loudly — it silently
 * uses local prompts forever. That is exactly the class of failure this blueprint
 * assertion exists to prevent, and the same uniformity argument the repo already
 * applies to `ENABLE_FIREBASE_REMOTE_CONFIG` (#1113).
 */
describe('Langfuse prompt management blueprint (#1178)', () => {
	const blueprint = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');

	function serviceBlock(name) {
		const start = blueprint.indexOf(`\n  name: ${name}\n`);
		expect(start).toBeGreaterThan(-1);
		const nextService = blueprint.indexOf('\n- type: ', start);
		return nextService === -1 ? blueprint.slice(start) : blueprint.slice(start, nextService);
	}

	// The web service runs the alert/grounding path; the jobs worker starts
	// `newsMonitorSchedulerService` and `alertSchedulerService`, which resolve
	// prompts through the same PromptService. The signal-outcome worker only reads
	// and writes Firestore outcome documents and never resolves a prompt.
	const PROMPT_RESOLVING_SERVICES = [
		'cabros-crypto-bot-telegram-iac',
		'cabros-crypto-bot-telegram-worker',
	];

	it.each(PROMPT_RESOLVING_SERVICES)('enables Langfuse dynamic prompts on %s', (serviceName) => {
		expect(serviceBlock(serviceName)).toContain('- key: ENABLE_LANGFUSE_PROMPTS\n    value: true');
	});

	it.each(PROMPT_RESOLVING_SERVICES)('keeps Langfuse prompts off in previews on %s', (serviceName) => {
		// Previews share the production Langfuse project and credentials, so a PR
		// deploy would publish traces against production and spend its quota.
		expect(serviceBlock(serviceName)).toContain(
			'- key: ENABLE_LANGFUSE_PROMPTS\n    value: true\n    previewValue: false',
		);
	});

	it.each(PROMPT_RESOLVING_SERVICES)('never leaves the Langfuse credentials in the blueprint on %s', (serviceName) => {
		// Secrets come from the Render dashboard, never from a checked-in file.
		const block = serviceBlock(serviceName);
		expect(block).toContain('- key: LANGFUSE_PUBLIC_KEY\n    sync: false');
		expect(block).toContain('- key: LANGFUSE_SECRET_KEY\n    sync: false');
		expect(block).not.toMatch(/LANGFUSE_(PUBLIC|SECRET)_KEY\s*\n\s*value:/);
	});

	it('pins the production label on the web service', () => {
		// `getLangfusePromptLabel()` defaults to `production` in production-like
		// environments, but an explicit pin keeps the reviewed intent visible and
		// survives a change to that heuristic.
		expect(serviceBlock('cabros-crypto-bot-telegram-iac')).toContain(
			'- key: LANGFUSE_PROMPT_LABEL\n    value: production',
		);
	});

	it('mirrors the label and cache TTL from web to the jobs worker', () => {
		// Two processes resolving the same prompt under different labels would
		// produce different output for the same alert.
		const worker = serviceBlock('cabros-crypto-bot-telegram-worker');
		for (const key of ['LANGFUSE_PROMPT_LABEL', 'LANGFUSE_PROMPT_CACHE_TTL_SECONDS']) {
			expect(worker).toContain(
				`- key: ${key}\n    fromService:\n      name: cabros-crypto-bot-telegram-iac\n      type: web\n      envVarKey: ${key}`,
			);
		}
	});

	it('does not enable Langfuse prompts on the signal-outcome worker', () => {
		// `src/workers/signalOutcomeWorker.js` never resolves a prompt, so enabling
		// the gate there would add a credential and a probe for no effect.
		expect(serviceBlock('cabros-crypto-bot-signal-outcome-worker'))
			.not.toContain('ENABLE_LANGFUSE_PROMPTS');
	});

	it('does not declare any LANGFUSE value inline anywhere in the blueprint', () => {
		expect(blueprint).not.toMatch(/LANGFUSE_(PUBLIC|SECRET)_KEY:\s*\S/);
		expect(blueprint).not.toMatch(/pk-lf-/);
		expect(blueprint).not.toMatch(/sk-lf-/);
	});
});
