'use strict';

/**
 * Telegram alert action handlers — wires `bot.action(/^a:/, ...)` callbacks
 * for the inline keyboard attached to alert messages. Each button emits a
 * callback_data payload produced by telegramAlertKeyboard; the same handler
 * regex dispatches to the appropriate action (replay, details, dismiss, vote).
 *
 * All handlers are fail-open: a missing alert, missing bot, missing metadata,
 * or any Telegram error is logged and surfaced as a
 * `answerCbQuery` toast so the button stops loading within Telegram's 30s
 * window. The original alert message is never modified, replayed, or
 * redelivered on handler failure.
 */

const { parseCallbackData, getActionCodes } = require('../services/alerts/telegramAlertKeyboard');
const alertStorageService = require('../services/storage/AlertStorageService');
const sentryService = require('../services/monitoring/SentryService');
const alertModule = require('../controllers/webhooks/handlers/alert/alert');
const { escapeRiskFieldValue } = require('../services/notification/formatters/markdownV2Formatter');

const ACTION_CALLBACK_REGEX = /^(r|d|x|vu|vd):([A-Za-z0-9_-]{1,60})$/;
const REPLY_MESSAGE_TRUNCATE = 3500;
const VOTE_RECORD_LIMIT = 5;
const REPLAY_OPERATOR_IDS_ENV = 'TELEGRAM_ACTION_OPERATOR_USER_IDS';
const VALID_REPLAY_CHANNELS = new Set(['telegram', 'whatsapp', 'discord']);

function getReplayOperatorIds() {
	return String(process.env[REPLAY_OPERATOR_IDS_ENV] || '')
		.split(',')
		.map((value) => value.trim())
		.filter((value) => /^\d+$/.test(value));
}

function isReplayAuthorized(context) {
	const senderId = context?.update?.callbackQuery?.from?.id;
	return senderId !== undefined
		&& getReplayOperatorIds().includes(String(senderId));
}

async function answerCallback(context, text) {
	try {
		await context.answerCbQuery(text, { show_alert: false });
	} catch (error) {
		console.warn('[telegramAlertActions] Failed to answer callback:', error.message);
	}
}

async function replyToUser(context, text) {
	if (typeof context.reply !== 'function') return;
	try {
		await context.reply(text);
	} catch (error) {
		console.warn('[telegramAlertActions] Failed to send callback result:', error.message);
	}
}

function normalizeChannels(channels) {
	if (!Array.isArray(channels)) return [];
	return [...new Set(channels
		.filter((channel) => typeof channel === 'string')
		.map((channel) => channel.trim().toLowerCase())
		.filter((channel) => VALID_REPLAY_CHANNELS.has(channel)))];
}

function getReplayChannels(alert, notificationManager) {
	const storedChannels = normalizeChannels(alert && alert.channels);
	if (storedChannels.length > 0) return storedChannels;
	if (typeof notificationManager?.getEnabledChannels === 'function') {
		return normalizeChannels(notificationManager.getEnabledChannels());
	}
	return [
		'telegram',
		...(process.env.ENABLE_WHATSAPP_ALERTS === 'true' ? ['whatsapp'] : []),
		...(process.env.ENABLE_DISCORD_ALERTS === 'true' ? ['discord'] : []),
	];
}

function getStoredTelegramThreadId(alert) {
	if (typeof alert?.telegramThreadId === 'number'
		&& Number.isSafeInteger(alert.telegramThreadId)
		&& alert.telegramThreadId >= 0) {
		return alert.telegramThreadId;
	}
	const telegramResult = Array.isArray(alert?.deliveryResults)
		? alert.deliveryResults.find((result) => result && result.channel === 'telegram')
		: null;
	if (typeof telegramResult?.threadId === 'number'
		&& Number.isSafeInteger(telegramResult.threadId)
		&& telegramResult.threadId >= 0) {
		return telegramResult.threadId;
	}
	if (typeof telegramResult?.message_thread_id === 'number'
		&& Number.isSafeInteger(telegramResult.message_thread_id)
		&& telegramResult.message_thread_id >= 0) {
		return telegramResult.message_thread_id;
	}
	return undefined;
}

function truncate(text, limit = REPLY_MESSAGE_TRUNCATE) {
	if (typeof text !== 'string') return '';
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… (truncado)`;
}

function buildQualityFeedbackKey(alertId, side) {
	if (typeof alertId !== 'string' || !alertId) return null;
	const normalizedSide = side === 'up' ? 'up' : 'down';
	return `${alertId}::${normalizedSide}`;
}

function recordQualityFeedback(alertId, side) {
	// In-process recorder. Quality feedback is intentionally an in-memory log
	// for now: a future issue will persist these to SignalOutcomeService for
	// long-term aggregation. Storing the most recent N entries is enough to
	// power operator debugging and short-window aggregation.
	const key = buildQualityFeedbackKey(alertId, side);
	if (!key) return;
	if (!recordQualityFeedback._store) {
		recordQualityFeedback._store = new Map();
	}
	const store = recordQualityFeedback._store;
	store.set(key, { alertId, side, recordedAt: Date.now() });
	if (store.size > VOTE_RECORD_LIMIT * 50) {
		// Drop oldest entries to keep the map bounded.
		const oldestKey = store.keys().next().value;
		if (oldestKey !== undefined) store.delete(oldestKey);
	}
}

function buildDetailsMessage(alert) {
	if (!alert) return null;
	const lines = [];
	const enrichment = alert.enrichmentData;
	if (enrichment) {
		if (enrichment.sentiment) lines.push(`*Sentimiento:* ${escapeRiskFieldValue(String(enrichment.sentiment))}`);
		if (Array.isArray(enrichment.insights) && enrichment.insights.length > 0) {
			lines.push('*Insights:*');
			enrichment.insights.forEach((insight) => lines.push(`• ${escapeRiskFieldValue(String(insight))}`));
		}
		if (Array.isArray(enrichment.technical_levels) && enrichment.technical_levels.length > 0) {
			lines.push('*Niveles técnicos:*');
			enrichment.technical_levels.forEach((level) => lines.push(`• ${escapeRiskFieldValue(String(level))}`));
		}
		if (enrichment.invalidation_level !== undefined && enrichment.invalidation_level !== null) {
			lines.push(`*Invalidación:* ${escapeRiskFieldValue(String(enrichment.invalidation_level))}`);
		}
		if (enrichment.target_level !== undefined && enrichment.target_level !== null) {
			lines.push(`*Objetivo:* ${escapeRiskFieldValue(String(enrichment.target_level))}`);
		}
		if (Array.isArray(enrichment.sources) && enrichment.sources.length > 0) {
			lines.push('*Fuentes:*');
			enrichment.sources.slice(0, 5).forEach((source) => {
				if (source && source.url) {
					lines.push(`• ${escapeRiskFieldValue(String(source.title || source.url))}`);
				} else if (source && source.title) {
					lines.push(`• ${escapeRiskFieldValue(String(source.title))}`);
				}
			});
		}
	}
	if (lines.length === 0) {
		lines.push('No hay datos enriquecidos para esta alerta.');
	}
	if (alert.text) {
		lines.push('');
		lines.push(`_Alerta:_ ${escapeRiskFieldValue(truncate(alert.text, 200))}`);
	}
	return lines.join('\n');
}

function formatDetailsForTelegram(alert) {
	const message = buildDetailsMessage(alert);
	if (!message) return null;
	return message;
}

async function handleReplay(context, parsed, storeEntry) {
	if (!isReplayAuthorized(context)) {
		await answerCallback(context, 'No autorizado para reenviar alertas');
		return;
	}
	await answerCallback(context, 'Reenvío iniciado');

	const alert = await alertStorageService.getAlertById(storeEntry.alertId).catch((error) => {
		console.warn('[telegramAlertActions] Failed to fetch stored alert for replay:', error.message);
		return null;
	});
	if (!alert) {
		await replyToUser(context, 'Alerta no encontrada o ya expirada');
		return;
	}
	const notificationManager = alertModule.getNotificationManager();
	if (!notificationManager) {
		await replyToUser(context, 'Servicio de notificaciones no disponible');
		return;
	}
	const channels = getReplayChannels(alert, notificationManager);
	if (channels.length === 0) {
		await replyToUser(context, 'No hay canales habilitados para reenviar la alerta');
		return;
	}
	const idempotencyKey = `tg-replay:${storeEntry.alertId}:${Date.now()}`;
	const telegramThreadId = getStoredTelegramThreadId(alert);
	const replayPayload = {
		text: alert.text,
		enriched: alert.enrichmentData || undefined,
		source: 'telegram-replay',
		replay: { originalAlertId: storeEntry.alertId, idempotencyKey },
		...(alert.telegramChatId ? { telegramChatId: alert.telegramChatId } : {}),
		...(telegramThreadId !== undefined
			? { telegramThreadId }
			: {}),
		...(alert.whatsappChatId ? { whatsappChatId: alert.whatsappChatId } : {}),
		...(alert.discordWebhookUrl ? { discordWebhookUrl: alert.discordWebhookUrl } : {}),
	};
	try {
		const results = await notificationManager.sendToChannels(replayPayload, channels);
		const delivered = Array.isArray(results)
			? results.filter((result) => result && result.success).length
			: 0;
		await replyToUser(context, delivered > 0
			? `Reenviado a ${delivered} canal${delivered === 1 ? '' : 'es'}`
			: 'No se pudo reenviar la alerta');
	} catch (error) {
		console.error('[telegramAlertActions] Replay failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: { action: 'replay', alertId: storeEntry.alertId },
		});
		await replyToUser(context, 'Error al reenviar la alerta');
	}
}

async function handleDetails(context, storeEntry) {
	let alert;
	try {
		alert = await alertStorageService.getAlertById(storeEntry.alertId);
	} catch (error) {
		console.warn('[telegramAlertActions] Failed to read alert for details:', error.message);
	}
	if (!alert) {
		await context.answerCbQuery('Alerta no encontrada o ya expirada', { show_alert: false });
		return;
	}
	const message = formatDetailsForTelegram(alert);
	try {
		await context.reply(message || 'Sin datos para mostrar', { parse_mode: 'MarkdownV2' });
		await context.answerCbQuery();
	} catch (error) {
		console.warn('[telegramAlertActions] Failed to send details reply:', error.message);
		try {
			await context.reply(message || 'Sin datos para mostrar');
			await context.answerCbQuery();
		} catch (fallbackError) {
			console.error('[telegramAlertActions] Plain-text fallback also failed:', fallbackError.message);
			sentryService.captureRuntimeError({
				channel: 'telegram',
				error: fallbackError,
				extra: { action: 'details', alertId: storeEntry.alertId },
			});
			await context.answerCbQuery('No pude mostrar los detalles', { show_alert: false });
		}
	}
}

async function handleDismiss(context) {
	try {
		if (context.update && context.update.callbackQuery && context.update.callbackQuery.message) {
			const message = context.update.callbackQuery.message;
			await context.telegram.editMessageReplyMarkup(
				message.chat.id,
				message.message_id,
				undefined,
				{ inline_keyboard: [] },
			).catch(() => { /* best-effort: message may have been deleted */ });
		}
		await context.answerCbQuery('Alerta descartada', { show_alert: false });
	} catch (error) {
		console.warn('[telegramAlertActions] Dismiss failed:', error.message);
		await context.answerCbQuery('No pude descartar la alerta', { show_alert: false });
	}
}

async function handleVote(context, parsed, storeEntry) {
	const side = parsed.action === getActionCodes().ACTION_VOTE_UP ? 'up' : 'down';
	recordQualityFeedback(storeEntry.alertId, side);
	await context.answerCbQuery(side === 'up' ? '👍 Gracias por tu feedback' : '👎 Gracias por tu feedback', { show_alert: false });
}

async function handleAlertAction(context) {
	const callbackData = context.update && context.update.callbackQuery
		? context.update.callbackQuery.data
		: null;
	if (!callbackData) {
		await context.answerCbQuery('Acción no reconocida', { show_alert: false });
		return;
	}
	if (!ACTION_CALLBACK_REGEX.test(callbackData)) {
		await context.answerCbQuery('Acción no reconocida', { show_alert: false });
		return;
	}
	const parsed = parseCallbackData(callbackData);
	if (!parsed) {
		await context.answerCbQuery('Acción no reconocida', { show_alert: false });
		return;
	}
	if (parsed.action === getActionCodes().ACTION_REPLAY) {
		await handleReplay(context, parsed, { alertId: parsed.alertId });
		return;
	}
	if (parsed.action === getActionCodes().ACTION_DETAILS) {
		await handleDetails(context, { alertId: parsed.alertId });
		return;
	}
	if (parsed.action === getActionCodes().ACTION_DISMISS) {
		await handleDismiss(context);
		return;
	}
	if (parsed.action === getActionCodes().ACTION_VOTE_UP || parsed.action === getActionCodes().ACTION_VOTE_DOWN) {
		await handleVote(context, parsed, { alertId: parsed.alertId });
		return;
	}
	await context.answerCbQuery('Acción no soportada', { show_alert: false });
}

function registerAlertActionHandlers(bot) {
	if (!bot || typeof bot.action !== 'function') {
		return false;
	}
	try {
		bot.action(ACTION_CALLBACK_REGEX, handleAlertAction);
		return true;
	} catch (error) {
		console.warn('[telegramAlertActions] Failed to register action handler:', error.message);
		return false;
	}
}

function getRecordedQualityFeedback() {
	const store = recordQualityFeedback._store;
	if (!store) return [];
	return Array.from(store.values());
}

module.exports = {
	registerAlertActionHandlers,
	handleAlertAction,
	ACTION_CALLBACK_REGEX,
	recordQualityFeedback,
	getRecordedQualityFeedback,
};
