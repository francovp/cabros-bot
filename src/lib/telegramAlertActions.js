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
const alertFeedbackStorageService = require('../services/storage/AlertFeedbackStorageService');
const { idempotencyService } = require('../services/storage/IdempotencyService');
const sentryService = require('../services/monitoring/SentryService');
const alertModule = require('../controllers/webhooks/handlers/alert/alert');
const { escapeRiskFieldValue } = require('../services/notification/formatters/markdownV2Formatter');

const ACTION_CALLBACK_REGEX = /^(r|d|x|vu|vd):([A-Za-z0-9_-]{1,60})$/;
const REPLY_MESSAGE_TRUNCATE = 3500;
const VOTE_RECORD_LIMIT = 5;
const REPLAY_OPERATOR_IDS_ENV = 'TELEGRAM_ACTION_OPERATOR_USER_IDS';
const VALID_REPLAY_CHANNELS = new Set(['telegram', 'whatsapp', 'discord']);
const CALLBACK_STORAGE_TIMEOUT_MS = 5000;

function getReplayOperatorIds() {
	return String(process.env[REPLAY_OPERATOR_IDS_ENV] || '')
		.split(',')
		.map((value) => value.trim())
		.filter((value) => /^\d+$/.test(value));
}

function isOperatorAuthorized(context) {
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

function withCallbackTimeout(operation, onLateResult) {
	let timeoutId;
	let timedOut = false;
	const operationPromise = Promise.resolve().then(operation);
	operationPromise.then((result) => {
		if (timedOut && typeof onLateResult === 'function') {
			onLateResult(result);
		}
	}, () => {});
	const timeoutPromise = new Promise((resolve, reject) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			const error = new Error('Telegram callback storage operation timed out');
			error.code = 'TELEGRAM_CALLBACK_STORAGE_TIMEOUT';
			reject(error);
		}, CALLBACK_STORAGE_TIMEOUT_MS);
	});

	return Promise.race([
		operationPromise,
		timeoutPromise,
	]).finally(() => clearTimeout(timeoutId));
}

function getReplayCallbackId(context) {
	const callbackId = context?.update?.callbackQuery?.id;
	if (typeof callbackId === 'string' && callbackId.trim()) {
		return callbackId.trim();
	}
	return context?.update?.callbackQuery?.data || 'unknown';
}

function buildReplayIdempotencyKey(context, alertId) {
	return `telegram:replay:${alertId}:${getReplayCallbackId(context)}`;
}

function buildReplayFingerprint(alertId, idempotencyKey) {
	return {
		action: 'telegram-replay',
		alertId,
		idempotencyKey,
	};
}

function releaseReplayReservation(idempotencyKey, fingerprint, error) {
	try {
		idempotencyService.release(idempotencyKey, fingerprint, error);
	} catch (releaseError) {
		console.warn('[telegramAlertActions] Failed to release replay reservation:', releaseError.message);
	}
}

function isCallbackStorageTimeout(error) {
	return error?.code === 'TELEGRAM_CALLBACK_STORAGE_TIMEOUT';
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

function truncateTelegramMessage(text, limit = REPLY_MESSAGE_TRUNCATE) {
	if (typeof text !== 'string' || text.length <= limit) return text;
	const suffix = '\n… \\(truncado\\)';
	const contentLimit = Math.max(0, limit - suffix.length);
	let content = text.slice(0, contentLimit).trimEnd();
	if (content.endsWith('\\')) content = content.slice(0, -1).trimEnd();
	return `${content}${suffix}`;
}

function buildQualityFeedbackKey(alertId, side, senderId) {
	if (typeof alertId !== 'string' || !alertId) return null;
	const normalizedSide = side === 'up' ? 'up' : 'down';
	const normalizedSenderId = senderId === undefined || senderId === null
		? 'unknown'
		: String(senderId);
	return `${alertId}::${normalizedSide}::${normalizedSenderId}`;
}

function recordQualityFeedback(alertId, side, senderId) {
	// In-process recorder. Quality feedback is intentionally an in-memory log
	// for now: a future issue will persist these to SignalOutcomeService for
	// long-term aggregation. Storing the most recent N entries is enough to
	// power operator debugging and short-window aggregation.
	const key = buildQualityFeedbackKey(alertId, side, senderId);
	if (!key) return;
	if (!recordQualityFeedback._store) {
		recordQualityFeedback._store = new Map();
	}
	const store = recordQualityFeedback._store;
	store.set(key, {
		alertId,
		side,
		senderId: senderId === undefined || senderId === null ? 'unknown' : String(senderId),
		recordedAt: Date.now(),
	});
	if (store.size > VOTE_RECORD_LIMIT * 50) {
		// Drop oldest entries to keep the map bounded.
		const oldestKey = store.keys().next().value;
		if (oldestKey !== undefined) store.delete(oldestKey);
	}
}

function buildDetailsLines(alert, { escapeMarkdown = true } = {}) {
	if (!alert) return null;
	const lines = [];
	const enrichment = alert.enrichmentData;
	const formatValue = (val) => (escapeMarkdown ? escapeRiskFieldValue(String(val)) : String(val));

	if (enrichment) {
		if (enrichment.sentiment) {
			lines.push(escapeMarkdown
				? `*Sentimiento:* ${formatValue(enrichment.sentiment)}`
				: `Sentimiento: ${formatValue(enrichment.sentiment)}`);
		}
		if (Array.isArray(enrichment.insights) && enrichment.insights.length > 0) {
			lines.push(escapeMarkdown ? '*Insights:*' : 'Insights:');
			enrichment.insights.forEach((insight) => lines.push(`• ${formatValue(insight)}`));
		}
		const technicalLevels = enrichment.technical_levels;
		const technicalLevelLines = Array.isArray(technicalLevels)
			? technicalLevels.map((level) => `• ${formatValue(level)}`)
			: [
				...(Array.isArray(technicalLevels?.supports)
					? technicalLevels.supports.map((level) => `• Soporte: ${formatValue(level)}`)
					: []),
				...(Array.isArray(technicalLevels?.resistances)
					? technicalLevels.resistances.map((level) => `• Resistencia: ${formatValue(level)}`)
					: []),
			];
		if (technicalLevelLines.length > 0) {
			lines.push(escapeMarkdown ? '*Niveles técnicos:*' : 'Niveles técnicos:');
			lines.push(...technicalLevelLines);
		}
		if (enrichment.invalidation_level !== undefined && enrichment.invalidation_level !== null) {
			lines.push(escapeMarkdown
				? `*Invalidación:* ${formatValue(enrichment.invalidation_level)}`
				: `Invalidación: ${formatValue(enrichment.invalidation_level)}`);
		}
		if (enrichment.target_level !== undefined && enrichment.target_level !== null) {
			lines.push(escapeMarkdown
				? `*Objetivo:* ${formatValue(enrichment.target_level)}`
				: `Objetivo: ${formatValue(enrichment.target_level)}`);
		}
		if (Array.isArray(enrichment.sources) && enrichment.sources.length > 0) {
			lines.push(escapeMarkdown ? '*Fuentes:*' : 'Fuentes:');
			enrichment.sources.slice(0, 5).forEach((source) => {
				if (source && source.url) {
					lines.push(`• ${formatValue(source.title || source.url)}`);
				} else if (source && source.title) {
					lines.push(`• ${formatValue(source.title)}`);
				}
			});
		}
	}
	if (lines.length === 0) {
		lines.push('No hay datos enriquecidos para esta alerta.');
	}
	if (alert.text) {
		lines.push('');
		lines.push(escapeMarkdown
			? `_Alerta:_ ${formatValue(truncate(alert.text, 200))}`
			: `Alerta: ${truncate(alert.text, 200)}`);
	}
	return lines.join('\n');
}

function buildDetailsMessage(alert) {
	return buildDetailsLines(alert, { escapeMarkdown: true });
}

function buildPlainDetailsMessage(alert) {
	const message = buildDetailsLines(alert, { escapeMarkdown: false });
	if (!message) return null;
	return truncate(message, REPLY_MESSAGE_TRUNCATE);
}

function formatDetailsForTelegram(alert) {
	const message = buildDetailsMessage(alert);
	if (!message) return null;
	return truncateTelegramMessage(message);
}

async function handleReplay(context, parsed, storeEntry) {
	if (!isOperatorAuthorized(context)) {
		await answerCallback(context, 'No autorizado para reenviar alertas');
		return;
	}
	await answerCallback(context, 'Reenvío iniciado');

	const idempotencyKey = buildReplayIdempotencyKey(context, storeEntry.alertId);
	const fingerprint = buildReplayFingerprint(storeEntry.alertId, idempotencyKey);
	let reservation;
	try {
		reservation = await withCallbackTimeout(
			() => idempotencyService.reserve(idempotencyKey, fingerprint),
			(lateReservation) => {
				if (lateReservation?.state === 'fresh') {
					releaseReplayReservation(idempotencyKey, fingerprint);
				}
			},
		);
	} catch (error) {
		console.warn('[telegramAlertActions] Failed to reserve replay:', error.message);
		await replyToUser(context, 'Servicio de almacenamiento no disponible; intenta de nuevo');
		return;
	}
	if (reservation?.state === 'completed') {
		await replyToUser(context, 'Reenvío ya procesado');
		return;
	}
	if (reservation?.state === 'pending') {
		await replyToUser(context, 'Reenvío ya en curso');
		return;
	}

	let readError = null;
	let alert;
	try {
		alert = await withCallbackTimeout(() => alertStorageService.getAlertById(storeEntry.alertId));
	} catch (error) {
		readError = error;
		console.warn('[telegramAlertActions] Failed to fetch stored alert for replay:', error.message);
	}
	if (!alert) {
		releaseReplayReservation(idempotencyKey, fingerprint, readError);
		await replyToUser(context, isCallbackStorageTimeout(readError)
			? 'Servicio de almacenamiento no disponible; intenta de nuevo'
			: 'Alerta no encontrada o ya expirada');
		return;
	}
	const notificationManager = alertModule.getNotificationManager();
	if (!notificationManager) {
		releaseReplayReservation(idempotencyKey, fingerprint);
		await replyToUser(context, 'Servicio de notificaciones no disponible');
		return;
	}
	const channels = getReplayChannels(alert, notificationManager);
	if (channels.length === 0) {
		releaseReplayReservation(idempotencyKey, fingerprint);
		await replyToUser(context, 'No hay canales habilitados para reenviar la alerta');
		return;
	}
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
		try {
			await withCallbackTimeout(() => alertStorageService.saveReplayAttempt({
				alertId: storeEntry.alertId,
				idempotencyKey,
				channels,
				deliveryResults: results,
			}));
		} catch (error) {
			console.warn('[telegramAlertActions] Failed to persist replay audit:', error.message);
		}
		try {
			idempotencyService.set(idempotencyKey, fingerprint, {
				statusCode: 200,
				body: { delivered },
				headers: {},
			});
		} catch (error) {
			console.warn('[telegramAlertActions] Failed to complete replay reservation:', error.message);
		}
		await replyToUser(context, delivered > 0
			? `Reenviado a ${delivered} canal${delivered === 1 ? '' : 'es'}`
			: 'No se pudo reenviar la alerta');
	} catch (error) {
		console.error('[telegramAlertActions] Replay failed:', error.message);
		releaseReplayReservation(idempotencyKey, fingerprint, error);
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: { action: 'replay', alertId: storeEntry.alertId },
		});
		await replyToUser(context, 'Error al reenviar la alerta');
	}
}

async function handleDetails(context, storeEntry) {
	await answerCallback(context);
	let alert;
	let readError = null;
	try {
		alert = await withCallbackTimeout(() => alertStorageService.getAlertById(storeEntry.alertId));
	} catch (error) {
		readError = error;
		console.warn('[telegramAlertActions] Failed to read alert for details:', error.message);
	}
	if (!alert) {
		await replyToUser(context, isCallbackStorageTimeout(readError)
			? 'Servicio de almacenamiento no disponible; intenta de nuevo'
			: 'Alerta no encontrada o ya expirada');
		return;
	}
	const message = formatDetailsForTelegram(alert);
	try {
		await withCallbackTimeout(() => context.reply(message || 'Sin datos para mostrar', { parse_mode: 'MarkdownV2' }));
	} catch (error) {
		console.warn('[telegramAlertActions] Failed to send details reply:', error.message);
		try {
			const plainMessage = buildPlainDetailsMessage(alert) || message;
			await withCallbackTimeout(() => context.reply(plainMessage || 'Sin datos para mostrar'));
		} catch (fallbackError) {
			console.error('[telegramAlertActions] Plain-text fallback also failed:', fallbackError.message);
			sentryService.captureRuntimeError({
				channel: 'telegram',
				error: fallbackError,
				extra: { action: 'details', alertId: storeEntry.alertId },
			});
			await replyToUser(context, 'No pude mostrar los detalles');
		}
	}
}

async function handleDismiss(context) {
	if (!isOperatorAuthorized(context)) {
		await answerCallback(context, 'No autorizado para modificar alertas');
		return;
	}
	await answerCallback(context, 'Alerta descartada');
	try {
		if (context.update && context.update.callbackQuery && context.update.callbackQuery.message) {
			const message = context.update.callbackQuery.message;
			if (typeof context.telegram?.editMessageReplyMarkup === 'function') {
				await withCallbackTimeout(() => context.telegram.editMessageReplyMarkup(
					message.chat.id,
					message.message_id,
					undefined,
					{ inline_keyboard: [] },
				)).catch((err) => {
					console.warn('[telegramAlertActions] Failed to clear inline keyboard on dismiss:', err.message);
				});
			}
		}
	} catch (error) {
		console.warn('[telegramAlertActions] Dismiss edit failed:', error.message);
	}
}

async function handleVote(context, parsed, storeEntry) {
	const side = parsed.action === getActionCodes().ACTION_VOTE_UP ? 'up' : 'down';
	const senderId = context?.update?.callbackQuery?.from?.id;
	recordQualityFeedback(storeEntry.alertId, side, senderId);

	if (alertFeedbackStorageService && typeof alertFeedbackStorageService.isEnabled === 'function' && alertFeedbackStorageService.isEnabled()) {
		try {
			await alertFeedbackStorageService.saveFeedback({
				alertId: storeEntry.alertId,
				chatId: String(senderId ?? context?.update?.callbackQuery?.message?.chat?.id ?? 'unknown'),
				verdict: side,
				source: 'webhook-alert',
			});
		} catch (error) {
			console.warn('[telegramAlertActions] Failed to persist feedback:', error.message);
		}
	}

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
	CALLBACK_STORAGE_TIMEOUT_MS,
	recordQualityFeedback,
	getRecordedQualityFeedback,
};
