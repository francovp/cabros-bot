const TELEGRAM_COMMAND_MENU = Object.freeze([
	{ command: 'precio', description: 'Consulta el precio en Binance o Twelve Data' },
	{ command: 'cryptobot', description: 'Muestra el Chat ID actual de Telegram' },
	{ command: 'analisis', description: 'Crea un análisis técnico en TradingView' },
	{ command: 'scanner', description: 'Escaneo de mercado en TradingView' },
	{ command: 'noticias', description: 'Monitor y análisis de noticias con IA' },
	{ command: 'outcomes', description: 'Rendimiento reciente de señales evaluadas' },
	{ command: 'history', description: 'Consulta alertas recientes' },
	{ command: 'help', description: 'Muestra este mensaje de ayuda' },
	{ command: 'start', description: 'Muestra este mensaje de ayuda' },
]);

function getTelegramCommandMenu() {
	return TELEGRAM_COMMAND_MENU.map((command) => ({ ...command }));
}

async function registerTelegramCommandMenu(telegram) {
	try {
		await telegram.setMyCommands(getTelegramCommandMenu());
	} catch (error) {
		console.warn('[telegram] Failed to register command menu:', error.message);
	}
}

function launchTelegramBot(bot, onLaunchError, onLaunch) {
	const launchPromise = bot.launch(() => {
		void registerTelegramCommandMenu(bot.telegram);
		onLaunch?.();
	});
	void launchPromise.catch(onLaunchError);
	return launchPromise;
}

module.exports = {
	getTelegramCommandMenu,
	launchTelegramBot,
	registerTelegramCommandMenu,
};
