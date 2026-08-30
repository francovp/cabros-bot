'use strict';

const {
	userPriceAlertService,
	UserPriceAlertError,
	parseUserPriceAlertInput,
} = require('../../../../services/alerts/UserPriceAlertService');
const fetchPriceModule = require('./fetchPriceCryptoSymbol');
const sentryService = require('../../../../services/monitoring/SentryService');

function escapeMarkdownV2(text) {
	return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function getChatId(context) {
	return context.update && context.update.message && context.update.message.chat && context.update.message.chat.id;
}

function getMessageThreadId(context) {
	return (
		context.message?.message_thread_id ||
		context.update?.message?.message_thread_id ||
		undefined
	);
}

function buildAlertHelpMessage() {
	return [
		'*🔔 Alertas de Precio Personalizadas*',
		'',
		'Crea alertas para recibir una notificación cuando un activo cruce un precio objetivo\\.',
		'',
		'*Comandos:*',
		'• `/alerta <simbolo> <operador> <precio>` — Crea una alerta de precio',
		'  _Ejemplos: `/alerta BTCUSDT < 60000`, `/alerta ETHUSDT > 3500`, `/alerta NVDA > 140`_',
		'• `/alerta list` — Lista tus alertas activas \\(alias: `/alerta lista`\\)',
		'• `/alerta cancel <id>` — Cancela una alerta \\(alias: `/alerta borrar <id>`\\)',
		'• `/alerta help` — Muestra esta guía de uso',
	].join('\n');
}

const userPriceAlertCmd = async (context) => {
	const chatId = getChatId(context);
	const threadId = getMessageThreadId(context);
	const text = (context.message && context.message.text) || '';
	const [, ...tokens] = text.trim().split(/\s+/).filter(Boolean);

	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.alerta',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/alerta',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
			'query.tokens_count': tokens.length,
		},
	});

	const replyOptions = { parse_mode: 'MarkdownV2' };
	if (threadId !== undefined) {
		replyOptions.message_thread_id = threadId;
	}

	try {
		// 1. Help subcommand or no args
		if (tokens.length === 0 || tokens[0].toLowerCase() === 'help' || tokens[0].toLowerCase() === 'ayuda') {
			await context.reply(buildAlertHelpMessage(), replyOptions);
			return;
		}

		const subCommand = tokens[0].toLowerCase();

		// 2. List subcommand
		if (subCommand === 'list' || subCommand === 'lista' || subCommand === 'listar') {
			const alerts = await userPriceAlertService.listAlerts({ chatId: String(chatId), status: 'armed' });
			if (alerts.length === 0) {
				await context.reply(
					'No tienes alertas de precio activas\\. Crea una con `/alerta BTCUSDT < 60000`',
					replyOptions,
				);
				return;
			}

			const lines = [
				'*🔔 Tus Alertas de Precio Activas:*',
				'',
			];
			alerts.forEach((alert) => {
				const cond = `${alert.operator} ${Number(alert.targetPrice).toLocaleString('en-US')}`;
				lines.push(`• \`${alert.id}\` — \`${alert.symbol} ${cond}\``);
			});
			lines.push('');
			lines.push('Para cancelar una alerta usa: `/alerta cancel <ID>`');

			await context.reply(lines.join('\n'), replyOptions);
			return;
		}

		// 3. Cancel subcommand
		if (subCommand === 'cancel' || subCommand === 'cancelar' || subCommand === 'borrar' || subCommand === 'delete' || subCommand === 'del') {
			const alertId = tokens[1];
			if (!alertId) {
				await context.reply(
					'Por favor indica el ID de la alerta a cancelar\\. Ejemplo: `/alerta cancel alert_12345678`',
					replyOptions,
				);
				return;
			}

			const cancelled = await userPriceAlertService.cancelAlert({ chatId: String(chatId), alertId });
			const cond = `${cancelled.operator} ${Number(cancelled.targetPrice).toLocaleString('en-US')}`;
			await context.reply(
				`✅ Alerta cancelada exitosamente: \`${cancelled.id}\` \\(\`${cancelled.symbol} ${cond}\`\\)`,
				replyOptions,
			);
			return;
		}

		// 4. Create alert
		const classification = fetchPriceModule.classifyPriceQuery(tokens[0]);
		if (!classification.valid || classification.assetClass === 'unsupported') {
			const reason = classification.reason ? `${classification.reason}.` : 'Símbolo no válido.';
			await context.reply(
				`${escapeMarkdownV2(reason)} Ejemplo: \`/alerta BTCUSDT < 60000\` o \`/alerta NVDA > 140\``,
				replyOptions,
			);
			return;
		}

		// Fetch current price
		let currentQuote;
		try {
			if (classification.assetClass === 'equity') {
				currentQuote = await fetchPriceModule.fetchEquityPrice(classification.symbol, classification.exchange);
			} else {
				currentQuote = await fetchPriceModule.fetchCryptoPrice(classification.symbol);
			}
		} catch (fetchErr) {
			await context.reply(
				`No se pudo obtener el precio actual para \`${escapeMarkdownV2(classification.symbol)}\`: ${escapeMarkdownV2(fetchErr.message || 'Error de conexión')}`,
				replyOptions,
			);
			return;
		}

		const currentPrice = currentQuote.price;
		const parsed = parseUserPriceAlertInput(tokens, { currentPrice });
		if (!parsed.valid) {
			await context.reply(
				'Formato incorrecto\\. Ejemplo: `/alerta BTCUSDT < 60000`, `/alerta ETHUSDT > 3500`, `/alerta NVDA > 140`',
				replyOptions,
			);
			return;
		}

		const alert = await userPriceAlertService.createAlert({
			chatId: String(chatId),
			telegramThreadId: threadId,
			symbol: classification.symbol,
			rawSymbol: tokens[0],
			exchange: classification.exchange,
			assetClass: classification.assetClass,
			operator: parsed.operator,
			targetPrice: parsed.targetPrice,
			initialPrice: currentPrice,
			userId: context.from?.id,
		});

		const condText = `${alert.operator} ${Number(alert.targetPrice).toLocaleString('en-US')}`;
		const currentPriceText = currentPrice.toLocaleString('en-US');

		const messageLines = [
			'✅ *Alerta de precio creada*',
			'',
			`• Símbolo: \`${alert.symbol}\``,
			`• Condición: \`${condText}\``,
			`• Precio actual: *${escapeMarkdownV2(currentPriceText)}*`,
			`• ID: \`${alert.id}\``,
			'',
			'_Te avisaremos automáticamente cuando se alcance el objetivo\\._',
		];

		await context.reply(messageLines.join('\n'), replyOptions);
	} catch (error) {
		console.error('[userPriceAlertCmd] Error:', error);
		if (error instanceof UserPriceAlertError || error.isUserFriendly) {
			await context.reply(
				`⚠️ ${escapeMarkdownV2(error.message)}`,
				replyOptions,
			);
		} else {
			sentryService.captureRuntimeError({
				channel: 'telegram',
				error,
				extra: {
					command: 'userPriceAlertCmd',
					chatId,
					tokens,
				},
			});
			await context.reply(
				'Ocurrió un error al procesar tu alerta de precio\\. Intenta nuevamente más tarde\\.',
				replyOptions,
			);
		}
	} finally {
		sentryService.endSpan(commandSpan);
	}
};

module.exports = {
	userPriceAlertCmd,
	buildAlertHelpMessage,
};
