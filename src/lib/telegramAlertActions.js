'use strict';

/**
 * Telegram alert action handlers — wires `bot.action(/^a:/, ...)` callbacks
 * for the inline keyboard attached to alert messages. Each button emits a
 * callback_data payload produced by telegramAlertKeyboard; the same handler
 * regex dispatches to the appropriate action (replay, details, dismiss, vote).
 *
 * All handlers are fail-open: a missing store entry, missing bot, missing
 * alert metadata, or any Telegram error is logged and surfaced as a
 * `answerCbQuery` toast so the button stops loading within Telegram's 30s
 * window. The original alert message is never modified, replayed, or
 * redelivered on handler failure.
 */

const { parseCallbackData, getActionCodes } = require('../services/alerts/telegramAlertKeyboard');
const { defaultStore } = require('../services/alerts/telegramActionStore');
const alertStorageService = require('../services/storage/AlertStorageService');
const sentryService = require('../services/monitoring/SentryService');
const alertModule = require('../controllers/webhooks/handlers/alert/alert');

const ACTION_CALLBACK_REGEX = /^(r|d|x|vu|vd):([0-9A-Z]{8,16})$/;
const REPLY_MESSAGE_TRUNCATE = 3500;
const VOTE_RECORD_LIMIT = 5;

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
		if (enrichment.sentiment) lines.push(`*Sentimiento:* ${enrichment.sentiment}`);
		if (Array.isArray(enrichment.insights) && enrichment.insights.length > 0) {
			lines.push('*Insights:*');
			enrichment.insights.forEach((insight) => lines.push(`• ${insight}`));
		}
		if (Array.isArray(enrichment.technical_levels) && enrichment.technical_levels.length > 0) {
			lines.push('*Niveles técnicos:*');
			enrichment.technical_levels.forEach((level) => lines.push(`• ${level}`));
		}
		if (enrichment.invalidation_level !== undefined && enrichment.invalidation_level !== null) {
			lines.push(`*Invalidación:* ${enrichment.invalidation_level}`);
		}
		if (enrichment.target_level !== undefined && enrichment.target_level !== null) {
			lines.push(`*Objetivo:* ${enrichment.target_level}`);
		}
		if (Array.isArray(enrichment.sources) && enrichment.sources.length > 0) {
			lines.push('*Fuentes:*');
			enrichment.sources.slice(0, 5).forEach((source) => {
				if (source && source.url) {
					lines.push(`• ${source.title || source.url}`);
				} else if (source && source.title) {
					lines.push(`• ${source.title}`);
				}
			});
		}
	}
	if (lines.length === 0) {
		lines.push('No hay datos enriquecidos para esta alerta.');
	}
	if (alert.text) {
		lines.push('');
		lines.push(`_Alerta:_ ${truncate(alert.text, 200)}`);
	}
	return lines.join('\n');
}

function formatDetailsForTelegram(alert) {
	const message = buildDetailsMessage(alert);
	if (!message) return null;
	return message;
}

async function handleReplay(context, parsed, storeEntry) {
	const alert = await alertStorageService.getAlertById(storeEntry.alertId).catch((error) => {
		console.warn('[telegramAlertActions] Failed to fetch stored alert for replay:', error.message);
		return null;
	});
	if (!alert) {
		await context.answerCbQuery('Alerta no encontrada o ya expirada', { show_alert: false });
		return;
	}
	const notificationManager = alertModule.getNotificationManager();
	if (!notificationManager) {
		await context.answerCbQuery('Servicio de notificaciones no disponible', { show_alert: false });
		return;
	}
	const channels = ['telegram'];
	if (process.env.ENABLE_WHATSAPP_ALERTS === 'true') channels.push('whatsapp');
	if (process.env.ENABLE_DISCORD_ALERTS === 'true') channels.push('discord');
	const idempotencyKey = `tg-replay:${storeEntry.alertId}:${Date.now()}`;
	const replayPayload = {
		text: alert.text,
		enriched: alert.enrichmentData || undefined,
		source: 'telegram-replay',
		replay: { originalAlertId: storeEntry.alertId, idempotencyKey },
		...(alert.telegramChatId ? { telegramChatId: alert.telegramChatId } : {}),
		...(storeEntry.threadId !== undefined && storeEntry.threadId !== null
			? { telegramThreadId: storeEntry.threadId }
			: {}),
		...(alert.whatsappChatId ? { whatsappChatId: alert.whatsappChatId } : {}),
		...(alert.discordWebhookUrl ? { discordWebhookUrl: alert.discordWebhookUrl } : {}),
	};
	try {
		const results = await notificationManager.sendToChannels(replayPayload, channels);
		const delivered = Array.isArray(results)
			? results.filter((result) => result && result.success).length
			: 0;
		await context.answerCbQuery(delivered > 0
			? `Reenviado a ${delivered} canal${delivered === 1 ? '' : 'es'}`
			: 'No se pudo reenviar la alerta', { show_alert: false });
	} catch (error) {
		console.error('[telegramAlertActions] Replay failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: { action: 'replay', alertId: storeEntry.alertId },
		});
		await context.answerCbQuery('Error al reenviar la alerta', { show_alert: false });
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
	let storeEntry;
	try {
		storeEntry = defaultStore.lookup(parsed.shortId);
	} catch (error) {
		storeEntry = null;
	}
	if (!storeEntry) {
		await context.answerCbQuery('La alerta ya no está disponible para acciones', { show_alert: false });
		return;
	}
	if (parsed.action === getActionCodes().ACTION_REPLAY) {
		await handleReplay(context, parsed, storeEntry);
		return;
	}
	if (parsed.action === getActionCodes().ACTION_DETAILS) {
		await handleDetails(context, storeEntry);
		return;
	}
	if (parsed.action === getActionCodes().ACTION_DISMISS) {
		await handleDismiss(context);
		return;
	}
	if (parsed.action === getActionCodes().ACTION_VOTE_UP || parsed.action === getActionCodes().ACTION_VOTE_DOWN) {
		await handleVote(context, parsed, storeEntry);
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
