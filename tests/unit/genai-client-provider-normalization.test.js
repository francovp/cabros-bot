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
				usage: {},
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
	});
});
