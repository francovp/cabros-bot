// Load environment variables from .env file
require('dotenv').config();
require('./instrument.js');

const {
	getPrice,
	cryptoBotCmd,
	expandedAnalysisCmd,
	marketScannerCmd,
	jobsCommand,
	newsMonitorCmd,
	helpCmd,
	outcomesCommand,
} = require('./src/controllers/commands');
const app = require('./app.js');
const { Telegraf, Markup } = require('telegraf');
const { getRoutes } = require('./src/routes');
const { initializeNotificationServices } = require('./src/controllers/webhooks/handlers/alert/alert');
const { getNewsMonitor } = require('./src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const { getCacheInstance } = require('./src/controllers/webhooks/handlers/newsMonitor/cache');
const { registerDebugSentryRoute } = require('./src/lib/debugSentryRoute');
const { createProcessLifecycle } = require('./src/lib/processLifecycle');
const { waitForBackgroundTasks } = require('./src/lib/backgroundTaskTracker');
const { getTelegramBootstrapConfig } = require('./src/lib/telegramBootstrap');
const { attachTelegramErrorBoundary, handlePollingError } = require('./src/lib/telegramErrorBoundary');
const { jobService } = require('./src/services/jobs/JobService');
const SignalOutcomeService = require('./src/services/storage/SignalOutcomeService');
const { notificationRedriveService } = require('./src/services/notification/NotificationRedriveService');
const { whatsAppCommandBridgeService } = require('./src/services/notification/WhatsAppCommandBridgeService');
const { scannerPresetSchedulerService } = require('./src/services/scannerPresets');
const sentryService = require('./src/services/monitoring/SentryService');
const { getDeploymentCommit, getDeploymentRepoSlug } = require('./src/lib/deploymentEnvironment');
const remoteConfigService = require('./src/services/remoteConfig/RemoteConfigService');
const Sentry = require('@sentry/node');

const { token } = getTelegramBootstrapConfig();

let bot;
let botLaunchPromise;
let bootstrapPromise;
let server;

const port = process.env.PORT || 80;
const now = new Date();

// Always mount routes (they gate access based on feature flags)
app.use('/api', getRoutes(() => bot));

// Register Sentry debug routes if enabled
registerDebugSentryRoute(app);

// The error handler must be registered before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
	// The error id is attached to `res.sentry` to be returned
	// and optionally displayed to the user for support.
	res.statusCode = 500;
	res.end(res.sentry + '\n');
});

const lifecycle = createProcessLifecycle({
	getServer: () => server,
	getBot: () => bot,
	getBotLaunchPromise: () => botLaunchPromise,
	getBootstrapPromise: () => bootstrapPromise,
	waitForBackgroundJobs: () => jobService.waitForActiveJobs(),
	waitForBackgroundTasks,
	finalizeBackgroundJobs: () => jobService.finalizeActiveJobsForShutdown(),
	stopSignalOutcomeWorker: (options) => SignalOutcomeService.stopWorker(options),
	stopNotificationRedriveWorker: (options) => notificationRedriveService.stopWorker(options),
	stopWhatsAppCommandBridge: (options) => whatsAppCommandBridgeService.stop(options),
	stopScannerPresetScheduler: (options) => scannerPresetSchedulerService.stopWorker(options),
	stopRemoteConfig: () => remoteConfigService.stop(),
	shutdownNewsMonitor: () => getCacheInstance().shutdown(),
	flushSentry: (timeout) => sentryService.flush(timeout),
	timeoutMs: process.env.SHUTDOWN_TIMEOUT_MS,
});
lifecycle.register();

async function bootstrapApplication() {
	console.log(now + ' - Running server on port ' + port);
	if (lifecycle.isShuttingDown()) return;

	void remoteConfigService.start();

	// Start background signal outcome evaluation worker if enabled
	SignalOutcomeService.startWorker();
	// Start background notification redrive worker if enabled
	notificationRedriveService.startWorker();
	// Start background scanner preset scheduler if enabled
	scannerPresetSchedulerService.botGetter = () => bot;
	scannerPresetSchedulerService.startWorker();
	// Start WhatsApp inbound command bridge if enabled
	if (whatsAppCommandBridgeService.isEnabled()) {
		whatsAppCommandBridgeService.start();
	}
	if (process.env.ENABLE_NEWS_MONITOR === 'true') {
		getNewsMonitor().initialize();
	}

	const { telegramBotIsEnabled, isPreviewEnv, shouldStartTelegramBot } = getTelegramBootstrapConfig();
	console.debug('telegramBotIsEnabled:', telegramBotIsEnabled);
	console.debug('isPreviewEnv:', isPreviewEnv);

	if (shouldStartTelegramBot) {
		console.log('Telegram Bot is enabled');
		bot = new Telegraf(token);
		bot.command(['precio'], getPrice);
		bot.command(['cryptobot'], cryptoBotCmd);
		bot.command(['analisis', 'analysis'], expandedAnalysisCmd);
		bot.command(['scanner'], marketScannerCmd);
		bot.command(['jobs', 'trabajos'], jobsCommand);
		bot.command(['noticias', 'news'], newsMonitorCmd);
		bot.command(['outcomes', 'rendimiento'], outcomesCommand);
		bot.command(['help', 'start'], helpCmd);

		// Attach Telegram error boundary
		attachTelegramErrorBoundary(bot);

		// Initialize notification services
		await initializeNotificationServices(bot);
		if (lifecycle.isShuttingDown()) return;

		// Start polling without blocking the rest of bootstrap.
		botLaunchPromise = bot.launch();
		void botLaunchPromise.catch((error) => {
			console.error('[index] Failed to launch Telegram bot:', error.message);
			void handlePollingError(error, { bot });
		});

		if (!lifecycle.isShuttingDown() && process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID !== undefined) {
			console.log('Telegram Admin Notifications Chat ID:', process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID);
			let text, commitHash, gitCommitUrl;
			const deploymentCommit = getDeploymentCommit();
			if ((process.env.RENDER || process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT_NAME) && deploymentCommit) {
				commitHash = deploymentCommit.substring(0, 6);
				gitCommitUrl = `https://github.com/${getDeploymentRepoSlug()}/commit/${commitHash}`;
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
}

server = app.listen(port, () => {
	bootstrapPromise = bootstrapApplication();
	void bootstrapPromise.catch((error) => {
		console.error('[index] Application bootstrap failed:', error.message);
	});
});

module.exports = { bot };
