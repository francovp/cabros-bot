/* global describe, it, expect, beforeEach, afterEach, jest */

/**
 * Issue #1178: the startup probe is what makes the enablement verifiable. Without
 * it `dependencies.langfuse.ready` stays `unverified` until real alert traffic
 * arrives, so an idle deployment cannot distinguish working prompts from valid
 * credentials paired with a `production` label that was never published.
 */

const { PromptService, probeManagedPromptReadiness } = require('../../src/services/prompts');
const { PROMPT_DEFINITIONS } = require('../../src/services/prompts/promptRegistry');
const {
	REASONS,
	getPromptReadiness,
	resetPromptReadinessForTesting,
} = require('../../src/services/prompts/promptReadiness');

function buildRemotePrompt() {
	return {
		version: 3,
		prompt: null,
		messages: null,
		compile: jest.fn().mockReturnValue([
			{ role: 'system', content: 'system' },
			{ role: 'user', content: 'context' },
		]),
	};
}

function buildRemoteService() {
	return new PromptService({
		logger: { warn: jest.fn(), debug: jest.fn() },
		clientProvider: jest.fn().mockResolvedValue({
			prompt: { get: jest.fn().mockResolvedValue(buildRemotePrompt()) },
		}),
	});
}

describe('probeManagedPromptReadiness (issue #1178)', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			ENABLE_LANGFUSE_PROMPTS: 'true',
			LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
			LANGFUSE_SECRET_KEY: 'sk-lf-secret',
			LANGFUSE_PROMPT_LABEL: 'production',
			LANGFUSE_PROMPT_CACHE_TTL_SECONDS: '300',
		};
		resetPromptReadinessForTesting();
	});

	afterEach(() => {
		process.env = originalEnv;
		resetPromptReadinessForTesting();
	});

	it('is a no-op when the gate is off, so a disabled deployment issues no calls', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'false';
		const promptService = { resolvePrompt: jest.fn() };

		await expect(probeManagedPromptReadiness({ promptService })).resolves.toBe(false);
		expect(promptService.resolvePrompt).not.toHaveBeenCalled();
	});

	it('resolves every registered prompt so readiness is proven without alert traffic', async () => {
		const promptService = { resolvePrompt: jest.fn().mockResolvedValue({ type: 'text', text: 'x' }) };

		await expect(probeManagedPromptReadiness({ promptService })).resolves.toBe(true);

		const probed = promptService.resolvePrompt.mock.calls.map(([key]) => key);
		expect(new Set(probed)).toEqual(new Set(Object.keys(PROMPT_DEFINITIONS)));
	});

	it('records a proven success when every prompt resolves remotely', async () => {
		await expect(probeManagedPromptReadiness({ promptService: buildRemoteService() })).resolves.toBe(true);

		const status = getPromptReadiness().getStatus();
		expect(status.status).toBe('ready');
		expect(status.ready).toBe(true);
		expect(status.promptsSucceeded).toBeGreaterThan(0);
		expect(status.localFallbackCount).toBe(0);
	});

	it('surfaces an unpublished production label as degraded instead of healthy', async () => {
		const promptService = new PromptService({
			logger: { warn: jest.fn(), debug: jest.fn() },
			clientProvider: jest.fn().mockResolvedValue({
				prompt: { get: jest.fn().mockRejectedValue(new Error('Prompt not found: alert-enrichment')) },
			}),
		});

		await probeManagedPromptReadiness({ promptService });

		const status = getPromptReadiness().getStatus();
		expect(status.ready).toBe(false);
		expect(status.status).toBe('degraded');
		expect(status.lastErrorReason).toBe(REASONS.PROMPT_NOT_FOUND);
		expect(status.localFallbackCount).toBeGreaterThan(0);
	});

	it('keeps probing after one prompt throws, so a single bad prompt cannot hide the rest', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const seen = [];
		const promptService = {
			resolvePrompt: jest.fn().mockImplementation(async (key) => {
				seen.push(key);
				if (seen.length === 1) {
					throw new Error('local fallback template is broken');
				}
				return { type: 'text', text: 'x' };
			}),
		};

		try {
			await expect(probeManagedPromptReadiness({ promptService })).resolves.toBe(true);
			expect(seen).toHaveLength(Object.keys(PROMPT_DEFINITIONS).length);
		} finally {
			warn.mockRestore();
		}
	});

	it('never rejects, so a failed probe cannot break process startup', async () => {
		const promptService = {
			resolvePrompt: jest.fn().mockRejectedValue(new Error('network down')),
		};

		await expect(probeManagedPromptReadiness({ promptService })).resolves.toBe(true);
	});

	it('accepts a probe without a resolver rather than throwing', async () => {
		await expect(probeManagedPromptReadiness({ promptService: {} })).resolves.toBe(false);
	});
});
