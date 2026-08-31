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

			expect(result.valid).toBe(true);
			expect(result.message).toBe('Discord configured');
			expect(service.isEnabled()).toBe(true);
		});
	});

	describe('send', () => {
		beforeEach(async () => {
			process.env.ENABLE_DISCORD_ALERTS = 'true';
			process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ id: 'discord-probe' }),
			});
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

		it('posts message content to per-request webhook override when discordWebhookUrl is provided in alert', async () => {
			global.fetch.mockResolvedValue({
				ok: true,
				json: async () => ({ id: 'discord-msg-override' }),
			});

			const customWebhook = 'https://discord.com/api/webhooks/999/override-token';
			const result = await service.send({ text: 'Custom Discord alert', discordWebhookUrl: customWebhook });

			expect(result).toEqual({
				success: true,
				channel: 'discord',
				messageId: 'discord-msg-override',
				messageIds: ['discord-msg-override'],
				messageCount: 1,
			});
			expect(global.fetch).toHaveBeenCalledWith(
				'https://discord.com/api/webhooks/999/override-token?wait=true',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content: 'Custom Discord alert' }),
					signal: expect.any(AbortSignal),
				}),
			);
		});

		it('returns a failed result when the webhook responds with a non-429 error', async () => {
			global.fetch.mockReset();
			global.fetch.mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => 'bad request',
			});

			const result = await service.send({ text: 'Discord alert' });

			expect(result.success).toBe(false);
			expect(result.channel).toBe('discord');
			expect(result.error).toContain('Discord webhook 400');
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

		it('returns cumulative attempts when a later message chunk exhausts 429 retries', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 2,
				maxRetryDelayMs: 1000,
				maxTotalRetryWaitMs: 2000,
			});
			await service.validate();

			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'discord-first-chunk' }),
				})
				.mockResolvedValue({
					ok: false,
					status: 429,
					headers: new Map([['retry-after', '0.01']]),
					text: async () => 'rate limited later chunk',
				});

			const result = await service.send({ text: `${'A'.repeat(1995)} ${'B'.repeat(1995)}` });

			expect(result.success).toBe(false);
			expect(result.statusCode).toBe(429);
			expect(result.attemptCount).toBe(4);
			expect(global.fetch).toHaveBeenCalledTimes(4);
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
			});
			expect(global.fetch).toHaveBeenCalledTimes(2);
			global.fetch.mock.calls.forEach((call) => {
				const payload = JSON.parse(call[1].body);
				expect(payload.content.length).toBeLessThanOrEqual(2000);
			});
		});
	});

	describe('multi-webhook failover', () => {
		const PRIMARY = 'https://discord.com/api/webhooks/111/primary';
		const SECONDARY = 'https://discord.com/api/webhooks/222/secondary';
		const TERTIARY = 'https://discord.com/api/webhooks/333/tertiary';

		beforeEach(() => {
			process.env.ENABLE_DISCORD_ALERTS = 'true';
			delete process.env.DISCORD_WEBHOOK_URL;
			process.env.DISCORD_WEBHOOK_URLS = `${PRIMARY},${SECONDARY},${TERTIARY}`;
		});

		afterEach(() => {
			delete process.env.DISCORD_WEBHOOK_URLS;
		});

		it('parses DISCORD_WEBHOOK_URLS into webhookUrls and rotates round-robin across calls', async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ id: 'msg' }),
			});

			service = new DiscordService({ logger: mockLogger });
			await service.validate();

			expect(service.webhookUrls).toEqual([PRIMARY, SECONDARY, TERTIARY]);

			global.fetch.mockClear();
			await service.send({ text: 'first' });
			await service.send({ text: 'second' });
			await service.send({ text: 'third' });

			const sendUrls = global.fetch.mock.calls
				.filter((call) => call[1] && call[1].method === 'POST')
				.map((call) => call[0].split('?')[0]);
			expect(sendUrls).toEqual([PRIMARY, SECONDARY, TERTIARY]);
		});

		it('skips a failing URL and succeeds on the next healthy one', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxUnhealthyDurationMs: 60000,
			});
			await service.validate();
			global.fetch.mockReset();
			global.fetch = jest.fn().mockImplementation(async (url) => {
				if (url.startsWith(PRIMARY)) {
					return {
						ok: false,
						status: 503,
						text: async () => 'service unavailable',
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: 'msg-secondary' }),
				};
			});

			const result = await service.send({ text: 'failover me' });

			expect(result.success).toBe(true);
			expect(result.messageId).toBe('msg-secondary');
			const calledUrls = global.fetch.mock.calls.map((call) => call[0].split('?')[0]);
			expect(calledUrls).toContain(PRIMARY);
			expect(calledUrls).toContain(SECONDARY);
		});

		it('marks a failing webhook unhealthy and avoids it on the next attempt', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxUnhealthyDurationMs: 60000,
			});
			await service.validate();
			global.fetch.mockReset();
			let primaryCalls = 0;
			global.fetch = jest.fn().mockImplementation(async (url) => {
				if (url.startsWith(PRIMARY)) {
					primaryCalls += 1;
					return {
						ok: false,
						status: 503,
						text: async () => 'service unavailable',
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: 'msg-secondary' }),
				};
			});

			await service.send({ text: 'failover me once' });
			const firstAttemptCount = primaryCalls;
			expect(firstAttemptCount).toBeGreaterThanOrEqual(1);

			await service.send({ text: 'failover me twice' });

			expect(primaryCalls).toBe(firstAttemptCount);

			const status = service.getStatus();
			const primaryEntry = status.webhooks.find((entry) => entry.url === PRIMARY);
			expect(primaryEntry.healthy).toBe(false);
			expect(primaryEntry.lastError).toContain('503');
		});

		it('returns the last failure when every webhook fails', async () => {
			service = new DiscordService({ logger: mockLogger });
			await service.validate();
			global.fetch.mockReset();
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => 'broken',
			});

			const result = await service.send({ text: 'all broken' });

			expect(result.success).toBe(false);
			expect(result.statusCode).toBe(500);
			expect(global.fetch).toHaveBeenCalled();
		});

		it('does not try a second webhook on HTTP 429 (definitive rate-limit response)', async () => {
			service = new DiscordService({
				logger: mockLogger,
				maxRetries: 0,
				maxRetryDelayMs: 1000,
				maxTotalRetryWaitMs: 2000,
			});
			await service.validate();
			global.fetch.mockReset();
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				headers: new Map([['retry-after', '0.001']]),
				text: async () => 'rate limited',
			});

			const result = await service.send({ text: 'rate limited' });

			expect(result.success).toBe(false);
			expect(result.statusCode).toBe(429);
			expect(global.fetch).toHaveBeenCalledTimes(1);
		});

		it('rejects invalid alert override URLs', async () => {
			service = new DiscordService({ logger: mockLogger });
			await service.validate();
			global.fetch.mockReset();

			const result = await service.send({ text: 'test', discordWebhookUrl: 'http://example.com/webhook' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid');
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it('treats invalid DISCORD_WEBHOOK_URLS entries as disabled without breaking the service', async () => {
			process.env.DISCORD_WEBHOOK_URLS = 'not-a-url, https://discord.com/api/webhooks/444/legit';
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ id: 'legit-msg' }),
			});

			service = new DiscordService({ logger: mockLogger });
			await service.validate();

			expect(service.webhookUrls).toEqual(['https://discord.com/api/webhooks/444/legit']);

			const result = await service.send({ text: 'test' });
			expect(result.success).toBe(true);
		});
	});

	describe('validate health probe', () => {
		beforeEach(() => {
			process.env.ENABLE_DISCORD_ALERTS = 'true';
			process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
		});

		it('keeps the service enabled when only some webhooks respond to the probe', async () => {
			global.fetch = jest.fn().mockResolvedValueOnce({
				ok: false,
				status: 404,
				text: async () => 'not found',
			});
			service = new DiscordService({ logger: mockLogger });

			const result = await service.validate();

			expect(result.valid).toBe(true);
			expect(result.message).toBe('Discord configured');
			expect(result.webhooks).toBeDefined();
			expect(result.webhooks[0].healthy).toBe(false);
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('health probe'));
		});

		it('exposes per-webhook health via getStatus()', async () => {
			process.env.DISCORD_WEBHOOK_URLS = 'https://discord.com/api/webhooks/1/a, https://discord.com/api/webhooks/2/b';
			delete process.env.DISCORD_WEBHOOK_URL;
			global.fetch = jest.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({}),
			}).mockResolvedValueOnce({
				ok: false,
				status: 401,
				text: async () => 'unauthorized',
			});

			service = new DiscordService({ logger: mockLogger });
			await service.validate();

			const status = service.getStatus();
			expect(status.enabled).toBe(true);
			expect(status.rotationStrategy).toBe('round-robin');
			expect(status.webhookCount).toBe(2);
			expect(status.webhooks[0].healthy).toBe(true);
			expect(status.webhooks[1].healthy).toBe(false);
			expect(status.webhooks[1].lastError).toContain('401');
		});
	});
});
