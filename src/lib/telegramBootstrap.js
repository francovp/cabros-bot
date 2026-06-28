function getTelegramBootstrapConfig() {
	const telegramBotIsEnabled = process.env.ENABLE_TELEGRAM_BOT === 'true';
	const isPreviewEnv = process.env.RENDER === 'true' && process.env.IS_PULL_REQUEST === 'true';
	const shouldStartTelegramBot = telegramBotIsEnabled && !isPreviewEnv;
	const token = process.env.BOT_TOKEN;

	if (shouldStartTelegramBot && token === undefined) {
		throw new Error('BOT_TOKEN must be provided!');
	}

	return {
		isPreviewEnv,
		shouldStartTelegramBot,
		telegramBotIsEnabled,
		token,
	};
}

module.exports = {
	getTelegramBootstrapConfig,
};
