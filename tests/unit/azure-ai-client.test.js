/* global jest, describe, it, expect, beforeEach, afterEach */
'use strict';

const mockPost = jest.fn();
const mockGet = jest.fn();
const mockPath = jest.fn((p) => {
	if (p === '/chat/completions') {
		return { post: mockPost };
	}
	if (p === '/models') {
		return { get: mockGet };
	}
	return {};
});
const mockModelClient = jest.fn(() => ({
	path: mockPath,
}));

const mockIsUnexpected = jest.fn((response) => response?.status !== '200');

jest.mock('@azure-rest/ai-inference', () => {
	return {
		__esModule: true,
		default: mockModelClient,
		isUnexpected: mockIsUnexpected,
	};
});

jest.mock('@azure/core-auth', () => ({
	AzureKeyCredential: jest.fn(key => ({ key })),
}));

const { AzureAIClient } = require('../../src/services/inference/azureAiClient');

describe('AzureAIClient', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		jest.resetModules();
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		mockIsUnexpected.mockImplementation((response) => response?.status !== '200');
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('validate', () => {
		it('should return false if endpoint is missing', () => {
			const client = new AzureAIClient();
			client.endpoint = undefined;
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';
			expect(client.validate()).toBe(false);
		});

		it('should return false if apiKey is missing', () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = undefined;
			client.model = 'gpt-4o-mini';
			expect(client.validate()).toBe(false);
		});

		it('should return false if model is missing', () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = undefined;
			expect(client.validate()).toBe(false);
		});

		it('should return true if all required properties are set', () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';
			expect(client.validate()).toBe(true);
		});
	});

	describe('chatCompletion', () => {
		it('should call ModelClient post with correct parameters, default timeout, and return content', async () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';

			mockPost.mockResolvedValueOnce({
				status: '200',
				body: {
					choices: [{ message: { content: 'azure completion' } }],
					usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
				},
			});

			const result = await client.chatCompletion('system rules', 'user query');

			expect(mockModelClient).toHaveBeenCalledWith(
				'https://azure.models.ai.azure.com',
				expect.objectContaining({ key: 'test-key' }),
			);
			expect(mockPath).toHaveBeenCalledWith('/chat/completions');
			expect(mockPost).toHaveBeenCalledWith({
				body: {
					messages: [
						{ role: 'system', content: 'system rules' },
						{ role: 'user', content: 'user query' },
					],
					model: 'gpt-4o-mini',
					temperature: 0.7,
					top_p: 1.0,
				},
				timeout: 10000,
			});
			expect(result).toEqual({
				text: 'azure completion',
				usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
			});
		});

		it('should pass custom abortSignal and timeout into requestOptions', async () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';

			const controller = new AbortController();

			mockPost.mockResolvedValueOnce({
				status: '200',
				body: {
					choices: [{ message: { content: 'bounded completion' } }],
					usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
				},
			});

			const result = await client.chatCompletion('system', 'user', {
				signal: controller.signal,
				timeout: 5000,
			});

			expect(mockPost).toHaveBeenCalledWith(
				expect.objectContaining({
					abortSignal: controller.signal,
					timeout: 5000,
				}),
			);
			expect(result.text).toBe('bounded completion');
		});

		it('should rethrow when request rejects on aborted signal', async () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';

			const controller = new AbortController();
			const abortError = new Error('The operation was aborted');
			abortError.name = 'AbortError';

			mockPost.mockRejectedValueOnce(abortError);

			await expect(
				client.chatCompletion('system', 'user', { signal: controller.signal }),
			).rejects.toThrow('The operation was aborted');
		});

		it('should throw if response is unexpected error status', async () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';

			mockPost.mockResolvedValueOnce({
				status: '500',
				body: {
					error: { message: 'Internal Azure error', code: 'InternalServerError' },
				},
			});

			await expect(client.chatCompletion('system', 'user')).rejects.toThrow(
				'Internal Azure error',
			);
		});

		it('should throw if validation fails', async () => {
			const client = new AzureAIClient();
			client.apiKey = undefined;

			await expect(client.chatCompletion('system', 'user')).rejects.toThrow(
				'AzureAIClient configuration incomplete',
			);
		});
	});

	describe('parseJsonResponse', () => {
		it('should extract and parse JSON from string response', () => {
			const client = new AzureAIClient();
			const response = 'Answer: {"confidence": 0.9, "reasoning": "Solid news"} done';
			expect(client.parseJsonResponse(response)).toEqual({
				confidence: 0.9,
				reasoning: 'Solid news',
			});
		});

		it('should throw error if no JSON is found', () => {
			const client = new AzureAIClient();
			expect(() => client.parseJsonResponse('No JSON')).toThrow('No JSON found in response');
		});
	});

	describe('healthCheck', () => {
		it('should return true if models endpoint responds successfully', async () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';

			mockGet.mockResolvedValueOnce({
				status: '200',
				body: [{ id: 'gpt-4o-mini' }],
			});

			const result = await client.healthCheck();
			expect(result).toBe(true);
			expect(mockPath).toHaveBeenCalledWith('/models');
		});

		it('should return false if models endpoint throws', async () => {
			const client = new AzureAIClient();
			client.endpoint = 'https://azure.models.ai.azure.com';
			client.apiKey = 'test-key';
			client.model = 'gpt-4o-mini';

			mockGet.mockRejectedValueOnce(new Error('Connection error'));

			const result = await client.healthCheck();
			expect(result).toBe(false);
		});

		it('should return false if validation fails', async () => {
			const client = new AzureAIClient();
			client.apiKey = undefined;

			const result = await client.healthCheck();
			expect(result).toBe(false);
		});
	});
});
