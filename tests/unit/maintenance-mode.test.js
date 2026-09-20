'use strict';

const maintenanceMode = require('../../src/lib/maintenanceMode');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('maintenanceMode', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.ENABLE_MAINTENANCE_MODE;
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		remoteConfigService._resetForTesting();
		maintenanceMode._resetForTesting();
	});

	afterAll(() => {
		process.env = { ...originalEnv };
		remoteConfigService._resetForTesting();
		maintenanceMode._resetForTesting();
	});

	describe('isMaintenanceModeEnabled', () => {
		it('defaults to false when environment variable and remote config are unset', () => {
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);
		});

		it('returns true when process.env.ENABLE_MAINTENANCE_MODE is true', () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(true);
		});

		it('returns false when process.env.ENABLE_MAINTENANCE_MODE is false', () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);
		});

		it('prioritizes Remote Config override over process.env', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: true });
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(true);

			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: false });
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);
		});
	});

	describe('maintenanceModeMiddleware', () => {
		it('calls next() when maintenance mode is disabled', async () => {
			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();

			await maintenanceMode.maintenanceModeMiddleware(req, res, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(status).not.toHaveBeenCalled();
		});

		it('returns 503 SERVICE_UNAVAILABLE with expected JSON when maintenance mode is enabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();

			await maintenanceMode.maintenanceModeMiddleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(status).toHaveBeenCalledWith(503);
			expect(json).toHaveBeenCalledWith({
				error: 'MAINTENANCE_MODE',
				message: 'Service is temporarily unavailable for maintenance',
			});
		});

		it('sends an admin Telegram notification on mode toggle and does not duplicate', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();

			await maintenanceMode.maintenanceModeMiddleware(req, res, next);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage).toHaveBeenCalledWith(
				'123456789',
				expect.stringContaining('Modo de mantenimiento'),
				expect.objectContaining({ parse_mode: 'MarkdownV2' }),
			);

			// Second request while still enabled should NOT send another notification
			await maintenanceMode.maintenanceModeMiddleware(req, res, next);
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		it('fails open if admin notification fails', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn().mockRejectedValue(new Error('Network error'));
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			const req = { method: 'POST', originalUrl: '/api/webhook/alert' };
			const json = jest.fn();
			const status = jest.fn().mockReturnValue({ json });
			const res = { status, json };
			const next = jest.fn();
			expect(() => maintenanceMode.maintenanceModeMiddleware(req, res, next)).not.toThrow();
			expect(status).toHaveBeenCalledWith(503);
		});
		it('resets notification latch when maintenance mode transitions to disabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			// First notification
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Calling again while enabled: no new notification
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Mode is turned off -> isMaintenanceModeEnabled() resets latch
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			expect(maintenanceMode.isMaintenanceModeEnabled()).toBe(false);

			// Mode is turned back on -> should notify again
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});

		it('throttles notification retries on failure and retries after cooldown', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			const sendMessage = jest.fn()
				.mockRejectedValueOnce(new Error('Network timeout'))
				.mockResolvedValueOnce({ message_id: 2 });
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			// First attempt fails -> should not set permanent latch, records failure timestamp
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Immediate second attempt while still in failure cooldown -> throttled, no new send
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Third attempt with cooldown expired (failureRetryCooldownMs: 0) -> retries and succeeds
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle({ failureRetryCooldownMs: 0 });
			expect(sendMessage).toHaveBeenCalledTimes(2);

			// Fourth attempt -> already latched because previous succeeded
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});

		it('does not latch notification if maintenance mode is disabled while notification is in flight', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '123456789';

			let resolveSend;
			const sendPromise = new Promise((resolve) => {
				resolveSend = resolve;
			});
			const sendMessage = jest.fn().mockImplementation(() => sendPromise);
			const mockBot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => mockBot);

			// Start check while enabled
			const checkPromise = maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Maintenance mode is turned off while send is in flight
			process.env.ENABLE_MAINTENANCE_MODE = 'false';

			// Notification resolves successfully
			resolveSend({ message_id: 1 });
			await checkPromise;

			// Mode is turned back on -> should notify again because it was not latched
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});

		it('does not latch new activation when notification completes after being toggled off and back on while in flight', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345';

			let resolveFirstNotification;
			const firstNotificationPromise = new Promise((resolve) => {
				resolveFirstNotification = resolve;
			});

			const sendMessage = jest.fn()
				.mockImplementationOnce(() => firstNotificationPromise)
				.mockResolvedValueOnce({ message_id: 101 });

			const bot = { telegram: { sendMessage } };
			maintenanceMode.setBotGetter(() => bot);

			// Start first notification (Gen 1)
			const inflightAttempt = maintenanceMode.checkAndNotifyMaintenanceModeToggle();

			// While Gen 1 is in flight, toggle maintenance mode OFF then back ON via Remote Config listener
			process.env.ENABLE_MAINTENANCE_MODE = 'false';
			maintenanceMode._handleRemoteConfigChange({
				prevOverrides: { ENABLE_MAINTENANCE_MODE: true },
				nextOverrides: { ENABLE_MAINTENANCE_MODE: false },
			});

			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			maintenanceMode._handleRemoteConfigChange({
				prevOverrides: { ENABLE_MAINTENANCE_MODE: false },
				nextOverrides: { ENABLE_MAINTENANCE_MODE: true },
			});

			// Now resolve the first notification that completed from Gen 1
			resolveFirstNotification(true);
			await inflightAttempt;

			// Latch should NOT be set for the new generation because the notification was from an earlier activation
			const latchState = maintenanceMode._getLatchState();
			expect(latchState.lastNotifiedMaintenanceMode).toBe(false);

			// A subsequent check for the new activation window must trigger a fresh notification
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
			expect(maintenanceMode._getLatchState().lastNotifiedMaintenanceMode).toBe(true);
		});

		it('resets latch when Remote Config is toggled off in background without any requests', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345';
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			maintenanceMode.setBotGetter(() => ({ telegram: { sendMessage } }));

			// Remote Config activates maintenance mode
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: true }, Date.now(), 'v1');
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Remote config disables maintenance mode in background - NO requests or checks made during this time
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: false }, Date.now(), 'v2');

			// Remote config re-enables maintenance mode in background
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: true }, Date.now(), 'v3');

			// First request arrives in new maintenance window -> must notify!
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});

		it('does not reset latch when an unrelated Remote Config parameter is published while maintenance remains enabled', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345';
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			maintenanceMode.setBotGetter(() => ({ telegram: { sendMessage } }));

			// Version 1 enables maintenance mode
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: true }, Date.now(), 'v1');
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Version 2 published with an unrelated parameter change while maintenance remains enabled
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: true, BRAVE_SEARCH_TIMEOUT_MS: 5000 }, Date.now(), 'v2');
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);
		});

		it('allows manual latch reset via resetNotificationLatch', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345';
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const sendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
			maintenanceMode.setBotGetter(() => ({ telegram: { sendMessage } }));

			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Second check within same window does not notify
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Manually reset latch
			maintenanceMode.resetNotificationLatch();
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);
		});

		it('throttles notification retries after failure to prevent hammering Telegram', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345';
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const sendMessage = jest.fn().mockRejectedValue(new Error('Telegram network error'));
			maintenanceMode.setBotGetter(() => ({ telegram: { sendMessage } }));

			// First attempt fails
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(maintenanceMode._getLatchState().lastNotificationFailureAt).toBeGreaterThan(0);

			// Immediate second call should be throttled by failure cooldown
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// Simulate passage of cooldown duration
			maintenanceMode._setLastNotificationFailureAt(Date.now() - maintenanceMode.NOTIFICATION_FAILURE_RETRY_COOLDOWN_MS - 1000);

			// Subsequent call retries
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(2);

			// When retry succeeds, failure cooldown is cleared and latch is set
			sendMessage.mockResolvedValueOnce({ message_id: 2 });
			maintenanceMode._setLastNotificationFailureAt(Date.now() - maintenanceMode.NOTIFICATION_FAILURE_RETRY_COOLDOWN_MS - 1000);
			await maintenanceMode.checkAndNotifyMaintenanceModeToggle();
			expect(sendMessage).toHaveBeenCalledTimes(3);
			expect(maintenanceMode._getLatchState().lastNotifiedMaintenanceMode).toBe(true);
			expect(maintenanceMode._getLatchState().lastNotificationFailureAt).toBe(0);
		});
	});

	describe('isTelegramCommand', () => {
		it('returns true for text starting with slash', () => {
			expect(maintenanceMode.isTelegramCommand({ message: { text: '/start' } })).toBe(true);
			expect(maintenanceMode.isTelegramCommand({ message: { text: '/precio btc' } })).toBe(true);
		});

		it('returns true for messages with bot_command entity at offset 0', () => {
			expect(
				maintenanceMode.isTelegramCommand({
					message: {
						text: 'precio btc',
						entities: [{ type: 'bot_command', offset: 0, length: 6 }],
					},
				}),
			).toBe(true);
		});

		it('returns true when command is addressed to current bot via @recipient', () => {
			expect(
				maintenanceMode.isTelegramCommand({
					me: 'cabros_bot',
					message: { text: '/scanner@cabros_bot' },
				}),
			).toBe(true);
			expect(
				maintenanceMode.isTelegramCommand({
					botInfo: { username: 'cabros_bot' },
					message: { text: '/precio@CABROS_BOT btc' },
				}),
			).toBe(true);
		});

		it('returns false when command is addressed to a different bot', () => {
			expect(
				maintenanceMode.isTelegramCommand({
					me: 'cabros_bot',
					message: { text: '/scanner@some_other_bot' },
				}),
			).toBe(false);
			expect(
				maintenanceMode.isTelegramCommand({
					botInfo: { username: 'cabros_bot' },
					message: { text: '/precio@other_bot btc' },
				}),
			).toBe(false);
		});

		it('returns false when command has @recipient but bot identity is unknown', () => {
			expect(
				maintenanceMode.isTelegramCommand({
					message: { text: '/scanner@other_bot' },
				}),
			).toBe(false);
		});

		it('returns false for plain text messages without command', () => {
			expect(maintenanceMode.isTelegramCommand({ message: { text: 'hello world' } })).toBe(false);
			expect(maintenanceMode.isTelegramCommand({ message: { text: '' } })).toBe(false);
		});

		it('returns false for callback queries, empty messages, or non-object contexts', () => {
			expect(maintenanceMode.isTelegramCommand({ callbackQuery: { data: 'confirm' } })).toBe(false);
			expect(maintenanceMode.isTelegramCommand({})).toBe(false);
			expect(maintenanceMode.isTelegramCommand(null)).toBe(false);
		});
	});

	describe('telegramMaintenanceMode', () => {
		it('calls next() when maintenance mode is disabled', async () => {
			const reply = jest.fn();
			const context = { reply, message: { text: '/precio btc' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(reply).not.toHaveBeenCalled();
		});

		it('replies with maintenance notice and suppresses next() when maintenance mode is enabled for commands', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn().mockResolvedValue({});
			const context = { reply, message: { text: '/precio btc' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).not.toHaveBeenCalled();
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply).toHaveBeenCalledWith(expect.stringMatching(/mantenimiento/i), { parse_mode: 'MarkdownV2' });
		});

		it('throttles rapid maintenance replies to the same chat within cooldown window', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn().mockResolvedValue({});
			const context = { reply, chat: { id: 777 }, message: { text: '/precio btc' } };
			const next = jest.fn();

			// First command receives maintenance reply
			await maintenanceMode.telegramMaintenanceMode(context, next);
			expect(reply).toHaveBeenCalledTimes(1);

			// Second rapid command from same chat is throttled (no reply sent)
			await maintenanceMode.telegramMaintenanceMode(context, next);
			expect(reply).toHaveBeenCalledTimes(1);
			expect(next).not.toHaveBeenCalled();

			// Command from a different chat receives reply
			const otherContext = { reply, chat: { id: 888 }, message: { text: '/precio btc' } };
			await maintenanceMode.telegramMaintenanceMode(otherContext, next);
			expect(reply).toHaveBeenCalledTimes(2);
		});

		it('passes command to next() without replying when addressed to another bot during maintenance', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn();
			const context = {
				me: 'cabros_bot',
				reply,
				message: { text: '/scanner@other_bot' },
			};
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(reply).not.toHaveBeenCalled();
		});

		it('calls next() without replying when message is not a command even if maintenance mode is enabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn();
			const context = { reply, message: { text: 'just a normal message' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(reply).not.toHaveBeenCalled();
		});

		it('calls next() for callback queries even if maintenance mode is enabled', async () => {
			process.env.ENABLE_MAINTENANCE_MODE = 'true';
			const reply = jest.fn();
			const context = { reply, callbackQuery: { id: 'cb1', data: 'action' } };
			const next = jest.fn();

			await maintenanceMode.telegramMaintenanceMode(context, next);

			expect(next).toHaveBeenCalledTimes(1);
			expect(reply).not.toHaveBeenCalled();
		});

		it('keeps maintenance replies out of expensive command quotas in telegramCommandRateLimiter', async () => {
			const { telegramCommandRateLimiter } = require('../../src/controllers/commands');
			telegramCommandRateLimiter.reset();
			process.env.ENABLE_MAINTENANCE_MODE = 'true';

			const reply = jest.fn().mockResolvedValue(undefined);
			function buildCmdCtx(chatId) {
				return {
					message: {
						text: '/scanner',
						entities: [{ type: 'bot_command', offset: 0, length: 8 }],
					},
					update: {
						message: {
							chat: { id: chatId },
						},
					},
					reply,
				};
			}

			const handler = jest.fn();
			// Pipeline matches index.js order: telegramMaintenanceMode then telegramCommandRateLimiter
			async function runPipeline(ctx) {
				await maintenanceMode.telegramMaintenanceMode(ctx, async () => {
					await telegramCommandRateLimiter(ctx, handler);
				});
			}

			// During maintenance, user triggers /scanner multiple times
			for (let i = 0; i < 5; i++) {
				await runPipeline(buildCmdCtx(999));
			}

			// First command sent maintenance notice, subsequent ones throttled
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply).toHaveBeenCalledWith(maintenanceMode.TELEGRAM_MAINTENANCE_NOTICE, { parse_mode: 'MarkdownV2' });
			// Command handler never executed
			expect(handler).not.toHaveBeenCalled();

			// Maintenance mode is now restored / resolved!
			process.env.ENABLE_MAINTENANCE_MODE = 'false';

			// User should have their full expensive quota available (3 scanner runs allowed)
			for (let i = 0; i < 3; i++) {
				await runPipeline(buildCmdCtx(999));
			}
			// All 3 post-maintenance calls passed through to handler because quota was NOT consumed
			expect(handler).toHaveBeenCalledTimes(3);
		});

		it('enforces maximum bucket capacity with LRU eviction', () => {
			const now = 100_000;
			// Fill up with 3 chats under maxBuckets: 3
			maintenanceMode._isMaintenanceReplyThrottled(1, now, { maxBuckets: 3 });
			maintenanceMode._isMaintenanceReplyThrottled(2, now + 10, { maxBuckets: 3 });
			maintenanceMode._isMaintenanceReplyThrottled(3, now + 20, { maxBuckets: 3 });
			expect(maintenanceMode._getMaintenanceReplyBucketsSize()).toBe(3);

			// Adding a 4th chat when none have expired (< 5000ms) evicts the oldest (chat 1)
			maintenanceMode._isMaintenanceReplyThrottled(4, now + 30, { maxBuckets: 3 });
			expect(maintenanceMode._getMaintenanceReplyBucketsSize()).toBe(3);

			// Chat 1 was evicted, so it is no longer throttled even at now + 40
			expect(maintenanceMode._isMaintenanceReplyThrottled(1, now + 40, { maxBuckets: 3 })).toBe(false);
		});

		it('escapes maintenance notice special characters for Telegram MarkdownV2', () => {
			expect(maintenanceMode.TELEGRAM_MAINTENANCE_NOTICE).toContain('\\.');
			expect(maintenanceMode.TELEGRAM_MAINTENANCE_NOTICE.endsWith('\\.')).toBe(true);
		});

		it('sends maintenance reply via context.telegram.callApi with MarkdownV2 and AbortController signal', async () => {
			const callApi = jest.fn().mockResolvedValue({ message_id: 42 });
			const context = {
				telegram: { callApi },
				chat: { id: 777 },
			};

			await maintenanceMode.sendMaintenanceReply(context, 777);

			expect(callApi).toHaveBeenCalledTimes(1);
			expect(callApi).toHaveBeenCalledWith(
				'sendMessage',
				{
					chat_id: 777,
					text: maintenanceMode.TELEGRAM_MAINTENANCE_NOTICE,
					parse_mode: 'MarkdownV2',
				},
				expect.objectContaining({
					signal: expect.any(AbortSignal),
				})
			);
		});

		it('aborts and fails open when context.telegram.callApi times out', async () => {
			let receivedSignal;
			let timerId;
			const callApi = jest.fn().mockImplementation((method, payload, options) => {
				receivedSignal = options.signal;
				return new Promise((resolve) => {
					timerId = setTimeout(resolve, 500);
					options.signal?.addEventListener('abort', () => {
						clearTimeout(timerId);
						resolve();
					});
				});
			});
			const context = {
				telegram: { callApi },
				chat: { id: 888 },
			};

			// Use 10ms timeout to trigger abort quickly
			await expect(maintenanceMode.sendMaintenanceReply(context, 888, 10)).resolves.toBeUndefined();
			expect(receivedSignal.aborted).toBe(true);
			if (timerId) clearTimeout(timerId);
		});

		it('extracts chatId automatically and respects per-chat throttling in sendMaintenanceReply', async () => {
			const reply = jest.fn().mockResolvedValue(undefined);
			const context = {
				chat: { id: 456 },
				reply,
			};

			// First call sends reply with MarkdownV2
			await maintenanceMode.sendMaintenanceReply(context);
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply).toHaveBeenCalledWith(maintenanceMode.TELEGRAM_MAINTENANCE_NOTICE, { parse_mode: 'MarkdownV2' });

			// Immediate second call is throttled
			await maintenanceMode.sendMaintenanceReply(context);
			expect(reply).toHaveBeenCalledTimes(1);
		});

		it('routes command handler fallback guards through sendMaintenanceReply with MarkdownV2 and throttling', async () => {
			const { helpCmd } = require('../../src/controllers/commands');
			process.env.ENABLE_MAINTENANCE_MODE = 'true';

			const reply = jest.fn().mockResolvedValue(undefined);
			const context = {
				chat: { id: 9876 },
				message: { text: '/help' },
				reply,
			};

			// First invocation delivers the MarkdownV2 notice
			await helpCmd(context);
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply).toHaveBeenCalledWith(maintenanceMode.TELEGRAM_MAINTENANCE_NOTICE, { parse_mode: 'MarkdownV2' });

			// Second rapid invocation is throttled by sendMaintenanceReply
			await helpCmd(context);
			expect(reply).toHaveBeenCalledTimes(1);
		});
	});
});
