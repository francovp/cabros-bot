require('dotenv').config();

const chatId = process.env.TELEGRAM_CHAT_ID;

function postAlert(bot) {
	return async (req, res) => {
		const { body } = req;
		try {
			let text = '';
			if (typeof body === 'object' && 'text' in body) {
                console.debug("webhook/alert handler: body is an object", text);
				text = body.text;
			} else {
                console.debug("webhook/alert handler: body is text", text);
				text = body;
			}
			if (bot !== undefined) {
				console.debug('Sending message to telegram chat ID: ' + chatId);
				await bot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
			} else {
                console.debug("Bot is undefined");
            }
			res.sendStatus(200);
		} catch (error) {
			console.debug('webhook/alert handler: Error sending message to bot');
			console.error(`webhook/alert handler: ${error}`);
			res.status(error.response.error_code).send(error.response);
		}
	};
}

module.exports = {
	postAlert,
};
