'use strict';

const { smartEscapeMarkdownV2 } = require('./formatters/markdownV2Formatter');

let botGetter = null;

function setBotGetter(getter) {
	botGetter = getter;
}

function escapeV2(text) {
	return typeof smartEscapeMarkdownV2 === 'function'
		? smartEscapeMarkdownV2(String(text || ''))
		: String(text || '');
}

function formatAmbiguousReservationMessage({ reservationId, signalId, signalContext, reason, details = {} } = {}) {
	const resId = String(reservationId || signalId || '');
	const symbol = signalContext?.symbol || details?.symbol || 'UNKNOWN';
	const side = signalContext?.side || details?.side || 'BUY';
	const reasonStr = reason || details?.errorCode || 'BINANCE_ORDER_STATUS_UNKNOWN';

	return [
		'⚠️ *Auto\\-Trade Ambiguous Reservation*',
		`*Signal ID:* \`${escapeV2(String(signalId || resId))}\``,
		`*Symbol:* \`${escapeV2(symbol)}\` \\| *Side:* \`${escapeV2(side)}\``,
		`*Reason:* \`${escapeV2(String(reasonStr))}\``,
		`*Reservation ID:* \`${escapeV2(resId)}\``,
		'Manual reconciliation required via `POST /api/trading/binance/reconciliation/:id`',
	].join('\n');
}

async function notifyAdminOfAmbiguousReservation(payload = {}) {
	const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	if (!adminChatId) return false;

	const message = formatAmbiguousReservationMessage(payload);

	try {
		let dispatched = false;
		if (typeof botGetter === 'function') {
			try {
				const bot = botGetter();
				if (bot && bot.telegram && typeof bot.telegram.sendMessage === 'function') {
					await bot.telegram.sendMessage(adminChatId, message, { parse_mode: 'MarkdownV2' });
					dispatched = true;
				}
			} catch {
				// ignore bot lookup failure
			}
		}

		if (!dispatched) {
			const botToken = process.env.BOT_TOKEN;
			if (botToken) {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 5000);
				try {
					await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							chat_id: adminChatId,
							text: message,
							parse_mode: 'MarkdownV2',
						}),
						signal: controller.signal,
					});
					dispatched = true;
				} finally {
					clearTimeout(timeoutId);
				}
			}
		}
		return dispatched;
	} catch (error) {
		console.warn('[ambiguousReservationNotifier] failed to notify admin Telegram chat (fail-open):', error?.message || error);
		return false;
	}
}

module.exports = {
	formatAmbiguousReservationMessage,
	notifyAdminOfAmbiguousReservation,
	setBotGetter,
};
