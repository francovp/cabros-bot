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
});
