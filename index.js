// Load environment variables from .env file
require('dotenv').config();
require('./instrument.js');
const { printWarnings, validateEnv } = require('./scripts/validate-env');

printWarnings(validateEnv());

const {
	getPrice,
	cryptoBotCmd,
	expandedAnalysisCmd,
	marketScannerCmd,
	jobsCommand,
	newsMonitorCmd,
	helpCmd,
	demoCmd,
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
const { getTelegramBootstrapConfig, sendStartupDeploymentNotification } = require('./src/lib/telegramBootstrap');
const bootstrapReadiness = require('./src/lib/bootstrapReadiness');
const { launchTelegramBot } = require('./src/lib/telegramCommandMenu');
const { attachTelegramErrorBoundary, handlePollingError } = require('./src/lib/telegramErrorBoundary');
const { jobService } = require('./src/services/jobs/JobService');
const SignalOutcomeService = require('./src/services/storage/SignalOutcomeService');
const { notificationRedriveService } = require('./src/services/notification/NotificationRedriveService');
const { whatsAppCommandBridgeService } = require('./src/services/notification/WhatsAppCommandBridgeService');
const { scannerPresetSchedulerService } = require('./src/services/scannerPresets');
const { newsMonitorSchedulerService } = require('./src/services/newsMonitorScheduler');
const sentryService = require('./src/services/monitoring/SentryService');
const remoteConfigService = require('./src/services/remoteConfig/RemoteConfigService');
const Sentry = require('@sentry/node');

const { token, shouldStartTelegramBot } = getTelegramBootstrapConfig();
bootstrapReadiness.begin({
	telegramRequired: shouldStartTelegramBot,
	newsMonitorRequired: process.env.ENABLE_NEWS_MONITOR === 'true',
});

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
	stopNewsMonitorScheduler: (options) => newsMonitorSchedulerService.stopWorker(options),
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
	// Start background news-monitor scheduler if enabled
	newsMonitorSchedulerService.startWorker({ source: 'web' });
	// Start WhatsApp inbound command bridge if enabled
	if (whatsAppCommandBridgeService.isEnabled()) {
		whatsAppCommandBridgeService.start();
	}
	if (process.env.ENABLE_NEWS_MONITOR === 'true') {
		getNewsMonitor().initialize();
		bootstrapReadiness.markReady('newsMonitor');
	}

	const { telegramBotIsEnabled, isPreviewEnv, shouldStartTelegramBot: shouldLaunchTelegramBot } = getTelegramBootstrapConfig();
	console.debug('telegramBotIsEnabled:', telegramBotIsEnabled);
	console.debug('isPreviewEnv:', isPreviewEnv);

	if (shouldLaunchTelegramBot) {
		console.log('Telegram Bot is enabled');
		bot = new Telegraf(token);
		bot.command(['precio'], getPrice);
		bot.command(['cryptobot'], cryptoBotCmd);
		bot.command(['analisis', 'analysis'], expandedAnalysisCmd);
		bot.command(['scanner'], marketScannerCmd);
		bot.command(['jobs', 'trabajos'], jobsCommand);
		bot.command(['noticias', 'news'], newsMonitorCmd);
		bot.command(['outcomes', 'rendimiento'], outcomesCommand);
		bot.command(['demo'], demoCmd);
		bot.command(['help', 'start'], helpCmd);

		// Attach Telegram error boundary
		attachTelegramErrorBoundary(bot);

		// Initialize notification services
		await initializeNotificationServices(bot);
		bootstrapReadiness.markReady('notificationServices');
		if (lifecycle.isShuttingDown()) return;

		// Start polling without blocking the rest of bootstrap.
		botLaunchPromise = launchTelegramBot(bot, (error) => {
			console.error('[index] Failed to launch Telegram bot:', error.message);
			void handlePollingError(error, { bot });
		}, () => bootstrapReadiness.markReady('telegramBot'));
		void botLaunchPromise.catch((error) => bootstrapReadiness.markFailed('telegramBot', error));

		if (!lifecycle.isShuttingDown()) {
			await sendStartupDeploymentNotification({
				bot,
				timeoutMs: 10000,
				logger: console,
				sentry: sentryService,
			});
		}
	} else {
		console.log('Telegram Bot is disabled');
		// Initialize notification services
		await initializeNotificationServices(null);
		bootstrapReadiness.markReady('notificationServices');
	}
}

server = app.listen(port, () => {
	bootstrapPromise = bootstrapApplication();
	void bootstrapPromise.catch((error) => {
		bootstrapReadiness.fail(error);
		console.error('[index] Application bootstrap failed:', error.message);
	});
});

module.exports = { bot };
