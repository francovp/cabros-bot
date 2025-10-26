const { fetchSymbolPrice } = require('./commands/handlers/core/fetchPriceCryptoSymbol');

const getPrice = (context) => {
	fetchSymbolPrice(context).then((result) => {
		context.reply(`Precio de ${result.symbol} es ${result.price}`);
	}).catch((error) => {
		console.log(error);
	});
};

const cryptoBotCmd = (context) => {
	const messageSplited = context.message.text.split(' ');
	const cmd = messageSplited[1];
	switch (cmd) {
	case 'id':
		context.reply(`Chat Id: ${context.update.message.chat.id}`);
		break;
	default:
		// Nothing
	}
};

module.exports = { getPrice, cryptoBotCmd };
