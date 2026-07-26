const DiscordService = require('../../src/services/notification/DiscordService');

describe('DiscordService', () => {
	let service;
	let mockLogger;

	beforeEach(() => {
		mockLogger = {
			debug: jest.fn(),
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
		};
		delete process.env.ENABLE_DISCORD_ALERTS;
		delete process.env.DISCORD_WEBHOOK_URL;
		global.fetch = jest.fn();
		service = new DiscordService({ logger: mockLogger });
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('validate', () => {
		it('returns disabled when ENABLE_DISCORD_ALERTS is not true', async () => {
			const result = await service.validate();

			expect(result).toEqual({ valid: true, message: 'Discord disabled via env' });
			expect(service.isEnabled()).toBe(false);
		});

		it('returns invalid when DISCORD_WEBHOOK_URL is missing', async () => {
			process.env.ENABLE_DISCORD_ALERTS = 'true';
			service = new DiscordService({ logger: mockLogger });

			const result = await service.validate();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('Missing DISCORD_WEBHOOK_URL');
			expect(service.isEnabled()).toBe(false);
		});

		it('returns valid when all required env vars are present', async () => {
			process.env.ENABLE_DISCORD_ALERTS = 'true';
			process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
			service = new DiscordService({ logger: mockLogger });

			const result = await service.validate();

			expect(result).toEqual({ valid: true, message: 'Discord configured' });
			expect(service.isEnabled()).toBe(true);
		});
	});

	describe('send', () => {
		beforeEach(async () => {
			process.env.ENABLE_DISCORD_ALERTS = 'true';
			process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
			service = new DiscordService({ logger: mockLogger });
			await service.validate();
		});

		it('posts message content to the configured webhook', async () => {
			global.fetch.mockResolvedValue({
				ok: true,
				json: async () => ({ id: 'discord-msg-123' }),
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result).toEqual({
				success: true,
				channel: 'discord',
				messageId: 'discord-msg-123',
				messageIds: ['discord-msg-123'],
				messageCount: 1,
			});
			expect(global.fetch).toHaveBeenCalledWith(
				'https://discord.com/api/webhooks/123/token?wait=true',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content: 'Discord alert' }),
					signal: expect.any(AbortSignal),
				}),
			);
		});

		it('returns a failed result when the webhook responds with an error', async () => {
			global.fetch.mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => 'bad request',
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.channel).toBe('discord');
			expect(result.error).toContain('Discord webhook 400');
		});

		it('retries a rate-limited chunk using the Retry-After header', async () => {
			const sleep = jest.fn().mockResolvedValue(undefined);
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				sleep,
			});
			await service.validate();
			global.fetch
				.mockResolvedValueOnce({
					ok: false,
					status: 429,
					headers: { get: () => '0.25' },
					text: async () => JSON.stringify({ retry_after: 0.25 }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'discord-msg-retried' }),
				});

			const result = await service.send({ text: 'Discord alert' });

			expect(result).toEqual({
				success: true,
				channel: 'discord',
				messageId: 'discord-msg-retried',
				messageIds: ['discord-msg-retried'],
				messageCount: 1,
			});
			expect(sleep).toHaveBeenCalledWith(250);
			expect(global.fetch).toHaveBeenCalledTimes(2);
		});

		it('uses the JSON retry_after delay when the header is absent', async () => {
			const sleep = jest.fn().mockResolvedValue(undefined);
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 1,
				sleep,
			});
			await service.validate();
			global.fetch
				.mockResolvedValueOnce({
					ok: false,
					status: 429,
					headers: { get: () => null },
					text: async () => JSON.stringify({ retry_after: 0.4 }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'discord-msg-body-retried' }),
				});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(true);
			expect(result.messageId).toBe('discord-msg-body-retried');
			expect(sleep).toHaveBeenCalledWith(400);
			expect(global.fetch).toHaveBeenCalledTimes(2);
		});

		it('returns a structured rate-limit failure after bounded retries are exhausted', async () => {
			const sleep = jest.fn().mockResolvedValue(undefined);
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				sleep,
			});
			await service.validate();
			global.fetch.mockResolvedValue({
				ok: false,
				status: 429,
				headers: { get: () => '0.1' },
				text: async () => JSON.stringify({ retry_after: 0.1 }),
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result).toMatchObject({
				success: false,
				channel: 'discord',
				statusCode: 429,
				errorCode: 'DISCORD_RATE_LIMITED',
				attemptCount: 3,
			});
			expect(global.fetch).toHaveBeenCalledTimes(3);
			expect(sleep).toHaveBeenCalledTimes(2);
		});

		it('stops retrying when the total provider wait budget is exhausted', async () => {
			const sleep = jest.fn().mockResolvedValue(undefined);
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				maxRetryDelayMs: 1000,
				maxTotalRetryWaitMs: 1000,
				sleep,
			});
			await service.validate();
			global.fetch.mockResolvedValue({
				ok: false,
				status: 429,
				headers: { get: () => '0.8' },
				text: async () => JSON.stringify({ retry_after: 0.8 }),
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result).toMatchObject({
				success: false,
				statusCode: 429,
				errorCode: 'DISCORD_RATE_LIMITED',
				attemptCount: 2,
			});
			expect(global.fetch).toHaveBeenCalledTimes(2);
			expect(sleep).toHaveBeenCalledTimes(1);
		});

		it.each([
			['malformed JSON', 'not-json'],
			['missing delay', JSON.stringify({ message: 'rate limited' })],
			['invalid delay type', JSON.stringify({ retry_after: true })],
			['excessive delay', JSON.stringify({ retry_after: 10 })],
		])('does not retry when the Discord delay is %s', async (_caseName, body) => {
			const sleep = jest.fn().mockResolvedValue(undefined);
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				maxRetryDelayMs: 1000,
				sleep,
			});
			await service.validate();
			global.fetch.mockResolvedValue({
				ok: false,
				status: 429,
				headers: { get: () => null },
				text: async () => body,
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result).toMatchObject({
				success: false,
				channel: 'discord',
				statusCode: 429,
				errorCode: 'DISCORD_RATE_LIMITED',
				attemptCount: 1,
			});
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(sleep).not.toHaveBeenCalled();
		});

		it('returns a failed result when the webhook request times out', async () => {
			global.fetch.mockImplementation(async (_url, options) => {
				options.signal.dispatchEvent(new Event('abort'));
				const error = new Error('The operation was aborted');
				error.name = 'AbortError';
				throw error;
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.channel).toBe('discord');
			expect(result.error).toContain('Discord webhook request timeout');
		});

		it('splits long messages into multiple Discord webhook deliveries', async () => {
			service = new DiscordService({
				logger: mockLogger,
				timeoutMs: 1000,
			});
			await service.validate();
			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'discord-msg-1' }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'discord-msg-2' }),
				});

			const longMessage = `${'A'.repeat(1995)} ${'B'.repeat(1995)}`;
			const result = await service.send({ text: longMessage });

			expect(result).toEqual({
				success: true,
				channel: 'discord',
				messageId: 'discord-msg-1,discord-msg-2',
				messageIds: ['discord-msg-1', 'discord-msg-2'],
				messageCount: 2,
			});
			expect(global.fetch).toHaveBeenCalledTimes(2);
			global.fetch.mock.calls.forEach((call) => {
				const payload = JSON.parse(call[1].body);
				expect(payload.content.length).toBeLessThanOrEqual(2000);
			});
		});
	});
});
