// Load environment variables from .env file
require('dotenv').config();
require('./instrument.js');

const {
	getPrice,
	cryptoBotCmd,
	expandedAnalysisCmd,
	marketScannerCmd,
	newsMonitorCmd,
} = require('./src/controllers/commands');
const app = require('./app.js');
const { Telegraf, Markup } = require('telegraf');
const { getRoutes } = require('./src/routes');
const { initializeNotificationServices } = require('./src/controllers/webhooks/handlers/alert/alert');
const Sentry = require('@sentry/node');

const token = process.env.BOT_TOKEN;
if (token === undefined) {
	throw new Error('BOT_TOKEN must be provided!');
}

let bot;

const port = process.env.PORT || 80;
const now = new Date();

// Always mount routes (they gate access based on feature flags)
app.use('/api', getRoutes(() => bot));

app.get('/debug-sentry', function mainHandler() {
	throw new Error('Sentry debug test error!');
});

// The error handler must be registered before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
	// The error id is attached to `res.sentry` to be returned
	// and optionally displayed to the user for support.
	res.statusCode = 500;
	res.end(res.sentry + '\n');
});

app.listen(port, async () => {
	console.log(now + ' - Running server on port ' + port);

	const telegramBotIsEnabled = process.env.ENABLE_TELEGRAM_BOT === 'true';
	console.debug('telegramBotIsEnabled:', telegramBotIsEnabled);
	const isPreviewEnv = process.env.RENDER === 'true' && process.env.IS_PULL_REQUEST === 'true';
	console.debug('isPreviewEnv:', isPreviewEnv);

	if (telegramBotIsEnabled && !isPreviewEnv) {
		console.log('Telegram Bot is enabled');
		bot = new Telegraf(token);
		bot.command(['precio'], getPrice);
		bot.command(['cryptobot'], cryptoBotCmd);
		bot.command(['analisis', 'analysis'], expandedAnalysisCmd);
		bot.command(['scanner'], marketScannerCmd);
		bot.command(['noticias', 'news'], newsMonitorCmd);

		// Initialize notification services
		await initializeNotificationServices(bot);

		// Enable graceful stop
		process.once('SIGINT', () => bot.stop('SIGINT'));
		process.once('SIGTERM', () => bot.stop('SIGTERM'));

		// Start polling without blocking the rest of bootstrap.
		void bot.launch().catch((error) => {
			console.error('[index] Failed to launch Telegram bot:', error.message);
		});

		if (process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID !== undefined) {
			console.log('Telegram Admin Notifications Chat ID:', process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID);
			let text, commitHash, gitCommitUrl;
			if (process.env.RENDER) {
				commitHash = process.env.RENDER_GIT_COMMIT.substring(0, 6);
				gitCommitUrl = `https://github.com/${process.env.RENDER_GIT_REPO_SLUG}/commit/${commitHash}`;
				console.log(`Telegram bot deployed from commit ${gitCommitUrl} is running`);
				text = `*Telegram bot deployed from commit [${commitHash}](${gitCommitUrl}) is running*`;
				await bot.telegram.sendMessage(
					process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID, text, { parse_mode: 'MarkdownV2' },
				);
			}
		}
	} else {
		console.log('Telegram Bot is disabled');
		// Initialize notification services
		await initializeNotificationServices(null);
	}
});

module.exports = { bot };
