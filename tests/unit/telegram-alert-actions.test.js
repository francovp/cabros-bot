'use strict';

const { defaultStore, createTelegramActionStore, shortIdFor } = require('../../src/services/alerts/telegramActionStore');
const {
	handleAlertAction,
	registerAlertActionHandlers,
	ACTION_CALLBACK_REGEX,
} = require('../../src/lib/telegramAlertActions');

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const alertModule = require('../../src/controllers/webhooks/handlers/alert/alert');

function makeContext(callbackData) {
	const ctx = {
		update: {
			callbackQuery: {
				data: callbackData,
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

function registerAlert(alertId) {
	const shortId = shortIdFor(alertId);
	defaultStore.register(alertId, { chatId: '100', threadId: null, messageIds: [] });
	return { shortId, alertId };
}

describe('telegramAlertActions', () => {
	beforeEach(() => {
		defaultStore.clear();
		jest.clearAllMocks();
	});

	describe('ACTION_CALLBACK_REGEX', () => {
		it('matches all known action codes with an 8-character shortId', () => {
			expect(ACTION_CALLBACK_REGEX.test('r:ABCDEFGH')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('d:ABCDEFGH')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('x:ABCDEFGH')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('vu:ABCDEFGH')).toBe(true);
			expect(ACTION_CALLBACK_REGEX.test('vd:ABCDEFGH')).toBe(true);
		});

		it('rejects unknown action codes and malformed shortIds', () => {
			expect(ACTION_CALLBACK_REGEX.test('z:ABCDEFGH')).toBe(false);
			expect(ACTION_CALLBACK_REGEX.test('r:tooshort')).toBe(false);
			expect(ACTION_CALLBACK_REGEX.test('r:toooooooolong')).toBe(false);
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

		it('answers gracefully when the shortId is not in the store', async () => {
			const ctx = makeContext('r:00000000');
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith(
				'La alerta ya no está disponible para acciones',
				{ show_alert: false },
			);
		});

		it('handles dismiss by removing the inline keyboard and acknowledging', async () => {
			const { shortId } = registerAlert('alert-dismiss');
			const ctx = makeContext(`x:${shortId}`);
			await handleAlertAction(ctx);
			expect(ctx.telegram.editMessageReplyMarkup).toHaveBeenCalledWith(
				100,
				42,
				undefined,
				{ inline_keyboard: [] },
			);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Alerta descartada', { show_alert: false });
		});

		it('handles vote up by acknowledging the feedback', async () => {
			const { shortId } = registerAlert('alert-vote-up');
			const ctx = makeContext(`vu:${shortId}`);
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('👍 Gracias por tu feedback', { show_alert: false });
		});

		it('handles vote down by acknowledging the feedback', async () => {
			const { shortId } = registerAlert('alert-vote-down');
			const ctx = makeContext(`vd:${shortId}`);
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('👎 Gracias por tu feedback', { show_alert: false });
		});

		it('handles details by replying with the stored alert enrichment', async () => {
			const { shortId, alertId } = registerAlert('alert-details-1');
			const getAlertById = jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'BTC long @ 60000',
				enrichmentData: {
					sentiment: 'bullish',
					insights: ['Strong momentum', 'Volume rising'],
					technical_levels: ['Support 58000'],
					invalidation_level: 58000,
					target_level: 65000,
					sources: [{ url: 'https://example.com', title: 'Example' }],
				},
			});
			const ctx = makeContext(`d:${shortId}`);
			await handleAlertAction(ctx);
			expect(getAlertById).toHaveBeenCalledWith(alertId);
			const replyArgs = ctx.reply.mock.calls[0];
			expect(replyArgs[0]).toContain('*Sentimiento:* bullish');
			expect(replyArgs[0]).toContain('*Insights:*');
			expect(replyArgs[0]).toContain('Strong momentum');
			expect(replyArgs[0]).toContain('*Niveles técnicos:*');
			expect(replyArgs[0]).toContain('*Invalidación:* 58000');
			expect(replyArgs[0]).toContain('*Objetivo:* 65000');
			expect(replyArgs[0]).toContain('*Fuentes:*');
			expect(replyArgs[1]).toEqual({ parse_mode: 'MarkdownV2' });
			expect(ctx.answerCbQuery).toHaveBeenCalled();
			getAlertById.mockRestore();
		});

		it('falls back to plain text when MarkdownV2 parse fails on the details reply', async () => {
			const { shortId, alertId } = registerAlert('alert-details-fallback');
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'Sample',
				enrichmentData: { sentiment: 'bullish' },
			});
			const ctx = makeContext(`d:${shortId}`);
			ctx.reply = jest.fn()
				.mockRejectedValueOnce(new Error('parse entities failed'))
				.mockResolvedValueOnce({ message_id: 100 });
			await handleAlertAction(ctx);
			expect(ctx.reply).toHaveBeenCalledTimes(2);
			expect(ctx.answerCbQuery).toHaveBeenCalled();
		});

		it('replay answers with a not-found toast when the stored alert is missing', async () => {
			const { shortId } = registerAlert('alert-replay-missing');
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue(null);
			// Stub the notification manager to a no-op (should not be called)
			const notifSpy = jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue(null);
			const ctx = makeContext(`r:${shortId}`);
			await handleAlertAction(ctx);
			expect(ctx.answerCbQuery).toHaveBeenCalledWith(
				'Alerta no encontrada o ya expirada',
				{ show_alert: false },
			);
			notifSpy.mockRestore();
		});

		it('replay dispatches to notification manager when the stored alert exists', async () => {
			const { shortId, alertId } = registerAlert('alert-replay-ok');
			jest.spyOn(alertStorageService, 'getAlertById').mockResolvedValue({
				id: alertId,
				text: 'Replay target',
				enrichmentData: null,
			});
			const sendToChannels = jest.fn().mockResolvedValue([
				{ channel: 'telegram', success: true },
			]);
			jest.spyOn(alertModule, 'getNotificationManager').mockReturnValue({ sendToChannels });
			const ctx = makeContext(`r:${shortId}`);
			await handleAlertAction(ctx);
			expect(sendToChannels).toHaveBeenCalledTimes(1);
			const sentPayload = sendToChannels.mock.calls[0][0];
			expect(sentPayload).toMatchObject({
				text: 'Replay target',
				source: 'telegram-replay',
			});
			expect(sendToChannels.mock.calls[0][1]).toEqual(expect.arrayContaining(['telegram']));
			expect(ctx.answerCbQuery).toHaveBeenCalledWith('Reenviado a 1 canal', { show_alert: false });
		});
	});
});
