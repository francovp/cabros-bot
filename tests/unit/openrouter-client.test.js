/* global jest, describe, it, expect, beforeEach, afterEach */
'use strict';

const { OpenRouterClient } = require('../../src/services/inference/openRouterClient');

describe('OpenRouterClient', () => {
	const originalEnv = { ...process.env };
	const originalFetch = global.fetch;

	beforeEach(() => {
		jest.resetModules();
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		global.fetch = jest.fn();
	});

	afterEach(() => {
		process.env = originalEnv;
		global.fetch = originalFetch;
	});

	describe('validate', () => {
		it('should return false if apiKey is missing', () => {
			const client = new OpenRouterClient();
			client.apiKey = undefined;
			client.model = 'openrouter/model';
			expect(client.validate()).toBe(false);
		});

		it('should return false if model is missing', () => {
			const client = new OpenRouterClient();
			client.apiKey = 'test-key';
			client.model = undefined;
			expect(client.validate()).toBe(false);
		});

		it('should return true if both apiKey and model are set', () => {
			const client = new OpenRouterClient();
			client.apiKey = 'test-key';
			client.model = 'openrouter/model';
			expect(client.validate()).toBe(true);
		});
	});

	describe('chatCompletion', () => {
		it('should call fetch with authorization header, payload, and return content', async () => {
			const client = new OpenRouterClient();
			client.apiKey = 'test-key';
			client.model = 'openrouter/model';

			global.fetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					choices: [{ message: { content: 'openrouter completion' } }],
					usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
				}),
			});

			const result = await client.chatCompletion('system rules', 'user query');

			expect(global.fetch).toHaveBeenCalledWith(
				'https://openrouter.ai/api/v1/chat/completions',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer test-key',
						'Content-Type': 'application/json',
					}),
					body: JSON.stringify({
						model: 'openrouter/model',
						messages: [
							{ role: 'system', content: 'system rules' },
							{ role: 'user', content: 'user query' },
						],
						temperature: 0.7,
						top_p: 1.0,
					}),
				}),
			);
			expect(result).toEqual({
				text: 'openrouter completion',
				usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
			});
		});

		it('should forward abort signal to fetch and reject on aborted signal', async () => {
			const client = new OpenRouterClient();
			client.apiKey = 'test-key';
			client.model = 'openrouter/model';

			const controller = new AbortController();

			global.fetch.mockImplementation((url, options) => {
				return new Promise((resolve, reject) => {
					if (options?.signal?.aborted) {
						return reject(new Error('The operation was aborted'));
					}
					options?.signal?.addEventListener('abort', () => {
						const abortError = new Error('The operation was aborted');
						abortError.name = 'AbortError';
						reject(abortError);
					});
				});
			});

			const completionPromise = client.chatCompletion('system', 'user', {
				signal: controller.signal,
			});

			controller.abort();

			await expect(completionPromise).rejects.toThrow('The operation was aborted');
			expect(global.fetch).toHaveBeenCalledWith(
				'https://openrouter.ai/api/v1/chat/completions',
				expect.objectContaining({
					signal: controller.signal,
				}),
			);
		});

		it('should throw error when fetch responds with non-ok status', async () => {
			const client = new OpenRouterClient();
			client.apiKey = 'test-key';
			client.model = 'openrouter/model';

			global.fetch.mockResolvedValueOnce({
				ok: false,
				status: 429,
				statusText: 'Too Many Requests',
				text: async () => 'Rate limit exceeded',
			});

			await expect(client.chatCompletion('system', 'user')).rejects.toThrow(
				'OpenRouter API error: 429 Too Many Requests - Rate limit exceeded',
			);
		});

		it('should throw if validation fails', async () => {
			const client = new OpenRouterClient();
			client.apiKey = undefined;

			await expect(client.chatCompletion('system', 'user')).rejects.toThrow(
				'OpenRouterClient configuration incomplete',
			);
		});
	});

	describe('parseJsonResponse', () => {
		it('should extract and parse JSON from string response', () => {
			const client = new OpenRouterClient();
			const response = 'Here is the result: {"confidence": 0.85, "reasoning": "Strong signal"} done';
			expect(client.parseJsonResponse(response)).toEqual({
				confidence: 0.85,
				reasoning: 'Strong signal',
			});
		});

		it('should throw error if no JSON is found', () => {
			const client = new OpenRouterClient();
			expect(() => client.parseJsonResponse('No JSON available')).toThrow('No JSON found in response');
		});
	});

	describe('healthCheck', () => {
		it('should return true if models endpoint responds ok', async () => {
			const client = new OpenRouterClient();
			client.apiKey = 'test-key';
			client.model = 'openrouter/model';

			global.fetch.mockResolvedValueOnce({ ok: true });

			const result = await client.healthCheck();
			expect(result).toBe(true);
		});

		it('should return false if models endpoint throws', async () => {
			const client = new OpenRouterClient();
			client.apiKey = 'test-key';
			client.model = 'openrouter/model';

			global.fetch.mockRejectedValueOnce(new Error('Network error'));

			const result = await client.healthCheck();
			expect(result).toBe(false);
		});

		it('should return false if validation fails', async () => {
			const client = new OpenRouterClient();
			client.apiKey = undefined;

			const result = await client.healthCheck();
			expect(result).toBe(false);
		});
	});
});
