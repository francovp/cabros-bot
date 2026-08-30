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
		const bot = {
			launch: jest.fn((onLaunch) => {
				onLaunch();
				return Promise.resolve();
			}),
			telegram,
		};
		const onLaunchError = jest.fn();

		await launchTelegramBot(bot, onLaunchError);
		await new Promise(setImmediate);

		expect(telegram.setMyCommands).toHaveBeenCalledWith(getTelegramCommandMenu());
		expect(onLaunchError).not.toHaveBeenCalled();
	});

	it('does not block polling when menu registration never settles', async () => {
		const telegram = {
			setMyCommands: jest.fn(() => new Promise(() => {})),
		};
		const bot = {
			launch: jest.fn((onLaunch) => {
				onLaunch();
				return Promise.resolve();
			}),
			telegram,
		};

		await expect(launchTelegramBot(bot, jest.fn())).resolves.toBeUndefined();

		expect(bot.launch).toHaveBeenCalledWith(expect.any(Function));
		expect(telegram.setMyCommands).toHaveBeenCalledWith(getTelegramCommandMenu());
	});
});
