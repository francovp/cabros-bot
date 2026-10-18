/* global describe, it, expect, beforeEach, afterEach, jest */

/**
 * Issue #1178: `PromptService` is the only place that can prove whether Langfuse
 * dynamic prompts actually resolve, so it is where readiness must be recorded.
 *
 * A status endpoint that derived `ready` from env-var shape would report
 * `ready: true` while every alert silently used the local fallback file.
 */

const { PromptService, PromptKeys } = require('../../src/services/prompts');
const {
	REASONS,
	getPromptReadiness,
	resetPromptReadinessForTesting,
} = require('../../src/services/prompts/promptReadiness');

function buildRemoteClient(remotePrompt, overrides = {}) {
	return {
		prompt: {
			get: jest.fn().mockResolvedValue(remotePrompt),
			...overrides.prompt,
		},
	};
}

function buildRemotePrompt({ version = 7, compiled = [
	{ role: 'system', content: 'system' },
	{ role: 'user', content: 'Context: {{alertContext}}' },
] } = {}) {
	return {
		version,
		prompt: null,
		messages: null,
		compile: jest.fn().mockReturnValue(compiled),
	};
}

describe('PromptService readiness recording (issue #1178)', () => {
	const originalEnv = process.env;
	let logger;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			ENABLE_LANGFUSE_PROMPTS: 'true',
			LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
			LANGFUSE_SECRET_KEY: 'sk-lf-secret',
			LANGFUSE_PROMPT_LABEL: 'production',
			LANGFUSE_PROMPT_CACHE_TTL_SECONDS: '300',
		};
		logger = { warn: jest.fn(), debug: jest.fn() };
		resetPromptReadinessForTesting();
	});

	afterEach(() => {
		process.env = originalEnv;
		resetPromptReadinessForTesting();
	});

	it('records a proven success when a remote prompt resolves', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(buildRemoteClient(buildRemotePrompt({ version: 7 }))),
		});

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		expect(prompt.source).toBe('langfuse');
		const status = getPromptReadiness().getStatus();
		expect(status.promptsAttempted).toBe(1);
		expect(status.promptsSucceeded).toBe(1);
		expect(status.promptsFailed).toBe(0);
		expect(status.ready).toBe(true);
		expect(status.status).toBe('ready');
		expect(status.byPrompt['alert-enrichment']).toMatchObject({ langfuse: 1, lastVersion: 7 });
	});

	it('records a failure and a local fallback when the remote fetch rejects', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue({
				prompt: { get: jest.fn().mockRejectedValue(new Error('Prompt not found: alert-enrichment')) },
			}),
		});

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		// Fail-open: the caller still gets a usable prompt.
		expect(prompt.source).toBe('local');

		const status = getPromptReadiness().getStatus();
		expect(status.promptsAttempted).toBe(1);
		expect(status.promptsSucceeded).toBe(0);
		expect(status.promptsFailed).toBe(1);
		expect(status.ready).toBe(false);
		expect(status.status).toBe('degraded');
		expect(status.lastErrorReason).toBe(REASONS.PROMPT_NOT_FOUND);
		expect(status.localFallbackCount).toBe(1);
		expect(status.localFallbackByPrompt['alert-enrichment']).toBe(1);
	});

	it('records an attempt even when the client constructor is refused', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockRejectedValue(new Error('LangfuseClient constructor could not be resolved')),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		const status = getPromptReadiness().getStatus();
		// Asking for a remote prompt and not getting one is the event an operator
		// needs to see, so it counts even though initialization itself was refused.
		expect(status.promptsAttempted).toBe(1);
		expect(status.promptsFailed).toBe(1);
		expect(status.promptsFailed).toBeLessThanOrEqual(status.promptsAttempted);
		expect(status.lastErrorReason).toBe(REASONS.CLIENT_UNAVAILABLE);
	});

	it('classifies an auth rejection so a credential rotation is distinguishable from a blip', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue({
				prompt: {
					get: jest.fn().mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 })),
				},
			}),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		expect(getPromptReadiness().getStatus().lastErrorReason).toBe(REASONS.AUTH_FAILED);
	});

	it('records nothing when the gate is off, because local prompts are then the configured intent', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'false';
		const service = new PromptService({ logger });

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		expect(prompt.source).toBe('local');
		const status = getPromptReadiness().getStatus();
		expect(status.promptsAttempted).toBe(0);
		expect(status.promptsFailed).toBe(0);
		// Local use with the gate off is correct behaviour, not a fallback.
		expect(status.localFallbackCount).toBe(0);
		expect(status.status).toBe('disabled');
	});

	it('counts a fallback only for the prompt that fell back, not for the whole batch', async () => {
		let call = 0;
		const client = buildRemoteClient(buildRemotePrompt());
		client.prompt.get = jest.fn()
			.mockImplementationOnce(async () => {
				call += 1;
				return buildRemotePrompt({ version: 2 });
			})
			.mockImplementationOnce(async () => {
				call += 1;
				throw new Error('Prompt not found: news-analysis-search-query');
			});

		const service = new PromptService({ logger, clientProvider: jest.fn().mockResolvedValue(client) });

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });
		await service.getTextPrompt(PromptKeys.NEWS_ANALYSIS_SEARCH_QUERY, { symbol: 'BTCUSDT' });

		expect(call).toBe(2);
		const status = getPromptReadiness().getStatus();
		expect(status.promptsSucceeded).toBe(1);
		expect(status.promptsFailed).toBe(1);
		expect(status.localFallbackCount).toBe(1);
		expect(Object.keys(status.localFallbackByPrompt)).toEqual(['news-analysis-search-query']);
	});

	it('self-heals from degraded once the label is published mid-incident', async () => {
		const failing = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue({
				prompt: { get: jest.fn().mockRejectedValue(new Error('Prompt not found: alert-enrichment')) },
			}),
		});
		await failing.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });
		expect(getPromptReadiness().getStatus().status).toBe('degraded');

		const recovered = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(buildRemoteClient(buildRemotePrompt({ version: 9 }))),
		});
		await recovered.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		const status = getPromptReadiness().getStatus();
		expect(status.status).toBe('ready');
		expect(status.consecutiveFailures).toBe(0);
		expect(status.promptsFailed).toBe(1);
	});

	it('never leaks a credential through the readiness snapshot', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue({
				prompt: {
					get: jest.fn().mockRejectedValue(
						new Error('auth failed for sk-lf-supersecret at https://cloud.langfuse.com/api'),
					),
				},
			}),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		const serialized = JSON.stringify(getPromptReadiness().getStatus());
		expect(serialized).not.toContain('sk-lf-supersecret');
		expect(serialized).not.toContain('sk-lf-secret');
		expect(serialized).not.toContain('pk-lf-public');
	});

	it('keeps prompt resolution working when readiness recording throws', async () => {
		const service = new PromptService({ logger });
		const readiness = getPromptReadiness();
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		const originalRecordAttempt = readiness.recordAttempt.bind(readiness);
		readiness.recordAttempt = jest.fn(() => {
			throw new Error('counter exploded');
		});
		const originalSuccess = readiness.recordSuccess.bind(readiness);
		readiness.recordSuccess = jest.fn(() => {
			throw new Error('counter exploded');
		});

		try {
			const remote = new PromptService({
				logger,
				clientProvider: jest.fn().mockResolvedValue(buildRemoteClient(buildRemotePrompt())),
			});
			const prompt = await remote.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

			// Telemetry is never allowed to break delivery.
			expect(prompt.source).toBe('langfuse');
			expect(prompt.systemPrompt).toBe('system');
		} finally {
			readiness.recordAttempt = originalRecordAttempt;
			readiness.recordSuccess = originalSuccess;
			warn.mockRestore();
		}

		expect(service).toBeDefined();
	});
});
