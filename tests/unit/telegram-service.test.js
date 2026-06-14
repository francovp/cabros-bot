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
		expect(parseErrorBot.telegram.sendMessage.mock.calls[0][2]).toEqual({
			parse_mode: 'MarkdownV2',
			disable_web_page_preview: false,
		});
		expect(parseErrorBot.telegram.sendMessage.mock.calls[1][2]).toEqual({
			disable_web_page_preview: false,
		});
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
});
