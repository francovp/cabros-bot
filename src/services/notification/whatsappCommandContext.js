'use strict';

/**
 * Issue #886 — WhatsApp command parity.
 *
 * The Telegram handlers in `src/controllers/commands.js` are plain
 * `async (context) => {}` functions that touch only a small Telegraf-shaped surface:
 * `context.message.text`, `context.update.message.chat.id`, `context.reply()` and an
 * optional `context.telegram`. Reusing them verbatim is what keeps WhatsApp replies
 * identical to Telegram ones — reimplementing the four commands would drift the moment
 * a Telegram reply changes. This module adapts a WhatsApp chat to that surface.
 *
 * `context.telegram` is deliberately left undefined: `sendReadinessWarning()`,
 * `sendMaintenanceReply()` and `replyValidationError()` all fall back to
 * `context.reply()` when it is absent, so a degraded-MCP warning or a validation
 * error reaches WhatsApp instead of being dropped.
 */

/**
 * WhatsApp command token -> the Telegram command it mirrors.
 *
 * `command` is the verb handed to the shared parser without the WhatsApp `!` prefix,
 * so `parseCommandArgs()` consumes it exactly as it consumes `/analisis`.
 */
const TELEGRAM_COMMAND_DELEGATES = Object.freeze({
	analisis: { command: 'analisis', handlerName: 'expandedAnalysisCmd' },
	scanner: { command: 'scanner', handlerName: 'marketScannerCmd' },
	noticias: { command: 'noticias', handlerName: 'newsMonitorCmd' },
	news: { command: 'noticias', handlerName: 'newsMonitorCmd' },
	outcomes: { command: 'outcomes', handlerName: 'outcomesCommand' },
	rendimiento: { command: 'outcomes', handlerName: 'outcomesCommand' },
});

/**
 * @param {Object} params
 * @param {string} params.chatId - GreenAPI chat id the command arrived in
 * @param {string} params.command - Telegram verb, without prefix
 * @param {string} [params.args] - Remaining arguments
 * @param {Object} params.whatsAppService - Destination for every reply
 * @returns {Object} Telegraf-shaped command context
 */
function createWhatsAppCommandContext({ chatId, command, args = '', whatsAppService }) {
	return {
		message: {
			text: args ? `/${command} ${args}` : `/${command}`,
		},
		update: {
			message: {
				chat: { id: chatId },
			},
		},
		notificationRouting: {
			channels: ['whatsapp'],
			whatsappChatId: chatId,
		},
		async reply(text) {
			if (typeof text !== 'string' || !text) {
				return null;
			}
			return whatsAppService.send({ text, whatsappChatId: chatId });
		},
	};
}

module.exports = {
	createWhatsAppCommandContext,
	TELEGRAM_COMMAND_DELEGATES,
};