'use strict';

const {
	handleAlertAction,
	registerAlertActionHandlers,
	ACTION_CALLBACK_REGEX,
	recordQualityFeedback,
	getRecordedQualityFeedback,
} = require('../../src/lib/telegramAlertActions');

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const alertModule = require('../../src/controllers/webhooks/handlers/alert/alert');
const { idempotencyService } = require('../../src/services/storage/IdempotencyService');

function makeContext(callbackData, callbackId = `callback-${callbackData}`) {
	const ctx = {
		update: {
			callbackQuery: {
				id: callbackId,
				data: callbackData,
				from: { id: 42 },
				message: {
					chat: { id: 100 },
					message_id: 42,
				},
			},
		},
		answerCbQuery: jest.fn().mockResolvedValue(undefined),
		reply: jest.fn().mockResolvedValue({ message_id: 99 }),
		editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
		telegram: {
			editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
		},
	};
	return ctx;
}

describe('telegramAlertActions', () => {
	beforeEach(() => {
		jest.restoreAllMocks();
		jest.clearAllMocks();
		idempotencyService.clear();
		delete recordQualityFeedback._store;
		process.env.TELEGRAM_ACTION_OPERATOR_USER_IDS = '42';
	});

	afterEach(() => {
		jest.useRealTimers();
		delete process.env.TELEGRAM_ACTION_OPERATOR_USER_IDS;
	});

	describe('ACTION_CALLBACK_REGEX', () => {
		it('matches all known action codes with an alert id', () => {
			expect(ACTION_CALLBACK_REGEX.test('r:alert-123')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('d:alert-123')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('x:alert-123')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('vu:alert-123')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('vd:alert-123')).toBe(true);
		});

		it('rejects unknown action codes and malformed alert ids', () => {
			expect(ACTION_CALLBACK_REGEX.test('z:ABCDEFGH')).toBe(false);
			expect(ACTION_CALLBACK_REGEX.test('r:alert/invalid')).toBe(false);
			expect(ACTION_CALLBACK_REGEX.test(`r:${'a'.repeat(61)}`)).toBe(false);
			expect(ACTION_CALLBACK_REGEX.test('noColon')).toBe(false);
		});
	});

	describe('registerAlertActionHandlers', () => {
		it('returns false when bot or bot.action is missing', () => {
			expect(registerAlertActionHandlers(null)).toBe(false);
			expect(registerAlertActionHandlers({})).toBe(false);
		});

		it('registers the handler on a Telegraf bot', () => {
			const actionSpy = jest.fn();
			const bot = { action: actionSpy };
			const registered = registerAlertActionHandlers(bot);
			expect(registered).toBe(true);
			expect(actionSpy).toHaveBeenCalledWith(ACTION_CALLBACK_REGEX, handleAlertAction);
		});
	});

	describe('handleAlertAction', () => {
		it('answers with a fallback when callback data is missing', async () => {
			const ctx = { update: {}, answerCbQuery: jest.fn() };
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Acción no reconocida', { show_alert: false });
		});

		it('answers with a fallback when callback data has an unknown action', async () => {
			const ctx = makeContext('z:ABCDEFGH');
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Acción no reconocida', { show_alert: false });
		});

		it('answers gracefully when the alert is not stored', async () => {
			const ctx = makeContext('r:missing-alert');
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Reenvío iniciado', { show_alert: false });
			expect(ctx.reply).toHaveBeenCalledWith('Alerta no encontrada o ya expirada');
		});

		it('returns a bounded unavailable response when replay storage hangs', async () => {
			jest.useFakeTimers();
			const alertId = 'alert-replay-timeout';
			let resolveLookup;
			jest.spyOn(alertStorageService, 'getAlertById').mockImplementation(() => new Promise((resolve) => {
				resolveLookup = resolve;
			}));
			const ctx = makeContext(`r:${alertId}`);
			const actionPromise = handleAlertAction(ctx);

			await Promise.resolve();
			await jest.advanceTimersByTimeAsync(5000);
			await actionPromise;

			expect(ctx.reply).toHaveBeenCalledWith('Servicio de almacenamiento no disponible; intenta de nuevo');
			resolveLookup(null);
			jest.useRealTimers();
		});

		it('handles dismiss by removing the inline keyboard and acknowledging', async () => {
			const ctx = makeContext('x:alert-dismiss');
			await handleAlertAction(ctx);
			expect(ctx.telegram.editMessageReplyMarkup).toHaveBeenCalledWith(
				100,
				42,
				undefined,
				{ inline_keyboard: [] },
			);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Alerta descartada', { show_alert: false });
		});

		it('rejects dismiss from a non-operator before mutating the shared message', async () => {
			process.env.TELEGRAM_ACTION_OPERATOR_USER_IDS = '99';
			const ctx = makeContext('x:alert-dismiss-unauthorized');

			await handleAlertAction(ctx);

			expect(ctx.telegram.editMessageReplyMarkup).not.toHaveBeenCalled();
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('No autorizado para modificar alertas', { show_alert: false });
		});

		it('handles vote up by acknowledging the feedback', async () => {
			const ctx = makeContext('vu:alert-vote-up');
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('👍 Gracias por tu feedback', { show_alert: false });
		});

		it('handles vote down by acknowledging the feedback', async () => {
			const ctx = makeContext('vd:alert-vote-down');
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('👎 Gracias por tu feedback', { show_alert: false });
		});

		it('keeps feedback from different recipients as separate records', async () => {
			const firstContext = makeContext('vu:alert-vote-recipient', 'callback-vote-1');
			const secondContext = makeContext('vu:alert-vote-recipient', 'callback-vote-2');
			secondContext.update.callbackQuery.from.id = 43;

			await handleAlertAction(firstContext);
			await handleAlertAction(secondContext);

			expect(getRecordedQualityFeedback()).toEqual(expect.arrayContaining([
				expect.objectContaining({ alertId: 'alert-vote-recipient', side: 'up', senderId: '42' }),
				expect.objectContaining({ alertId: 'alert-vote-recipient', side: 'up', senderId: '43' }),
			]));
		});

		it('handles details by replying with the stored alert enrichment', async () => {
			const alertId = 'alert-details-1';
			const getAlertById = jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'BTC long @ 60000',
				enrichmentData: {
					sentiment: 'bullish',
					insights: ['Strong momentum.', 'Volume rising - [confirmed]!'],
					technical_levels: ['Support (58000)'],
					invalidation_level: 58000,
					target_level: 65000,
					sources: [{ url: 'https://example.com', title: 'Example.com [source]' }],
				},
			});
			const ctx = makeContext(`d:${alertId}`);
			await handleAlertAction(ctx);
			expect(getAlertById).toHaveBeenCalledWith(alertId);
			const replyArgs = ctx.reply.mock.calls[0];
			expect(replyArgs[0]).toContain('*Sentimiento:* bullish');
			expect(replyArgs[0]).toContain('*Insights:*');
			expect(replyArgs[0]).toContain('Strong momentum\\.');
			expect(replyArgs[0]).toContain('Volume rising \\- \\[confirmed\\]\\!');
			expect(replyArgs[0]).toContain('*Niveles técnicos:*');
			expect(replyArgs[0]).toContain('Support \\(58000\\)');
			expect(replyArgs[0]).toContain('*Invalidación:* 58000');
			expect(replyArgs[0]).toContain('*Objetivo:* 65000');
			expect(replyArgs[0]).toContain('*Fuentes:*');
			expect(replyArgs[1]).toEqual({ parse_mode: 'MarkdownV2' });
			expect(ctx.answerCbQuery).toHaveBeenCalled();
			getAlertById.mockRestore();
		});

		it('renders canonical object-shaped technical levels', async () => {
			const alertId = 'alert-details-levels-object';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'BTC long',
				enrichmentData: {
					technical_levels: {
						supports: ['58000'],
						resistances: ['65000'],
					},
				},
			});
			const ctx = makeContext(`d:${alertId}`);

			await handleAlertAction(ctx);

			expect(ctx.reply.mock.calls[0][0]).toContain('Soporte: 58000');
			expect(ctx.reply.mock.calls[0][0]).toContain('Resistencia: 65000');
		});

		it('bounds oversized Details replies below Telegram limits', async () => {
			const alertId = 'alert-details-long';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'BTC long',
				enrichmentData: {
					insights: Array.from({ length: 20 }, () => 'Long insight '.repeat(400)),
				},
			});
			const ctx = makeContext(`d:${alertId}`);

			await handleAlertAction(ctx);

			expect(ctx.reply.mock.calls[0][0].length).toBeLessThanOrEqual(4096);
			expect(ctx.reply.mock.calls[0][0]).toContain('truncado');
		});

		it('returns a bounded unavailable response when details storage hangs', async () => {
			jest.useFakeTimers();
			let resolveLookup;
			jest.spyOn(alertStorageService, 'getAlertById').mockImplementation(() => new Promise((resolve) => {
				resolveLookup = resolve;
			}));
			const ctx = makeContext('d:alert-details-timeout');
			const actionPromise = handleAlertAction(ctx);

			await Promise.resolve();
			await jest.advanceTimersByTimeAsync(5000);
			await actionPromise;

			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Servicio de almacenamiento no disponible; intenta de nuevo', { show_alert: false });
			resolveLookup(null);
			jest.useRealTimers();
		});

		it('falls back to plain text when MarkdownV2 parse fails on the details reply', async () => {
			const alertId = 'alert-details-fallback';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'Sample',
				enrichmentData: { sentiment: 'bullish' },
			});
			const ctx = makeContext(`d:${alertId}`);
			ctx.reply = jest.fn()
				.mockRejectedValueOnce(new Error('parse entities failed'))
				.mockResolvedValueOnce({ message_id: 100 });
			await handleAlertAction(ctx);
			expect(ctx.reply).toHaveBeenCalledTimes(2);
			expect(ctx.answerCbQuery).toHaveBeenCalled();
		});

		it('replay answers with a not-found toast when the stored alert is missing', async () => {
			const alertId = 'alert-replay-missing';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue(null);
			// Stub the notification manager to a no-op (should not be called)
			const notifSpy = jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue(null);
			const ctx = makeContext(`r:${alertId}`);
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Reenvío iniciado', { show_alert: false });
			expect(ctx.reply).toHaveBeenCalledWith('Alerta no encontrada o ya expirada');
			notifSpy.mockRestore();
		});

		it('replay dispatches to notification manager when the stored alert exists', async () => {
			const alertId = 'alert-replay-ok';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'Replay target',
				enrichmentData: null,
				channels: ['telegram'],
			});
			const sendToChannels = jest.fn().mockResolvedValue([
				{ channel: 'telegram', success: true },
			]);
			jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue({ sendToChannels });
			const ctx = makeContext(`r:${alertId}`);
			await handleAlertAction(ctx);
			expect(sendToChannels).toHaveBeenCalledTimes(1);
			const sentPayload = sendToChannels.mock.calls[0][0];
			expect(sentPayload).toMatchObject({
				text: 'Replay target',
				source: 'telegram-replay',
			});
			expect(sendToChannels.mock.calls[0][1]).toEqual(['telegram']);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Reenvío iniciado', { show_alert: false });
			expect(ctx.reply).toHaveBeenCalledWith('Reenviado a 1 canal');
		});

		it('persists a replay audit with a stable callback-derived idempotency key', async () => {
			const alertId = 'alert-replay-audit';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'Replay target',
				channels: ['telegram'],
			});
			const sendToChannels = jest.fn().mockResolvedValue([
				{ channel: 'telegram', success: true, messageId: '123' },
			]);
			jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue({ sendToChannels });
			const saveReplayAttempt = jest.spyOn(alertStorageService, 'saveReplayAttempt').mockResolvedValue('replay-audit-id');
			const callbackId = 'telegram-callback-123';
			const ctx = makeContext(`r:${alertId}`, callbackId);

			await handleAlertAction(ctx);

			const sentPayload = sendToChannels.mock.calls[0][0];
			const expectedKey = `telegram:replay:${alertId}:${callbackId}`;
			expect(sentPayload.replay.idempotencyKey).toBe(expectedKey);
			expect(saveReplayAttempt).toHaveBeenCalledWith({
				alertId,
				idempotencyKey: expectedKey,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true, messageId: '123' }],
			});
		});

		it('does not redeliver a replay for the same callback delivery', async () => {
			const alertId = 'alert-replay-deduped';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'Replay target',
				channels: ['telegram'],
			});
			const sendToChannels = jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]);
			jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue({ sendToChannels });
			jest.spyOn(alertStorageService, 'saveReplayAttempt').mockResolvedValue('replay-audit-id');
			const callbackId = 'telegram-callback-duplicate';

			await handleAlertAction(makeContext(`r:${alertId}`, callbackId));
			const secondContext = makeContext(`r:${alertId}`, callbackId);
			await handleAlertAction(secondContext);

			expect(sendToChannels).toHaveBeenCalledTimes(1);
			expect(secondContext.reply).toHaveBeenCalledWith('Reenvío ya procesado');
		});

		it('rejects replay from a non-operator before reading or sending the alert', async () => {
			process.env.TELEGRAM_ACTION_OPERATOR_USER_IDS = '99';
			const getAlertById = jest.spyOn(alertStorageService, 'getAlertById');
			const ctx = makeContext('r:alert-unauthorized');

			await handleAlertAction(ctx);

			expect(getAlertById).not.toHaveBeenCalled();
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('No autorizado para reenviar alertas', { show_alert: false });
		});

		it('acknowledges replay before storage and provider work', async () => {
			const events = [];
			const alertId = 'alert-replay-order';
			jest.spyOn(alertStorageService, 'getAlertById').mockImplementation(async () => {
				events.push('storage');
				return { id: alertId, text: 'Replay target', channels: ['telegram'] };
			});
			const sendToChannels = jest.fn().mockImplementation(async () => {
				events.push('provider');
				return [{ channel: 'telegram', success: true }];
			});
			jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue({ sendToChannels });
			const ctx = makeContext(`r:${alertId}`);
			ctx.answerCbQuery = jest.fn().mockImplementation(async () => events.push('ack'));

			await handleAlertAction(ctx);

			expect(events).toEqual(['ack', 'storage', 'provider']);
		});

		it('uses broadcast-enabled channels only for legacy alerts without stored routing', async () => {
			const alertId = 'alert-replay-legacy';
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'Legacy replay',
				channels: [],
			});
			const sendToChannels = jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]);
			jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue({
				sendToChannels,
				getEnabledChannels: () => ['telegram', 'whatsapp'],
			});

			await handleAlertAction(makeContext(`r:${alertId}`));

			expect(sendToChannels.mock.calls[0][1]).toEqual(['telegram', 'whatsapp']);
		});
	});
});
