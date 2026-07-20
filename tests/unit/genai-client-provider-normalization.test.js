'use strict';

describe('GenaiClient provider normalization', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		jest.resetModules();
		jest.clearAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('treats mixed-case MODEL_PROVIDER values as Azure at runtime', async () => {
		process.env.MODEL_PROVIDER = 'Azure';
		process.env.AZURE_LLM_KEY = 'azure-key';
		process.env.AZURE_LLM_MODEL = 'gpt-4o-mini';
		delete process.env.AZURE_LLM_ENDPOINT;

		const mockAzureClient = {
			validate: jest.fn().mockReturnValue(true),
			chatCompletion: jest.fn().mockResolvedValue({
				text: 'azure response',
				usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
			}),
		};

		jest.doMock('@google/genai', () => ({
			GoogleGenAI: jest.fn(() => ({
				models: {
					generateContent: jest.fn(),
				},
			})),
		}));
		jest.doMock('../../src/services/inference/azureAiClient', () => ({
			getAzureAIClient: jest.fn(() => mockAzureClient),
		}));
		jest.doMock('../../src/services/inference/openRouterClient', () => ({
			getOpenRouterClient: jest.fn(() => ({
				validate: jest.fn().mockReturnValue(false),
			})),
		}));

		const genaiClient = require('../../src/services/grounding/genaiClient');

		const result = await genaiClient.llmCallv2({
			systemPrompt: 'system',
			userPrompt: 'user',
		});

		expect(mockAzureClient.validate).toHaveBeenCalled();
		expect(mockAzureClient.chatCompletion).toHaveBeenCalledWith('system', 'user');
		expect(result.text).toBe('azure response');
		expect(result.modelUsed).toBe('gpt-4o-mini');
		expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
	});

	it.each([
		['openrouter', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'openrouter-model'],
		['cloudflare', 'CF_AIG_TOKEN', 'CF_AIG_MODEL', 'cloudflare-model'],
	])('returns normalized usage from the %s provider', async (provider, key, modelKey, model) => {
		process.env.MODEL_PROVIDER = provider;
		process.env[key] = 'provider-key';
		process.env[modelKey] = model;

		const mockProviderClient = {
			validate: jest.fn().mockReturnValue(true),
			chatCompletion: jest.fn().mockResolvedValue({
				text: `${provider} response`,
				usage: { prompt_tokens: 7, completion_tokens: 13, total_tokens: 20 },
			}),
		};

		jest.doMock('@google/genai', () => ({
			GoogleGenAI: jest.fn(() => ({ models: { generateContent: jest.fn() } })),
		}));
		jest.doMock('../../src/services/inference/azureAiClient', () => ({
			getAzureAIClient: jest.fn(() => ({ validate: jest.fn().mockReturnValue(false) })),
		}));
		jest.doMock('../../src/services/inference/openRouterClient', () => ({
			getOpenRouterClient: jest.fn(() => mockProviderClient),
		}));
		jest.doMock('../../src/services/inference/cloudflareAiClient', () => ({
			getCloudflareAiClient: jest.fn(() => mockProviderClient),
		}));

		const genaiClient = require('../../src/services/grounding/genaiClient');
		const result = await genaiClient.llmCallv2({ systemPrompt: 'system', userPrompt: 'user' });

		expect(mockProviderClient.chatCompletion).toHaveBeenCalledWith('system', 'user');
		expect(result).toEqual(expect.objectContaining({
			text: `${provider} response`,
			modelUsed: model,
			usage: { inputTokens: 7, outputTokens: 13, totalTokens: 20 },
		}));
	});
});
