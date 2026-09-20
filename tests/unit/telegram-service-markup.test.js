'use strict';

const TelegramService = require('../../src/services/notification/TelegramService');

function buildMockBot(responses = [{ message_id: 1 }]) {
	return {
		telegram: {
			sendMessage: jest.fn().mockImplementation(() => {
				const next = responses.length > 1 ? responses.shift() : responses[0];
				return Promise.resolve(next);
			}),
		},
	};
}

describe('TelegramService inline reply_markup', () => {
	it('attaches reply_markup to the first chunk and skips it on subsequent chunks', async () => {
		const bot = buildMockBot([{ message_id: 1 }, { message_id: 2 }, { message_id: 3 }]);
		const service = new TelegramService({
			bot,
			chatId: 'chat-1',
			maxMessageLength: 10,
			formatter: { format: (text) => text },
		});

		const replyMarkup = {
			inline_keyboard: [
				[{ text: 'OK', callback_data: 'r:ABCDEFGH' }],
			],
		};

		const result = await service.send({
			text: '1234567890abcdefghijZ',
			replyMarkup,
		});

		expect(result.success).toBe(true);
		expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(3);
		const firstCallExtra = bot.telegram.sendMessage.mock.calls[0][2];
		const secondCallExtra = bot.telegram.sendMessage.mock.calls[1][2];
		const thirdCallExtra = bot.telegram.sendMessage.mock.calls[2][2];
		expect(firstCallExtra.reply_markup).toEqual(replyMarkup);
		expect(secondCallExtra).not.toHaveProperty('reply_markup');
		expect(thirdCallExtra).not.toHaveProperty('reply_markup');
	});

	it('does not attach reply_markup when alert has no replyMarkup', async () => {
		const bot = buildMockBot([{ message_id: 11 }]);
		const service = new TelegramService({
			bot,
			chatId: 'chat-1',
			formatter: { format: (text) => text },
		});

		const result = await service.send({ text: 'no buttons' });

		expect(result.success).toBe(true);
		const extra = bot.telegram.sendMessage.mock.calls[0][2];
		expect(extra).not.toHaveProperty('reply_markup');
	});

	it('ignores non-object replyMarkup values without throwing', async () => {
		const bot = buildMockBot([{ message_id: 12 }]);
		const service = new TelegramService({
			bot,
			chatId: 'chat-1',
			formatter: { format: (text) => text },
		});

		const result = await service.send({ text: 'invalid', replyMarkup: 'not-an-object' });

		expect(result.success).toBe(true);
		const extra = bot.telegram.sendMessage.mock.calls[0][2];
		expect(extra).not.toHaveProperty('reply_markup');
	});

	it('preserves reply_markup during the MarkdownV2 parse-failure plain-text fallback', async () => {
		const fallbackBot = {
			telegram: {
				sendMessage: jest.fn()
					.mockRejectedValueOnce({ description: "Bad Request: can't parse entities" })
					.mockResolvedValueOnce({ message_id: 13 }),
			},
		};
		const service = new TelegramService({
			bot: fallbackBot,
			chatId: 'chat-1',
			formatter: { format: (text) => text },
		});

		const replyMarkup = {
			inline_keyboard: [
				[{ text: 'OK', callback_data: 'r:ABCDEFGH' }],
			],
		};

		const result = await service.send({
			text: '*unbalanced bold',
			replyMarkup,
		});

		expect(result.success).toBe(true);
		const fallbackExtra = fallbackBot.telegram.sendMessage.mock.calls[1][2];
		expect(fallbackExtra.reply_markup).toEqual(replyMarkup);
	});
});
