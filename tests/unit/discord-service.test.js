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
				attemptCount: 1,
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

		it('returns a failed result when the webhook responds with a non-429 error', async () => {
			global.fetch.mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => 'bad request',
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.channel).toBe('discord');
			expect(result.error).toContain('Discord webhook 400');
			expect(result.attemptCount).toBe(1);
			expect(global.fetch).toHaveBeenCalledTimes(1);
		});

		it('retries on HTTP 429 when Retry-After header is provided and succeeds on subsequent attempt', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				maxRetryDelayMs: 1000,
				maxTotalRetryWaitMs: 2000,
			});
			await service.validate();

			const headers = new Map([['retry-after', '0.01']]);
			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 429,
					headers,
					text: async () => 'rate limited header',
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
				attemptCount: 2,
			});
			expect(global.fetch).toHaveBeenCalledTimes(2);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('429'),
			);
		});

		it('retries on HTTP 429 when retry_after JSON body is provided', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				maxRetryDelayMs: 1000,
				maxTotalRetryWaitMs: 2000,
			});
			await service.validate();

			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 429,
					headers: new Map(),
					text: async () => JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.01 }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'discord-msg-body-retried' }),
				});

			const result = await service.send({ text: 'Discord alert' });

			expect(result).toEqual({
				success: true,
				channel: 'discord',
				messageId: 'discord-msg-body-retried',
				messageIds: ['discord-msg-body-retried'],
				messageCount: 1,
				attemptCount: 2,
			});
			expect(global.fetch).toHaveBeenCalledTimes(2);
		});

		it('fails gracefully when HTTP 429 retries are exhausted', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				maxRetryDelayMs: 1000,
				maxTotalRetryWaitMs: 2000,
			});
			await service.validate();

			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				headers: new Map([['retry-after', '0.01']]),
				text: async () => 'rate limited repeatedly',
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.channel).toBe('discord');
			expect(result.statusCode).toBe(429);
			expect(result.error).toContain('Discord webhook 429');
			expect(result.attemptCount).toBe(3);
			// Initial attempt + 2 retries = 3 total fetch calls
			expect(global.fetch).toHaveBeenCalledTimes(3);
		});

		it('uses fallback delay when 429 retry hints are missing or malformed', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 1,
				fallbackRetryDelayMs: 10,
				maxRetryDelayMs: 1000,
				maxTotalRetryWaitMs: 2000,
			});
			await service.validate();

			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 429,
					headers: new Map(),
					text: async () => 'not json',
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'discord-msg-fallback-ok' }),
				});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(true);
			expect(result.messageId).toBe('discord-msg-fallback-ok');
			expect(global.fetch).toHaveBeenCalledTimes(2);
		});

		it('aborts retry loop if retry delay exceeds max total wait budget', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 3,
				maxRetryDelayMs: 10000,
				maxTotalRetryWaitMs: 50,
			});
			await service.validate();

			const headers = new Map([['retry-after', '5']]); // 5 seconds = 5000ms > maxTotalRetryWaitMs (50ms)
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				headers,
				text: async () => 'huge delay rate limit',
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.statusCode).toBe(429);
			expect(result.attemptCount).toBe(1);
			expect(global.fetch).toHaveBeenCalledTimes(1);
		});

		it('aborts retry loop without retrying early if retry delay exceeds maxRetryDelayMs budget', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 3,
				maxRetryDelayMs: 5000,
				maxTotalRetryWaitMs: 60000,
			});
			await service.validate();

			const headers = new Map([['retry-after', '30']]); // 30 seconds = 30000ms > maxRetryDelayMs (5000ms)
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				headers,
				text: async () => JSON.stringify({ message: 'You are being rate limited.', retry_after: 30 }),
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.statusCode).toBe(429);
			expect(result.error).toContain('Discord webhook 429');
			expect(result.attemptCount).toBe(1);
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('exceeds max retry delay limit'),
			);
		});

		it('aborts retry loop without retrying early if retry_after in JSON body exceeds maxRetryDelayMs budget', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 3,
				maxRetryDelayMs: 2000,
				maxTotalRetryWaitMs: 60000,
			});
			await service.validate();

			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				headers: new Map(),
				text: async () => JSON.stringify({ message: 'Rate limited', retry_after: 10 }),
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.statusCode).toBe(429);
			expect(global.fetch).toHaveBeenCalledTimes(1);
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
				attemptCount: 2,
			});
			expect(global.fetch).toHaveBeenCalledTimes(2);
			global.fetch.mock.calls.forEach((call) => {
				const payload = JSON.parse(call[1].body);
				expect(payload.content.length).toBeLessThanOrEqual(2000);
			});
		});
	});
});
