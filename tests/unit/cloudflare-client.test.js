/* global jest, describe, it, expect, beforeEach, afterEach */
'use strict';

const mockCreate = jest.fn();
jest.mock('openai', () => {
	return jest.fn().mockImplementation(() => {
		return {
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		};
	});
});

const { getCloudflareAiClient, CloudflareAiClient } = require('../../src/services/inference/cloudflareAiClient');

describe('CloudflareAiClient', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		jest.resetModules();
		jest.clearAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('validate', () => {
		it('should return false if token is missing', () => {
			const client = new CloudflareAiClient();
			client.apiKey = undefined;
			client.baseURL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';
			client.model = 'google-ai-studio/gemini-2.5-flash';
			expect(client.validate()).toBe(false);
		});

		it('should return false if baseURL is missing', () => {
			const client = new CloudflareAiClient();
			client.apiKey = 'test-token';
			client.baseURL = undefined;
			client.model = 'google-ai-studio/gemini-2.5-flash';
			expect(client.validate()).toBe(false);
		});

		it('should return false if model is missing', () => {
			const client = new CloudflareAiClient();
			client.apiKey = 'test-token';
			client.baseURL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';
			client.model = undefined;
			expect(client.validate()).toBe(false);
		});

		it('should return true if all required properties are set', () => {
			const client = new CloudflareAiClient();
			client.apiKey = 'test-token';
			client.baseURL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';
			client.model = 'google-ai-studio/gemini-2.5-flash';
			expect(client.validate()).toBe(true);
		});
	});

	describe('chatCompletion', () => {
		it('should call openai completions create with correct parameters and return content', async () => {
			const client = new CloudflareAiClient();
			client.apiKey = 'test-token';
			client.baseURL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';
			client.model = 'google-ai-studio/gemini-2.5-flash';

			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: 'mock completion response' } }],
				usage: { prompt_tokens: 10, completion_tokens: 20 },
			});

			const result = await client.chatCompletion('system rules', 'user query');

			expect(mockCreate).toHaveBeenCalledWith({
				model: 'google-ai-studio/gemini-2.5-flash',
				messages: [
					{ role: 'system', content: 'system rules' },
					{ role: 'user', content: 'user query' },
				],
				temperature: 0.7,
				top_p: 1.0,
			});
			expect(result).toEqual({
				text: 'mock completion response',
				usage: { prompt_tokens: 10, completion_tokens: 20 },
			});
		});

		it('should throw if validation fails', async () => {
			const client = new CloudflareAiClient();
			client.apiKey = undefined;

			await expect(client.chatCompletion('system', 'user')).rejects.toThrow(
				'CloudflareAiClient configuration incomplete'
			);
		});
	});

	describe('parseJsonResponse', () => {
		it('should extract and parse JSON from string response', () => {
			const client = new CloudflareAiClient();
			const response = 'Some text before {"key": "value"} some text after';
			expect(client.parseJsonResponse(response)).toEqual({ key: 'value' });
		});

		it('should throw error if no JSON is found', () => {
			const client = new CloudflareAiClient();
			expect(() => client.parseJsonResponse('no json here')).toThrow('No JSON found in response');
		});
	});

	describe('healthCheck', () => {
		it('should return true if request succeeds', async () => {
			const client = new CloudflareAiClient();
			client.apiKey = 'test-token';
			client.baseURL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';
			client.model = 'google-ai-studio/gemini-2.5-flash';

			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: 'pong' } }],
			});

			const result = await client.healthCheck();
			expect(result).toBe(true);
		});

		it('should return false if request throws', async () => {
			const client = new CloudflareAiClient();
			client.apiKey = 'test-token';
			client.baseURL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';
			client.model = 'google-ai-studio/gemini-2.5-flash';

			mockCreate.mockRejectedValueOnce(new Error('Connection failed'));

			const result = await client.healthCheck();
			expect(result).toBe(false);
		});
	});
});
