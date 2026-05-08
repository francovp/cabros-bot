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
});