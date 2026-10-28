const { watchlistService, matchesEntries } = require('../../../services/watchlist/WatchlistService');
const alertStorageService = require('../../../services/storage/AlertStorageService');
const { escapeRiskFieldValue } = require('../../../services/notification/formatters/MarkdownV2Formatter');

function createWatchlistCommand(service = watchlistService, { listRecentAlerts = alertStorageService.listAlerts } = {}) {
	return async function watchlistCommand(context) {
		const chatId = context.chat?.id;
		const raw = context.message?.text || '';
		const [, action = '', ...rest] = raw.trim().split(/\s+/);
		const values = rest.join(' ').split(/[\s,]+/).filter(Boolean);
		try {
			let symbols;
			switch (action.toLowerCase()) {
			case 'add':
				if (values.length === 0) throw new TypeError('Symbols required');
				symbols = await service.add(chatId, values);
				break;
			case 'remove':
				if (values.length === 0) throw new TypeError('Symbols required');
				symbols = await service.remove(chatId, values);
				break;
			case 'clear':
				if (values.length > 0) throw new TypeError('Unexpected symbols');
				symbols = await service.clear(chatId);
				break;
			case '':
			case 'list':
				if (values.length > 0) throw new TypeError('Unknown watchlist command');
				symbols = await service.get(chatId);
				break;
			default:
				throw new TypeError('Unknown watchlist command');
			}
			let text = symbols.length
				? `*Watchlist*\n${symbols.map(escapeRiskFieldValue).join(', ')}`
				: '*Watchlist*\nSin símbolos configurados';
			if (!action || action.toLowerCase() === 'list') {
				try {
					let timer;
					const recent = await Promise.race([listRecentAlerts({ limit: 50 }), new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error('Recent alerts timeout')), 250);
						timer.unref?.();
					})]).finally(() => clearTimeout(timer));
					const alerts = Array.isArray(recent?.alerts) ? recent.alerts : [];
					const skipped = alerts.filter((alert) => {
						const symbol = alert?.symbol && alert.symbol !== 'unknown'
							? `${alert.exchange ? `${alert.exchange}:` : ''}${alert.symbol}`.toUpperCase()
							: null;
						return !matchesEntries(symbols, symbol);
					}).length;
					text += `\nAlertas que se habrían omitido: ${skipped} de ${alerts.length} recientes`;
				} catch {
					text += '\nVolumen reciente no disponible';
				}
			}
			await context.reply(text, { parse_mode: 'MarkdownV2' });
		} catch (error) {
			await context.reply(escapeRiskFieldValue(error.message), { parse_mode: 'MarkdownV2' });
		}
	};
}

const watchlistCommand = createWatchlistCommand();

module.exports = { createWatchlistCommand, watchlistCommand };
