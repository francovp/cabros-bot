/* global describe, it, expect, beforeEach, afterEach, jest */

const { PromptService, PromptKeys } = require('../../src/services/prompts');

describe('PromptService', () => {
	const originalEnv = process.env;
	let logger;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			ENABLE_LANGFUSE_PROMPTS: 'false',
			LANGFUSE_PUBLIC_KEY: '',
			LANGFUSE_SECRET_KEY: '',
			LANGFUSE_PROMPT_LABEL: 'latest',
			LANGFUSE_PROMPT_CACHE_TTL_SECONDS: '0',
		};
		logger = {
			warn: jest.fn(),
		};
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('should return local fallback chat prompt when Langfuse is disabled', async () => {
		const service = new PromptService({ logger });

		const prompt = await service.getChatPrompt(PromptKeys.SEARCH_QUERY_DERIVATION, {
			alertText: 'BTCUSDT breaks resistance',
		});

		expect(prompt.source).toBe('local');
		expect(prompt.systemPrompt).toContain('Extract key topics and entities');
		expect(prompt.userPrompt).toContain('BTCUSDT breaks resistance');
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('should include optional risk metadata in the local alert enrichment prompt', async () => {
		const service = new PromptService({ logger });

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, {
			alertContext: 'Bitcoin breaks resistance',
		});

		expect(prompt.userPrompt).toEqual(expect.stringContaining('invalidation_level'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('target_level'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('setup_type'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('risk_reward_ratio'));
	});

	it('should include evidence calibration guidance in the local alert enrichment prompt', async () => {
		const service = new PromptService({ logger });

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, {
			alertContext: 'Bitcoin breaks resistance',
		});

		expect(prompt.userPrompt).toEqual(expect.stringContaining('0.9+'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('0.6-0.8'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('corroborating sources'));
	});

	it('should include setup_type evidence rubric and omission guidance in the local alert enrichment prompt', async () => {
		const service = new PromptService({ logger });

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, {
			alertContext: 'Bitcoin breaks resistance',
		});

		expect(prompt.userPrompt).toEqual(expect.stringContaining('setup_evidence'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('Setup type rubric:'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('Do NOT infer `setup_type` solely from signal direction'));
		expect(prompt.userPrompt).toEqual(expect.stringContaining('OMIT `setup_type` and `setup_evidence` entirely'));
	});

	it('should fetch and compile remote Langfuse chat prompts', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';

		const remotePrompt = {
			version: 7,
			compile: jest.fn().mockReturnValue([
				{ role: 'system', content: 'Remote system prompt' },
				{ role: 'user', content: 'Remote user prompt' },
			]),
		};
		const client = {
			prompt: {
				get: jest.fn().mockResolvedValue(remotePrompt),
			},
		};
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(client),
		});

		const prompt = await service.getChatPrompt(
			PromptKeys.ALERT_ENRICHMENT,
			{ alertContext: 'Bitcoin alert context', languageDirective: 'Respond in Spanish.' },
			{ label: 'staging', cacheTtlSeconds: 300 },
		);

		expect(client.prompt.get).toHaveBeenCalledWith('alert-enrichment', {
			type: 'chat',
			label: 'staging',
			cacheTtlSeconds: 300,
		});
		expect(remotePrompt.compile).toHaveBeenCalledWith({
			alertContext: 'Bitcoin alert context',
			languageDirective: 'Respond in Spanish.',
		});
		expect(prompt.source).toBe('langfuse');
		expect(prompt.name).toBe('alert-enrichment');
		expect(prompt.label).toBe('staging');
		expect(prompt.version).toBe(7);
		expect(prompt.systemPrompt).toBe('Remote system prompt');
		expect(prompt.userPrompt).toBe('Remote user prompt');
	});

	it('should fall back to local prompts when Langfuse fetch fails', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';

		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockRejectedValue(new Error('Missing Langfuse credentials')),
		});

		const prompt = await service.getChatPrompt(PromptKeys.GROUNDED_SUMMARY, {
			alertText: 'Fallback alert',
			maxLength: 250,
			languageDirective: '',
			contextPrompt: '',
			contextSnippet: '',
		});

		expect(prompt.source).toBe('local');
		expect(prompt.userPrompt).toContain('Fallback alert');
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('using local fallbacks'));
	});

	it('should fetch remote text prompts for non-chat use cases', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';

		const remotePrompt = {
			version: 3,
			compile: jest.fn().mockReturnValue('Remote price query for BTCUSDT'),
		};
		const client = {
			prompt: {
				get: jest.fn().mockResolvedValue(remotePrompt),
			},
		};
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(client),
		});

		const prompt = await service.getTextPrompt(PromptKeys.MARKET_PRICE_FETCH, { symbol: 'BTCUSDT' });

		expect(prompt.type).toBe('text');
		expect(prompt.text).toBe('Remote price query for BTCUSDT');
		expect(prompt.source).toBe('langfuse');
	});

	it('should allow overriding the resolved system prompt', async () => {
		const service = new PromptService({ logger });

		const prompt = await service.getChatPrompt(
			PromptKeys.GROUNDED_SUMMARY,
			{
				alertText: 'Custom system prompt alert',
				maxLength: 120,
				languageDirective: '',
				contextPrompt: '',
				contextSnippet: '',
			},
			{ systemPromptOverride: 'My custom system prompt' },
		);

		expect(prompt.systemPrompt).toBe('My custom system prompt');
		expect(prompt.userPrompt).toContain('Custom system prompt alert');
	});

	it('should detect schema drift when remote alert-enrichment prompt is missing risk fields', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';

		const remotePrompt = {
			version: 4,
			compile: jest.fn().mockReturnValue([
				{ role: 'system', content: 'Remote system prompt without risk fields' },
				{ role: 'user', content: 'Context: {{alertContext}}' },
			]),
		};
		const client = {
			prompt: {
				get: jest.fn().mockResolvedValue(remotePrompt),
			},
		};
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(client),
		});

		const prompt = await service.getChatPrompt(
			PromptKeys.ALERT_ENRICHMENT,
			{ alertContext: 'Bitcoin alert context' },
		);

		expect(prompt.source).toBe('langfuse');
		expect(prompt.schemaDriftDetected).toBe(true);
		expect(prompt.missingRiskFields).toEqual([
			'invalidation_level',
			'target_level',
			'setup_type',
			'risk_reward_ratio',
		]);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('missing required risk fields: invalidation_level, target_level, setup_type, risk_reward_ratio'),
		);

		const driftStatus = service.getSchemaDriftStatus();
		expect(driftStatus['alert-enrichment:4']).toEqual(expect.objectContaining({
			promptName: 'alert-enrichment',
			version: 4,
			missingRiskFields: ['invalidation_level', 'target_level', 'setup_type', 'risk_reward_ratio'],
		}));
	});

	it('should detect missing evidence calibration guidance in remote prompts', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';

		const remotePrompt = {
			version: 6,
			compile: jest.fn().mockReturnValue([
				{ role: 'system', content: 'Include invalidation_level, target_level, setup_type, and risk_reward_ratio.' },
				{ role: 'user', content: 'Context: {{alertContext}}' },
			]),
		};
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue({ prompt: { get: jest.fn().mockResolvedValue(remotePrompt) } }),
		});

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin alert context' });

		expect(prompt.schemaDriftDetected).toBe(true);
		expect(prompt.missingCalibrationGuidance).toEqual(['0.9+', '0.6-0.8', 'corroborating sources']);
	});

	it('should mark schemaDriftDetected as false when remote alert-enrichment prompt includes all required risk fields', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';

		const remotePrompt = {
			version: 5,
			compile: jest.fn().mockReturnValue([
				{ role: 'system', content: 'You are an analyst. Include invalidation_level, target_level, setup_type, and risk_reward_ratio. Use 0.9+ only with multiple independent corroborating sources; use 0.6-0.8 for partial evidence.' },
				{ role: 'user', content: 'Context: {{alertContext}}' },
			]),
		};
		const client = {
			prompt: {
				get: jest.fn().mockResolvedValue(remotePrompt),
			},
		};
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(client),
		});

		const prompt = await service.getChatPrompt(
			PromptKeys.ALERT_ENRICHMENT,
			{ alertContext: 'Bitcoin alert context' },
		);

		expect(prompt.source).toBe('langfuse');
		expect(prompt.schemaDriftDetected).toBe(false);
		expect(prompt.missingRiskFields).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe('PromptService prompt-resolution telemetry', () => {
	const originalEnv = process.env;
	let logger;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			ENABLE_LANGFUSE_PROMPTS: 'true',
			LANGFUSE_PUBLIC_KEY: 'pk-lf-test-public',
			LANGFUSE_SECRET_KEY: 'sk-lf-test-secret',
			LANGFUSE_PROMPT_LABEL: 'production',
			LANGFUSE_PROMPT_CACHE_TTL_SECONDS: '60',
		};
		logger = {
			warn: jest.fn(),
			debug: jest.fn(),
		};
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	function buildRemoteClient(content, version = 11) {
		return {
			prompt: {
				get: jest.fn().mockResolvedValue({
					version,
					compile: jest.fn().mockReturnValue(content),
				}),
			},
		};
	}

	const REMOTE_CHAT = [
		{ role: 'system', content: 'Remote system prompt with invalidation_level, target_level, setup_type, risk_reward_ratio. 0.9+ only with corroborating sources, 0.6-0.8 partial.' },
		{ role: 'user', content: 'Context: {{alertContext}}' },
	];

	it('reports a disabled serving status with zeroed counters when prompt management is off', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'false';
		const service = new PromptService({ logger });

		await service.getChatPrompt(PromptKeys.SEARCH_QUERY_DERIVATION, { alertText: 'BTC breaks out' });

		const status = service.getPromptResolutionStatus();
		expect(status.enabled).toBe(false);
		expect(status.servingStatus).toBe('disabled');
		expect(status.servingPrompts).toBe(false);
		expect(status.totalResolutions).toBe(1);
		expect(status.langfuseResolutions).toBe(0);
		expect(status.localResolutions).toBe(1);
		expect(status.localResolutionRatePercent).toBe(100);
		expect(status.remoteFetchAttempts).toBe(0);
		expect(status.remoteFetchSuccesses).toBe(0);
		expect(status.remoteFetchFailures).toBe(0);
		expect(status.remoteFetchSuccessRatePercent).toBeNull();
		expect(status.lastSuccessfulFetchAt).toBeNull();
		expect(status.lastErrorCategory).toBeNull();
	});

	it('reports an unconfigured serving status when the feature is on but credentials are missing', async () => {
		process.env.LANGFUSE_PUBLIC_KEY = '';
		process.env.LANGFUSE_SECRET_KEY = '';
		const service = new PromptService({ logger });

		await service.getChatPrompt(PromptKeys.SEARCH_QUERY_DERIVATION, { alertText: 'BTC breaks out' });

		const status = service.getPromptResolutionStatus();
		expect(status.enabled).toBe(true);
		expect(status.configured).toBe(false);
		expect(status.servingStatus).toBe('unconfigured');
		expect(status.localResolutions).toBe(1);
		expect(status.lastErrorCategory).toBe('client_unavailable');
	});

	it('reports a no_traffic serving status before any prompt has been resolved', () => {
		const service = new PromptService({ logger });

		const status = service.getPromptResolutionStatus();
		expect(status.servingStatus).toBe('no_traffic');
		expect(status.totalResolutions).toBe(0);
		expect(status.localResolutionRatePercent).toBeNull();
		expect(status.remoteFetchSuccessRatePercent).toBeNull();
		expect(status.prompts).toEqual([]);
	});

	it('reports a serving status and a successful fetch timestamp when remote prompts are served', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(buildRemoteClient(REMOTE_CHAT)),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin context' });

		const status = service.getPromptResolutionStatus();
		expect(status.servingStatus).toBe('serving');
		expect(status.servingPrompts).toBe(true);
		expect(status.enabled).toBe(true);
		expect(status.configured).toBe(true);
		expect(status.label).toBe('production');
		expect(status.cacheTtlSeconds).toBe(60);
		expect(status.totalResolutions).toBe(1);
		expect(status.langfuseResolutions).toBe(1);
		expect(status.localResolutions).toBe(0);
		expect(status.localResolutionRatePercent).toBe(0);
		expect(status.remoteFetchAttempts).toBe(1);
		expect(status.remoteFetchSuccesses).toBe(1);
		expect(status.remoteFetchFailures).toBe(0);
		expect(status.remoteFetchSuccessRatePercent).toBe(100);
		expect(status.lastSuccessfulFetchAt).toEqual(expect.any(String));
		expect(status.consecutiveFailures).toBe(0);
	});

	it('makes a 100 percent local fallback regression detectable instead of silent', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(buildRemoteClient(REMOTE_CHAT)),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin context' });
		service.clientProvider = jest.fn().mockRejectedValue(new Error('fetch failed'));
		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin context' });
		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin context' });

		const status = service.getPromptResolutionStatus();
		expect(status.servingStatus).toBe('degraded');
		expect(status.servingPrompts).toBe(true);
		expect(status.totalResolutions).toBe(3);
		expect(status.langfuseResolutions).toBe(1);
		expect(status.localResolutions).toBe(2);
		expect(status.localResolutionRatePercent).toBe(66.7);
		expect(status.remoteFetchAttempts).toBe(3);
		expect(status.remoteFetchSuccesses).toBe(1);
		expect(status.remoteFetchFailures).toBe(2);
		expect(status.remoteFetchSuccessRatePercent).toBe(33.3);
		expect(status.consecutiveFailures).toBe(2);
		expect(status.lastErrorCategory).toBe('request_failed');
		expect(status.lastFailedFetchAt).toEqual(expect.any(String));
	});

	it('reports local_fallback when remote is enabled, reachable, and every fetch has failed', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue({
				prompt: {
					get: jest.fn().mockRejectedValue(new Error('Langfuse prompt not found')),
				},
			}),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin context' });
		await service.getChatPrompt(PromptKeys.NEWS_ANALYSIS, { symbol: 'BTCUSDT', enrichedContext: 'ctx' });

		const status = service.getPromptResolutionStatus();
		expect(status.servingStatus).toBe('local_fallback');
		expect(status.servingPrompts).toBe(false);
		expect(status.langfuseResolutions).toBe(0);
		expect(status.localResolutions).toBe(2);
		expect(status.localResolutionRatePercent).toBe(100);
		expect(status.remoteFetchAttempts).toBe(2);
		expect(status.remoteFetchFailures).toBe(2);
		expect(status.remoteFetchSuccessRatePercent).toBe(0);
		expect(status.lastSuccessfulFetchAt).toBeNull();
		expect(status.lastErrorCategory).toBe('prompt_not_found');
	});

	it('reports the resolved source per registered prompt', async () => {
		const remoteClient = buildRemoteClient(REMOTE_CHAT);
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(remoteClient),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin context' });
		await service.getTextPrompt(PromptKeys.MARKET_PRICE_FETCH, { symbol: 'BTCUSDT' });

		const status = service.getPromptResolutionStatus();
		const byName = Object.fromEntries(status.prompts.map(entry => [entry.name, entry]));

		expect(Object.keys(byName).sort()).toEqual(['alert-enrichment', 'market-price-fetch']);
		expect(byName['alert-enrichment']).toEqual(expect.objectContaining({
			name: 'alert-enrichment',
			type: 'chat',
			langfuseResolutions: 1,
			localResolutions: 0,
			lastSource: 'langfuse',
			lastLangfuseVersion: 11,
		}));
		expect(byName['market-price-fetch']).toEqual(expect.objectContaining({
			name: 'market-price-fetch',
			type: 'text',
			langfuseResolutions: 1,
			localResolutions: 0,
			lastSource: 'langfuse',
		}));
	});

	it('never exposes remote prompt content, credentials, or raw error messages in the telemetry', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockRejectedValue(
				new Error('fetch failed for pk-lf-test-public with sk-lf-test-secret prompt alert-context-secret-marker'),
			),
		});

		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'alert-context-secret-marker' });

		const serialized = JSON.stringify(service.getPromptResolutionStatus());
		expect(serialized).not.toContain('sk-lf-test-secret');
		expect(serialized).not.toContain('pk-lf-test-public');
		expect(serialized).not.toContain('alert-context-secret-marker');
		expect(service.getPromptResolutionStatus().lastErrorCategory).toBe('request_failed');
	});

	it('classifies fetch failures into a closed error category enum', async () => {
		const categories = [];
		const cases = [
			new Error('Langfuse prompt not found'),
			new Error('401 Unauthorized'),
			new Error('429 Too Many Requests'),
			new Error('The operation was aborted due to timeout'),
			new Error('compile failed for template'),
			new Error('ECONNREFUSED 127.0.0.1:443'),
			new Error('something entirely new'),
		];

		for (const error of cases) {
			const service = new PromptService({
				logger,
				clientProvider: jest.fn().mockResolvedValue({ prompt: { get: jest.fn().mockRejectedValue(error) } }),
			});
			// eslint-disable-next-line no-await-in-loop
			await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });
			categories.push(service.getPromptResolutionStatus().lastErrorCategory);
		}

		expect(categories).toEqual([
			'prompt_not_found',
			'unauthorized',
			'rate_limited',
			'timeout',
			'compile_failed',
			'request_failed',
			'unknown',
		]);
	});

	it('preserves the schemaDriftDetected provenance contract while recording telemetry', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(buildRemoteClient([
				{ role: 'system', content: 'Remote system prompt without risk fields' },
				{ role: 'user', content: 'Context: {{alertContext}}' },
			], 4)),
		});

		const prompt = await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		expect(prompt.source).toBe('langfuse');
		expect(prompt.schemaDriftDetected).toBe(true);
		expect(prompt.missingRiskFields).toEqual([
			'invalidation_level',
			'target_level',
			'setup_type',
			'risk_reward_ratio',
		]);
		const status = service.getPromptResolutionStatus();
		expect(status.servingStatus).toBe('serving');
		expect(status.prompts).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: 'alert-enrichment', lastSource: 'langfuse', lastLangfuseVersion: 4 }),
		]));
	});

	it('still returns the local fallback when telemetry recording itself throws', async () => {
		const hostileService = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(buildRemoteClient(REMOTE_CHAT)),
		});
		hostileService.telemetry = null;
		hostileService._recordResolution = () => {
			throw new Error('telemetry exploded');
		};

		const prompt = await hostileService.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'Bitcoin context' });

		expect(prompt.source).toBe('langfuse');
		expect(prompt.userPrompt).toContain('{{alertContext}}');
	});

	it('resets telemetry counters for tests without affecting the configured label', async () => {
		const service = new PromptService({
			logger,
			clientProvider: jest.fn().mockResolvedValue(buildRemoteClient(REMOTE_CHAT)),
		});
		await service.getChatPrompt(PromptKeys.ALERT_ENRICHMENT, { alertContext: 'ctx' });

		service.resetTelemetryForTesting();

		const status = service.getPromptResolutionStatus();
		expect(status.totalResolutions).toBe(0);
		expect(status.servingStatus).toBe('no_traffic');
		expect(status.prompts).toEqual([]);
		expect(status.label).toBe('production');
	});
});
