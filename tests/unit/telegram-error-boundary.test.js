jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
	captureExternalFailure: jest.fn(),
}));

const sentryService = require('../../src/services/monitoring/SentryService');
const {
	attachTelegramErrorBoundary,
	handleTelegrafUpdateError,
	handlePollingError,
	recordPollingSuccess,
	resetPollingErrorState,
	startTelegramHealthProbe,
	stopTelegramHealthProbe,
} = require('../../src/lib/telegramErrorBoundary');

describe('Telegram Error Boundary', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		resetPollingErrorState();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('attachTelegramErrorBoundary', () => {
		it('registers catch handler on telegraf bot', () => {
			const botMock = {
				catch: jest.fn(),
				on: jest.fn(),
			};

			attachTelegramErrorBoundary(botMock);

			expect(botMock.catch).toHaveBeenCalledTimes(1);
			expect(typeof botMock.catch.mock.calls[0][0]).toBe('function');
			expect(botMock.on).toHaveBeenCalledWith('polling_error', expect.any(Function));
		});

		it('does not fail if bot.on is undefined', () => {
			const botMock = {
				catch: jest.fn(),
			};

			expect(() => attachTelegramErrorBoundary(botMock)).not.toThrow();
			expect(botMock.catch).toHaveBeenCalledTimes(1);
		});
	});

	describe('handleTelegrafUpdateError', () => {
		it('logs error, reports to Sentry with update metadata, and sends friendly reply to user', async () => {
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const error = new Error('Database connection failed in command');
			const ctx = {
				updateType: 'message',
				update: {
					update_id: 998877,
					message: {
						text: '/precio BTCUSDT',
						chat: { id: 12345 },
						from: { id: 67890 },
					},
				},
				reply: jest.fn().mockResolvedValue(undefined),
			};

			await handleTelegrafUpdateError(error, ctx);

			expect(consoleErrorSpy).toHaveBeenCalled();
			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					feature: 'telegram-bot',
					error,
					extra: expect.objectContaining({
						updateType: 'message',
						updateId: 998877,
						command: '/precio',
					}),
				}),
			);
			expect(ctx.reply).toHaveBeenCalledWith(
				expect.stringContaining('error interno'),
			);

			consoleErrorSpy.mockRestore();
		});

		it('does not include message text in Sentry extra when SENTRY_SEND_ALERT_CONTENT is not true', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});
			delete process.env.SENTRY_SEND_ALERT_CONTENT;

			const error = new Error('Command exploded');
			const ctx = {
				updateType: 'message',
				update: {
					update_id: 112233,
					message: {
						text: '/secret-command password123',
						chat: { id: 123 },
					},
				},
				reply: jest.fn().mockResolvedValue(undefined),
			};

			await handleTelegrafUpdateError(error, ctx);

			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					extra: expect.not.objectContaining({
						rawText: '/secret-command password123',
					}),
				}),
			);

			console.error.mockRestore();
		});

		it('includes message text in Sentry extra when SENTRY_SEND_ALERT_CONTENT is true', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});
			process.env.SENTRY_SEND_ALERT_CONTENT = 'true';

			const error = new Error('Command exploded');
			const ctx = {
				updateType: 'message',
				update: {
					update_id: 112233,
					message: {
						text: '/precio BTCUSDT',
						chat: { id: 123 },
					},
				},
				reply: jest.fn().mockResolvedValue(undefined),
			};

			await handleTelegrafUpdateError(error, ctx);

			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					extra: expect.objectContaining({
						rawText: '/precio BTCUSDT',
					}),
				}),
			);

			console.error.mockRestore();
		});

		it('fails safe and does not throw when ctx.reply rejects', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});
			jest.spyOn(console, 'debug').mockImplementation(() => {});

			const error = new Error('Command exploded');
			const ctx = {
				updateType: 'message',
				update: { update_id: 112233 },
				reply: jest.fn().mockRejectedValue(new Error('Network error on reply')),
			};

			await expect(handleTelegrafUpdateError(error, ctx)).resolves.not.toThrow();

			console.error.mockRestore();
			console.debug.mockRestore();
		});

		it('handles missing ctx or missing ctx.update gracefully', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});

			const error = new Error('Random error');
			await expect(handleTelegrafUpdateError(error, null)).resolves.not.toThrow();
			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					feature: 'telegram-bot',
					error,
				}),
			);

			console.error.mockRestore();
		});
	});

	describe('handlePollingError', () => {
		it('logs first polling error and captures external failure in Sentry', async () => {
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const error = new Error('ETIMEDOUT connecting to Telegram API');
			error.code = 'ETIMEDOUT';

			await handlePollingError(error);

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('[telegram] Polling error:'),
				'ETIMEDOUT connecting to Telegram API',
				expect.objectContaining({
					consecutiveFailures: 1,
				}),
			);

			expect(sentryService.captureExternalFailure).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					feature: 'telegram-bot',
					external: expect.objectContaining({
						provider: 'telegram-api',
						attemptCount: 1,
						lastErrorMessage: 'ETIMEDOUT connecting to Telegram API',
						lastErrorCode: 'ETIMEDOUT',
					}),
				}),
			);

			consoleErrorSpy.mockRestore();
		});

		it('rate-limits repetitive polling errors within cooldown window', async () => {
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
			const error = new Error('ETIMEDOUT');

			await handlePollingError(error, { logCooldownMs: 60000 });
			expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

			// Second error immediately after
			await handlePollingError(error, { logCooldownMs: 60000 });
			expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // Not logged again to error
			expect(consoleDebugSpy).toHaveBeenCalledWith(
				expect.stringContaining('[telegram] Suppressed repetitive polling error:'),
				'ETIMEDOUT',
			);

			consoleErrorSpy.mockRestore();
			consoleDebugSpy.mockRestore();
		});

		it('pages admin when consecutive failures exceed threshold and chat ID is configured', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100998877';

			const botMock = {
				telegram: {
					sendMessage: jest.fn().mockResolvedValue(undefined),
				},
			};

			const error = new Error('Conflict: terminated by other getUpdates request');
			error.code = 409;

			for (let i = 0; i < 5; i++) {
				await handlePollingError(error, {
					bot: botMock,
					adminAlertThreshold: 5,
					logCooldownMs: 0,
					adminAlertCooldownMs: 60000,
				});
			}

			expect(botMock.telegram.sendMessage).toHaveBeenCalledWith(
				'-100998877',
				expect.stringContaining('Telegram bot sustained polling failure'),
				expect.objectContaining({ parse_mode: 'MarkdownV2' }),
			);

			console.error.mockRestore();
		});

		it('recovers state and logs recovery on recordPollingSuccess', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});
			const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

			const error = new Error('Network error');
			for (let i = 0; i < 3; i++) {
				await handlePollingError(error, { logCooldownMs: 0 });
			}

			recordPollingSuccess();

			expect(consoleInfoSpy).toHaveBeenCalledWith(
				expect.stringContaining('[telegram] Polling recovered after 3 failure(s)'),
			);

			console.error.mockRestore();
			consoleInfoSpy.mockRestore();
		});

		it('treats a stale streak as ended when recoveryWindowMs has elapsed', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});
			jest.spyOn(console, 'debug').mockImplementation(() => {});

			const error = new Error('Network error');
			// First, build up a 3-failure streak.
			for (let i = 0; i < 3; i++) {
				await handlePollingError(error, {
					logCooldownMs: 0,
					recoveryWindowMs: 100,
				});
			}

			// Wait past the recovery window so the next failure should not compound.
			await new Promise((resolve) => setTimeout(resolve, 150));

			await handlePollingError(error, {
				logCooldownMs: 0,
				recoveryWindowMs: 100,
			});

			// After recovery, the new streak restarts at 1, not 4.
			expect(sentryService.captureExternalFailure).toHaveBeenLastCalledWith(
				expect.objectContaining({
					external: expect.objectContaining({
						attemptCount: 1,
						durationMs: expect.any(Number),
					}),
				}),
			);

			console.error.mockRestore();
			console.debug.mockRestore();
		});

		it('does not page admin when a transient error follows a recovered streak', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => {});
			jest.spyOn(console, 'debug').mockImplementation(() => {});

			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100998877';

			const botMock = {
				telegram: {
					sendMessage: jest.fn().mockResolvedValue(undefined),
				},
			};

			const error = new Error('ETIMEDOUT');
			error.code = 'ETIMEDOUT';

			// Build up a 5-failure streak so the page would normally fire.
			for (let i = 0; i < 5; i++) {
				await handlePollingError(error, {
					bot: botMock,
					adminAlertThreshold: 5,
					logCooldownMs: 0,
					adminAlertCooldownMs: 60000,
					recoveryWindowMs: 100,
				});
			}
			expect(botMock.telegram.sendMessage).toHaveBeenCalledTimes(1);

			// Wait past the recovery window, then mark a single transient failure.
			await new Promise((resolve) => setTimeout(resolve, 150));
			await handlePollingError(error, {
				bot: botMock,
				adminAlertThreshold: 5,
				logCooldownMs: 0,
				adminAlertCooldownMs: 60000,
				recoveryWindowMs: 100,
			});

			// The new streak is 1 — well below the page threshold — so no new page.
			expect(botMock.telegram.sendMessage).toHaveBeenCalledTimes(1);

			console.error.mockRestore();
			console.debug.mockRestore();
		});
	});

	describe('startTelegramHealthProbe', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			stopTelegramHealthProbe();
			jest.useRealTimers();
		});

		it('calls recordPollingSuccess on a successful getMe heartbeat', async () => {
			const botMock = {
				telegram: {
					getMe: jest.fn().mockResolvedValue({ id: 12345, username: 'cabros_bot' }),
				},
			};

			startTelegramHealthProbe(botMock, { intervalMs: 1000 });

			// Advance the timer and flush the microtask queue.
			await Promise.resolve();
			await jest.advanceTimersByTimeAsync(1000);
			await Promise.resolve();

			expect(botMock.telegram.getMe).toHaveBeenCalledTimes(1);
		});

		it('does not call getMe after stopTelegramHealthProbe', async () => {
			const botMock = {
				telegram: {
					getMe: jest.fn().mockResolvedValue({ id: 12345 }),
				},
			};

			startTelegramHealthProbe(botMock, { intervalMs: 1000 });
			stopTelegramHealthProbe();

			await jest.advanceTimersByTimeAsync(5000);
			await Promise.resolve();

			expect(botMock.telegram.getMe).not.toHaveBeenCalled();
		});

		it('keeps polling when getMe rejects (does not throw or stop the probe)', async () => {
			const consoleErrorSpy = jest
				.spyOn(console, 'error')
				.mockImplementation(() => {});
			const consoleDebugSpy = jest
				.spyOn(console, 'debug')
				.mockImplementation(() => {});

			const botMock = {
				telegram: {
					getMe: jest
						.fn()
						.mockRejectedValueOnce(new Error('ETIMEDOUT'))
						.mockResolvedValue({ id: 12345 }),
				},
			};

			startTelegramHealthProbe(botMock, { intervalMs: 1000 });

			// First tick fails; second tick succeeds.
			await jest.advanceTimersByTimeAsync(1000);
			await Promise.resolve();
			await jest.advanceTimersByTimeAsync(1000);
			await Promise.resolve();

			expect(botMock.telegram.getMe).toHaveBeenCalledTimes(2);
			expect(consoleDebugSpy).toHaveBeenCalledWith(
				expect.stringContaining('[telegram] Health probe getMe failed'),
				'ETIMEDOUT',
			);

			consoleErrorSpy.mockRestore();
			consoleDebugSpy.mockRestore();
		});

		it('is a no-op when bot.telegram.getMe is missing', () => {
			const botMock = { telegram: {} };
			expect(() =>
				startTelegramHealthProbe(botMock, { intervalMs: 1000 }),
			).not.toThrow();
		});
	});
});
