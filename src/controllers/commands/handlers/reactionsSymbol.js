'use strict';

const alertStorageService = require('../../../services/storage/AlertStorageService');
const { smartEscapeMarkdownV2 } = require('../../../services/notification/formatters/markdownV2Formatter');
const logger = require('../../../lib/logging');

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
			const emptyMsg = `No hay reacciones registradas para ${smartEscapeMarkdownV2(symbol)} en los últimos 7 días\\.`;
			return ctx.reply(emptyMsg, { parse_mode: 'MarkdownV2' });
		}

		let msg = `🔥 *Top Setups por Reacciones para ${smartEscapeMarkdownV2(symbol)}* \\(Últimos 7 días\\)\n\n`;

		setups.forEach((setup, index) => {
			const m = setup.reactionMetrics || {};
			const dateStr = setup.receivedAt ? new Date(setup.receivedAt).toISOString().split('T')[0] : 'N/A';
			const snippet = setup.text ? setup.text.slice(0, 100).replace(/\n/g, ' ') : 'Alerta';

			msg += `*${index + 1}\\. [${smartEscapeMarkdownV2(dateStr)}]* — Score: *${smartEscapeMarkdownV2(String(m.weightedScore ?? 'N/A'))}*\n`;
			msg += `   👍 ${smartEscapeMarkdownV2(String(m.approve || 0))}  |  👎 ${smartEscapeMarkdownV2(String(m.reject || 0))}  |  Aprobación: *${smartEscapeMarkdownV2(String(Math.round((m.approveRate || 0) * 100)))}%*\n`;
			msg += `   _${smartEscapeMarkdownV2(snippet)}_\n\n`;
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
