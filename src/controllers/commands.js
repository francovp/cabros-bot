const { fetchSymbolPrice } = require('./commands/handlers/core/fetchPriceCryptoSymbol');
const sentryService = require('../services/monitoring/SentryService');

const getPrice = async (context) => {
	const chatId = context.update && context.update.message && context.update.message.chat && context.update.message.chat.id;
	const messageSplited = context.message.text.split(' ');
	const symbol = messageSplited[1] || '';

	return sentryService.withSpan(
		{
			name: 'telegram.command.precio',
			op: 'bot.command',
			forceTransaction: true,
			attributes: {
				'telegram.command': '/precio',
				'telegram.chat_id': chatId ? String(chatId) : 'unknown',
				'crypto.symbol': symbol || 'missing',
			},
		},
		async () => {
			try {
				const result = await fetchSymbolPrice(context);
				await context.reply(`Precio de ${result.symbol} es ${result.price}`);
			} catch (error) {
				console.error(error);
				// Capture Telegram command errors to Sentry (T015)
				sentryService.captureRuntimeError({
					channel: 'telegram',
					error,
					extra: {
						command: 'getPrice',
						chatId,
						symbol,
					},
				});
			}
		},
	);
};

const cryptoBotCmd = (context) => {
	const chatId = context.update && context.update.message && context.update.message.chat && context.update.message.chat.id;

	return sentryService.withSpan(
		{
			name: 'telegram.command.cryptobot',
			op: 'bot.command',
			forceTransaction: true,
			attributes: {
				'telegram.command': '/cryptobot',
				'telegram.chat_id': chatId ? String(chatId) : 'unknown',
			},
		},
		() => {
			try {
				const messageSplited = context.message.text.split(' ');
				const cmd = messageSplited[1];
				switch (cmd) {
				case 'id':
					context.reply(`Chat Id: ${chatId}`);
					break;
				default:
					// Nothing
				}
			} catch (error) {
				console.error(error);
				// Capture Telegram command errors to Sentry (T015)
				sentryService.captureRuntimeError({
					channel: 'telegram',
					error,
					extra: {
						command: 'cryptoBotCmd',
						chatId,
					},
				});
			}
		},
	);
};

module.exports = { getPrice, cryptoBotCmd };
