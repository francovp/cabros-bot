'use strict';

const alertStorageService = require('../../../services/storage/AlertStorageService');
const { smartEscapeMarkdownV2 } = require('../../../services/notification/formatters/MarkdownV2Formatter');
const logger = require('../../../lib/logging');

function escapeV2(text) {
	if (!text) return '';
	return smartEscapeMarkdownV2(String(text)).replace(/_/g, '\\_');
}

async function reactionsSymbol(ctx) {
	try {
		const messageText = ctx?.message?.text || '';
		const parts = messageText.trim().split(/\s+/);
		if (parts.length < 2 || !parts[1]) {
			return ctx.reply('Uso: /reactions <symbol>\nEjemplo: /reactions BTCUSDT');
		}

		const rawSymbol = parts[1].trim().toUpperCase().replace(/^[:/]+/, '');
		const symbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;

		const setups = await alertStorageService.getTopSetupsByReactions({
			symbol,
			days: 7,
			limit: 3,
		});

		if (!setups || setups.length === 0) {
			const emptyMsg = `No hay reacciones registradas para ${escapeV2(symbol)} en los últimos 7 días\\.`;
			return ctx.reply(emptyMsg, { parse_mode: 'MarkdownV2' });
		}

		let msg = `🔥 *Top Setups por Reacciones para ${escapeV2(symbol)}* \\(Últimos 7 días\\)\n\n`;

		setups.forEach((setup, index) => {
			const m = setup.reactionMetrics || {};
			const dateStr = setup.receivedAt ? new Date(setup.receivedAt).toISOString().split('T')[0] : 'N/A';
			const snippet = setup.text ? setup.text.slice(0, 100).replace(/\n/g, ' ') : 'Alerta';

			msg += `*${index + 1}\\. [${escapeV2(dateStr)}]* — Score: *${escapeV2(m.weightedScore ?? 'N/A')}*\n`;
			msg += `   👍 ${escapeV2(m.approve || 0)}  |  👎 ${escapeV2(m.reject || 0)}  |  Aprobación: *${escapeV2(Math.round((m.approveRate || 0) * 100))}%*\n`;
			msg += `   _${escapeV2(snippet)}_\n\n`;
		});

		return ctx.reply(msg.trim(), { parse_mode: 'MarkdownV2' });
	} catch (error) {
		logger.error(`Error in /reactions handler: ${error.message}`);
		return ctx.reply('Error al consultar reacciones para el símbolo solicitado\\.', { parse_mode: 'MarkdownV2' });
	}
}

module.exports = {
	reactionsSymbol,
};
