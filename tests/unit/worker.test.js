'use strict';

const { stopNotificationBot } = require('../../worker');

describe('Render worker shutdown', () => {
	it('does not stop an unlaunched notification bot', () => {
		const bot = { stop: jest.fn() };

		stopNotificationBot(bot, 'SIGTERM');

		expect(bot.stop).not.toHaveBeenCalled();
	});

	it('stops a notification bot with an active polling transport', () => {
		const bot = { polling: {}, stop: jest.fn() };

		stopNotificationBot(bot, 'SIGTERM');

		expect(bot.stop).toHaveBeenCalledWith('SIGTERM');
	});
});
