const {
	getTelegramCommandMenu,
	registerTelegramCommandMenu,
	launchTelegramBot,
} = require('../../src/lib/telegramCommandMenu');

describe('Telegram command menu', () => {
	it('registers the canonical command menu after Telegram startup', async () => {
		const telegram = { setMyCommands: jest.fn().mockResolvedValue(true) };

		await registerTelegramCommandMenu(telegram);

		expect(telegram.setMyCommands).toHaveBeenCalledWith(getTelegramCommandMenu());
	});

	it('logs and swallows Telegram menu registration failures', async () => {
		const error = new Error('Telegram API unavailable');
		const telegram = { setMyCommands: jest.fn().mockRejectedValue(error) };
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		await expect(registerTelegramCommandMenu(telegram)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith('[telegram] Failed to register command menu:', error.message);

		warn.mockRestore();
	});

	it('registers the menu from the startup launch promise', async () => {
		const telegram = { setMyCommands: jest.fn().mockResolvedValue(true) };
		const bot = { launch: jest.fn().mockResolvedValue(undefined), telegram };
		const onLaunchError = jest.fn();

		await launchTelegramBot(bot, onLaunchError);
		await new Promise(setImmediate);

		expect(telegram.setMyCommands).toHaveBeenCalledWith(getTelegramCommandMenu());
		expect(onLaunchError).not.toHaveBeenCalled();
	});
});
