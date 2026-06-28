const { getTelegramBootstrapConfig } = require('../../src/lib/telegramBootstrap');

describe('getTelegramBootstrapConfig', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('does not require BOT_TOKEN when Telegram is disabled', () => {
		process.env.ENABLE_TELEGRAM_BOT = 'false';
		delete process.env.BOT_TOKEN;
		delete process.env.RENDER;
		delete process.env.IS_PULL_REQUEST;

		expect(getTelegramBootstrapConfig()).toEqual({
			isPreviewEnv: false,
			shouldStartTelegramBot: false,
			telegramBotIsEnabled: false,
			token: undefined,
		});
	});

	it('does not require BOT_TOKEN in preview environments that do not launch Telegraf', () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.RENDER = 'true';
		process.env.IS_PULL_REQUEST = 'true';
		delete process.env.BOT_TOKEN;

		expect(getTelegramBootstrapConfig()).toEqual({
			isPreviewEnv: true,
			shouldStartTelegramBot: false,
			telegramBotIsEnabled: true,
			token: undefined,
		});
	});

	it('fails fast when Telegram is enabled for runtime use but BOT_TOKEN is missing', () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		delete process.env.RENDER;
		delete process.env.IS_PULL_REQUEST;
		delete process.env.BOT_TOKEN;

		expect(() => getTelegramBootstrapConfig()).toThrow('BOT_TOKEN must be provided!');
	});

	it('returns the token when Telegram startup is enabled', () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'test-bot-token';
		delete process.env.RENDER;
		delete process.env.IS_PULL_REQUEST;

		expect(getTelegramBootstrapConfig()).toEqual({
			isPreviewEnv: false,
			shouldStartTelegramBot: true,
			telegramBotIsEnabled: true,
			token: 'test-bot-token',
		});
	});
});
