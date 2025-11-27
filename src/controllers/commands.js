const { fetchSymbolPrice } = require('./commands/handlers/core/fetchPriceCryptoSymbol');
const sentryService = require('../services/monitoring/SentryService');

const getPrice = (context) => {
	fetchSymbolPrice(context).then((result) => {
		context.reply(`Precio de ${result.symbol} es ${result.price}`);
	}).catch((error) => {
		console.log(error);
		// Capture Telegram command errors to Sentry (T015)
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: {
				command: 'getPrice',
				chatId: context.update && context.update.message && context.update.message.chat && context.update.message.chat.id,
			},
		});
	});
};

const cryptoBotCmd = (context) => {
	try {
		const messageSplited = context.message.text.split(' ');
		const cmd = messageSplited[1];
		switch (cmd) {
		case 'id':
			context.reply(`Chat Id: ${context.update.message.chat.id}`);
			break;
		default:
			// Nothing
		}
	} catch (error) {
		console.log(error);
		// Capture Telegram command errors to Sentry (T015)
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: {
				command: 'cryptoBotCmd',
				chatId: context.update && context.update.message && context.update.message.chat && context.update.message.chat.id,
			},
		});
	}
};

module.exports = { getPrice, cryptoBotCmd };
