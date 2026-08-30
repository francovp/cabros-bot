const { getTelegramBootstrapConfig } = require('../../src/lib/telegramBootstrap');

describe('getTelegramBootstrapConfig', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.VERCEL_ENV;
		delete process.env.RAILWAY_ENVIRONMENT_NAME;
		delete process.env.RAILWAY_GIT_PULL_REQUEST_NUMBER;
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

	it('does not require BOT_TOKEN in Vercel preview deployments', () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.VERCEL_ENV = 'preview';
		delete process.env.BOT_TOKEN;

		expect(getTelegramBootstrapConfig()).toEqual({
			isPreviewEnv: true,
			shouldStartTelegramBot: false,
			telegramBotIsEnabled: true,
			token: undefined,
		});
	});

	it('does not require BOT_TOKEN in Railway PR environments', () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.RAILWAY_ENVIRONMENT_NAME = 'cabros-bot-pr-359';
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

describe('sendStartupDeploymentNotification', () => {
	const { sendStartupDeploymentNotification } = require('../../src/lib/telegramBootstrap');
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.RENDER;
		delete process.env.VERCEL;
		delete process.env.RAILWAY_ENVIRONMENT_NAME;
		delete process.env.RENDER_GIT_COMMIT;
		delete process.env.RENDER_GIT_REPO_SLUG;
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('returns sent: false when TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID is unset or empty', async () => {
		process.env.RENDER = 'true';
		process.env.RENDER_GIT_COMMIT = 'abcdef123456';
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;

		const mockBot = { telegram: { sendMessage: jest.fn() } };
		const result = await sendStartupDeploymentNotification({ bot: mockBot });

		expect(result).toEqual({ sent: false, reason: 'no_admin_chat_configured' });
		expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();

		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '   ';
		const resultEmpty = await sendStartupDeploymentNotification({ bot: mockBot });
		expect(resultEmpty).toEqual({ sent: false, reason: 'no_admin_chat_configured' });
		expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
	});

	it('returns sent: false when not running in a recognized deployment environment', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345678';
		process.env.RENDER_GIT_COMMIT = 'abcdef123456';
		// No RENDER, VERCEL, or RAILWAY_ENVIRONMENT_NAME set

		const mockBot = { telegram: { sendMessage: jest.fn() } };
		const result = await sendStartupDeploymentNotification({ bot: mockBot });

		expect(result).toEqual({ sent: false, reason: 'not_a_deployment_environment' });
		expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
	});

	it('returns sent: false when deployment commit is missing', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345678';
		process.env.RENDER = 'true';
		// No commit env var set

		const mockBot = { telegram: { sendMessage: jest.fn() } };
		const result = await sendStartupDeploymentNotification({ bot: mockBot });

		expect(result).toEqual({ sent: false, reason: 'not_a_deployment_environment' });
		expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
	});

	it('returns sent: false when bot instance is invalid or lacks sendMessage', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345678';
		process.env.RENDER = 'true';
		process.env.RENDER_GIT_COMMIT = 'abcdef123456';

		const resultNull = await sendStartupDeploymentNotification({ bot: null });
		expect(resultNull).toEqual({ sent: false, reason: 'bot_not_available' });

		const resultNoSend = await sendStartupDeploymentNotification({ bot: { telegram: {} } });
		expect(resultNoSend).toEqual({ sent: false, reason: 'bot_not_available' });
	});

	it('successfully sends formatted startup deployment notification in Render environment', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '987654321';
		process.env.RENDER = 'true';
		process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';
		process.env.RENDER_GIT_REPO_SLUG = 'francovp/cabros-bot';

		const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 42 });
		const mockBot = { telegram: { sendMessage: mockSendMessage } };
		const mockLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

		const result = await sendStartupDeploymentNotification({ bot: mockBot, logger: mockLogger });

		expect(result).toEqual({
			sent: true,
			commitHash: 'abcdef',
			gitCommitUrl: 'https://github.com/francovp/cabros-bot/commit/abcdef',
		});
		expect(mockSendMessage).toHaveBeenCalledWith(
			'987654321',
			'*Telegram bot deployed from commit [abcdef](https://github.com/francovp/cabros-bot/commit/abcdef) is running*',
			{ parse_mode: 'MarkdownV2' },
		);
		expect(mockLogger.log).toHaveBeenCalledWith('Telegram Admin Notifications Chat ID:', '987654321');
		expect(mockLogger.log).toHaveBeenCalledWith(
			'Telegram bot deployed from commit https://github.com/francovp/cabros-bot/commit/abcdef is running',
		);
	});

	it('uses callApi with abort signal when available on bot.telegram', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '987654321';
		process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
		process.env.RAILWAY_GIT_COMMIT_SHA = '1234567890abcdef';
		process.env.RAILWAY_GIT_REPO_OWNER = 'francovp';
		process.env.RAILWAY_GIT_REPO_NAME = 'cabros-bot';

		const mockCallApi = jest.fn().mockResolvedValue({ message_id: 99 });
		const mockBot = { telegram: { sendMessage: jest.fn(), callApi: mockCallApi } };

		const result = await sendStartupDeploymentNotification({ bot: mockBot });

		expect(result.sent).toBe(true);
		expect(mockCallApi).toHaveBeenCalledWith(
			'sendMessage',
			{
				chat_id: '987654321',
				text: '*Telegram bot deployed from commit [123456](https://github.com/francovp/cabros-bot/commit/123456) is running*',
				parse_mode: 'MarkdownV2',
			},
			expect.objectContaining({ signal: expect.any(Object) }),
		);
	});

	it('fails open when Telegram sendMessage rejects with an error (e.g. 400 Bad Request)', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = 'invalid-chat-id';
		process.env.RENDER = 'true';
		process.env.RENDER_GIT_COMMIT = 'abcdef123456';

		const telegramError = new Error('400: Bad Request: chat not found');
		telegramError.response = { error_code: 400, description: 'Bad Request: chat not found' };

		const mockBot = { telegram: { sendMessage: jest.fn().mockRejectedValue(telegramError) } };
		const mockLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
		const mockSentry = { captureExternalFailure: jest.fn() };

		const result = await sendStartupDeploymentNotification({
			bot: mockBot,
			logger: mockLogger,
			sentry: mockSentry,
		});

		expect(result).toEqual({ sent: false, error: '400: Bad Request: chat not found' });
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'[index] Failed to send startup deployment notification:',
			'400: Bad Request: chat not found',
		);
		expect(mockSentry.captureExternalFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: 'telegram-api',
				attemptCount: 1,
				lastErrorMessage: '400: Bad Request: chat not found',
				lastErrorCode: 400,
			}),
		);
	});

	it('fails open and does not hang when Telegram API times out', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '987654321';
		process.env.RENDER = 'true';
		process.env.RENDER_GIT_COMMIT = 'abcdef123456';

		// Hangs indefinitely
		const mockBot = {
			telegram: {
				sendMessage: jest.fn().mockImplementation(() => new Promise(() => {})),
			},
		};
		const mockLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
		const mockSentry = { captureExternalFailure: jest.fn() };

		const result = await sendStartupDeploymentNotification({
			bot: mockBot,
			timeoutMs: 50,
			logger: mockLogger,
			sentry: mockSentry,
		});

		expect(result.sent).toBe(false);
		expect(result.error).toContain('timed out after 50ms');
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'[index] Failed to send startup deployment notification:',
			expect.stringContaining('timed out'),
		);
		expect(mockSentry.captureExternalFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: 'telegram-api',
				lastErrorCode: 'TIMEOUT',
			}),
		);
	});
});
