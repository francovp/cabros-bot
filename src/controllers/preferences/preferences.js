'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const { chatPreferenceService } = require('../../services/preferences/ChatPreferenceService');

const VALID_CHANNELS = new Set(['telegram', 'whatsapp', 'discord']);

function validateChannelAndChatId(params) {
	const channel = String(params.channel || '').toLowerCase().trim();
	const chatId = String(params.chatId || '').trim();

	if (!channel || !VALID_CHANNELS.has(channel)) {
		return { error: `Canal inválido '${channel}'. Canales soportados: telegram, whatsapp, discord.` };
	}

	if (!chatId) {
		return { error: 'chatId es requerido y no puede estar vacío.' };
	}

	return { channel, chatId };
}

async function getPreferencesHandler(req, res) {
	const span = sentryService.startInactiveSpan({
		name: 'preferences.get',
		op: 'http.handler',
	});

	try {
		const { channel, chatId, error } = validateChannelAndChatId(req.params);
		if (error) {
			return res.status(400).json({ success: false, error });
		}

		const data = await chatPreferenceService.getPreferences(chatId, channel);
		return res.status(200).json({ success: true, data });
	} catch (err) {
		console.error('Error fetching chat preferences:', err);
		sentryService.captureRuntimeError({
			channel: req.params.channel || 'unknown',
			error: err,
			extra: { endpoint: 'getPreferencesHandler', params: req.params },
		});
		return res.status(500).json({ success: false, error: 'Error al obtener preferencias.' });
	} finally {
		sentryService.endSpan(span);
	}
}

async function putPreferencesHandler(req, res) {
	const span = sentryService.startInactiveSpan({
		name: 'preferences.update',
		op: 'http.handler',
	});

	try {
		const { channel, chatId, error } = validateChannelAndChatId(req.params);
		if (error) {
			return res.status(400).json({ success: false, error });
		}

		if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
			return res.status(400).json({ success: false, error: 'El cuerpo de la petición debe ser un objeto JSON.' });
		}

		const data = await chatPreferenceService.setPreferences(chatId, channel, req.body);
		return res.status(200).json({ success: true, data });
	} catch (err) {
		console.error('Error updating chat preferences:', err);
		sentryService.captureRuntimeError({
			channel: req.params.channel || 'unknown',
			error: err,
			extra: { endpoint: 'putPreferencesHandler', params: req.params },
		});
		return res.status(500).json({ success: false, error: 'Error al actualizar preferencias.' });
	} finally {
		sentryService.endSpan(span);
	}
}

async function deletePreferencesHandler(req, res) {
	const span = sentryService.startInactiveSpan({
		name: 'preferences.delete',
		op: 'http.handler',
	});

	try {
		const { channel, chatId, error } = validateChannelAndChatId(req.params);
		if (error) {
			return res.status(400).json({ success: false, error });
		}

		await chatPreferenceService.deletePreferences(chatId, channel);
		return res.status(200).json({
			success: true,
			message: `Preferencias eliminadas para ${channel}:${chatId}`,
		});
	} catch (err) {
		console.error('Error deleting chat preferences:', err);
		sentryService.captureRuntimeError({
			channel: req.params.channel || 'unknown',
			error: err,
			extra: { endpoint: 'deletePreferencesHandler', params: req.params },
		});
		return res.status(500).json({ success: false, error: 'Error al eliminar preferencias.' });
	} finally {
		sentryService.endSpan(span);
	}
}

module.exports = {
	getPreferencesHandler,
	putPreferencesHandler,
	deletePreferencesHandler,
};
