const TelegramService = require('../../src/services/notification/TelegramService');

describe('TelegramService', () => {
	let mockBot;
	let service;

	beforeEach(() => {
		mockBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockResolvedValueOnce({ message_id: 101 })
					.mockResolvedValueOnce({ message_id: 102 })
					.mockResolvedValueOnce({ message_id: 103 }),
			},
		};
		service = new TelegramService({
			bot: mockBot,
			chatId: 'chat-1',
			maxMessageLength: 10,
			formatter: {
				format: (text) => text,
			},
		});
	});

	it('splits long formatted text into sequential Telegram messages', async () => {
		const result = await service.send({ text: '1234567890abcdefghijZ' });

		expect(result).toEqual(expect.objectContaining({
			success: true,
			channel: 'telegram',
			messageId: '101,102,103',
			messageIds: ['101', '102', '103'],
			messageCount: 3,
		}));
		expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(3);
		mockBot.telegram.sendMessage.mock.calls.forEach((call) => {
			expect(call[1].length).toBeLessThanOrEqual(10);
		});
	});

	it('falls back to plain text when MarkdownV2 parse fails', async () => {
		const parseErrorBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockRejectedValueOnce({
						description: "Bad Request: can't parse entities: Can't find end of Bold entity at byte offset 10",
					})
					.mockResolvedValueOnce({ message_id: 201 }),
			},
		};
		const fallbackService = new TelegramService({
			bot: parseErrorBot,
			chatId: 'chat-1',
			formatter: {
				format: (text) => text,
			},
			logger: { warn: jest.fn(), error: jest.fn() },
		});

		const result = await fallbackService.send({ text: '*unbalanced bold' });

		expect(result).toEqual(expect.objectContaining({
			success: true,
			channel: 'telegram',
			messageId: '201',
		}));
		// First call with MarkdownV2, second call as plain text
		expect(parseErrorBot.telegram.sendMessage).toHaveBeenCalledTimes(2);
		expect(parseErrorBot.telegram.sendMessage.mock.calls[0][0]).toBe('chat-1');
		expect(parseErrorBot.telegram.sendMessage.mock.calls[0][2]).toEqual({
			parse_mode: 'MarkdownV2',
			disable_web_page_preview: false,
		});
		expect(parseErrorBot.telegram.sendMessage.mock.calls[1][0]).toBe('chat-1');
		expect(parseErrorBot.telegram.sendMessage.mock.calls[1][2]).toEqual({
			disable_web_page_preview: false,
		});
	});

	it('removes MarkdownV2 escape characters from the plain-text fallback', async () => {
		const parseErrorBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockRejectedValueOnce({
						description: "Bad Request: can't parse entities",
					})
					.mockResolvedValueOnce({ message_id: 203 }),
			},
		};
		const fallbackService = new TelegramService({
			bot: parseErrorBot,
			chatId: 'chat-1',
			formatter: {
				format: () => 'Price: BTC\\_USDT\\. A\\&B \\< C:\\\\temp',
			},
		});

		await expect(fallbackService.send({ text: 'ignored' })).resolves.toEqual(expect.objectContaining({
			success: true,
			statusCode: 200,
			category: 'SUCCESS',
			attemptCount: 2,
			durationMs: expect.any(Number),
		}));
		expect(parseErrorBot.telegram.sendMessage.mock.calls[1][1]).toBe('Price: BTC_USDT. A&B < C:\\temp');
	});

	it('retries Telegram 429 responses using retry_after and returns delivery telemetry', async () => {
		const retryBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockRejectedValueOnce({
						response: {
							error_code: 429,
							description: 'Too Many Requests',
							parameters: { retry_after: 0.01 },
						},
					})
					.mockResolvedValueOnce({ message_id: 204 }),
			},
		};
		const retryService = new TelegramService({
			bot: retryBot,
			chatId: 'chat-1',
			formatter: { format: (text) => text },
			maxRetries: 2,
			maxRetryDelayMs: 1000,
			maxTotalRetryWaitMs: 2000,
			logger: { warn: jest.fn() },
		});

		await expect(retryService.send({ text: 'retry me' })).resolves.toEqual(expect.objectContaining({
			success: true,
			statusCode: 200,
			category: 'SUCCESS',
			attemptCount: 2,
			durationMs: expect.any(Number),
		}));
		expect(retryBot.telegram.sendMessage).toHaveBeenCalledTimes(2);
	});

	it('does not retry ambiguous Telegram transport failures', async () => {
		const transientBot = {
			telegram: {
				sendMessage: jest.fn().mockRejectedValue(new Error('socket reset')),
			},
		};
		const transientService = new TelegramService({
			bot: transientBot,
			chatId: 'chat-1',
			formatter: { format: (text) => text },
			maxRetries: 2,
			fallbackRetryDelayMs: 1,
			maxRetryDelayMs: 100,
			maxTotalRetryWaitMs: 100,
		});

		await expect(transientService.send({ text: 'ambiguous transport' })).resolves.toEqual(expect.objectContaining({
			success: false,
			attemptCount: 1,
			statusCode: null,
			category: 'PROVIDER_ERROR',
		}));
		expect(transientBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('does not exceed the retry wait budget for Telegram 429 responses', async () => {
		const limitedBot = {
			telegram: {
				sendMessage: jest.fn().mockRejectedValue({
					response: {
						error_code: 429,
						description: 'Too Many Requests',
						parameters: { retry_after: 5 },
					},
				}),
			},
		};
		const limitedService = new TelegramService({
			bot: limitedBot,
			chatId: 'chat-1',
			formatter: { format: (text) => text },
			maxRetries: 2,
			maxRetryDelayMs: 10000,
			maxTotalRetryWaitMs: 50,
		});

		await expect(limitedService.send({ text: 'rate limited' })).resolves.toEqual(expect.objectContaining({
			success: false,
			statusCode: 429,
			category: 'RATE_LIMITED',
			attemptCount: 1,
			durationMs: expect.any(Number),
		}));
		expect(limitedBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('shares the retry wait budget across message chunks', async () => {
		const chunkedBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockRejectedValueOnce({
						response: {
							error_code: 429,
							description: 'Too Many Requests',
							parameters: { retry_after: 0.01 },
						},
					})
					.mockResolvedValueOnce({ message_id: 206 })
					.mockRejectedValueOnce({
						response: {
							error_code: 429,
							description: 'Too Many Requests',
							parameters: { retry_after: 0.01 },
						},
					})
					.mockResolvedValueOnce({ message_id: 207 }),
			},
		};
		const chunkedService = new TelegramService({
			bot: chunkedBot,
			chatId: 'chat-1',
			maxMessageLength: 5,
			maxRetries: 2,
			maxRetryDelayMs: 100,
			maxTotalRetryWaitMs: 10,
			formatter: { format: (text) => text },
		});

		await expect(chunkedService.send({ text: '1234567890' })).resolves.toEqual(expect.objectContaining({
			success: false,
			statusCode: 429,
			category: 'RATE_LIMITED',
			attemptCount: 3,
		}));
		expect(chunkedBot.telegram.sendMessage).toHaveBeenCalledTimes(3);
	});

	it('uses telegramChatId override for both MarkdownV2 attempt and plain-text fallback', async () => {
		const parseErrorBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockRejectedValueOnce({
						description: "Bad Request: can't parse entities: Can't find end of Bold entity at byte offset 10",
					})
					.mockResolvedValueOnce({ message_id: 202 }),
			},
		};
		const fallbackService = new TelegramService({
			bot: parseErrorBot,
			chatId: 'chat-default',
			formatter: {
				format: (text) => text,
			},
			logger: { warn: jest.fn(), error: jest.fn() },
		});

		const result = await fallbackService.send({
			text: '*unbalanced bold',
			telegramChatId: 'chat-override-999',
		});

		expect(result).toEqual(expect.objectContaining({
			success: true,
			channel: 'telegram',
			messageId: '202',
		}));
		expect(parseErrorBot.telegram.sendMessage).toHaveBeenCalledTimes(2);
		expect(parseErrorBot.telegram.sendMessage.mock.calls[0][0]).toBe('chat-override-999');
		expect(parseErrorBot.telegram.sendMessage.mock.calls[1][0]).toBe('chat-override-999');
	});

	it('does not fall back to plain text for non-parse Telegram errors', async () => {
		const otherErrorBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockRejectedValueOnce(new Error('Telegram API timeout')),
			},
		};
		const fallbackService = new TelegramService({
			bot: otherErrorBot,
			chatId: 'chat-1',
			maxRetries: 0,
			formatter: {
				format: (text) => text,
			},
			logger: { warn: jest.fn(), error: jest.fn() },
		});

		const result = await fallbackService.send({ text: 'normal text' });

		expect(result.success).toBe(false);
		expect(result.error).toContain('Telegram error');
		expect(otherErrorBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('passes an external abort signal to Telegraf callApi', async () => {
		const signal = new AbortController().signal;
		const callApi = jest.fn().mockResolvedValue({ message_id: 301 });
		const signalBot = {
			telegram: {
				sendMessage: jest.fn(),
				callApi,
			},
		};
		const signalService = new TelegramService({
			bot: signalBot,
			chatId: 'chat-1',
			formatter: { format: (text) => text },
		});

		await expect(signalService.send({ text: 'lease-aware alert' }, { signal })).resolves.toEqual(
			expect.objectContaining({ success: true, messageId: '301' }),
		);
		expect(callApi).toHaveBeenCalledWith(
			'sendMessage',
			{
				chat_id: 'chat-1',
				parse_mode: 'MarkdownV2',
				disable_web_page_preview: false,
				text: 'lease-aware alert',
			},
			{ signal },
		);
		expect(signalBot.telegram.sendMessage).not.toHaveBeenCalled();
	});
});
