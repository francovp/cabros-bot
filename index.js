// Load environment variables from .env file
require('dotenv').config();
require('./instrument.js');
const { printWarnings, validateEnv } = require('./scripts/validate-env');

printWarnings(validateEnv());

const {
	getPrice,
	userPriceAlertCmd,
	cryptoBotCmd,
	expandedAnalysisCmd,
	marketScannerCmd,
	jobsCommand,
	newsMonitorCmd,
	helpCmd,
	outcomesCommand,
	preferenciasCmd,
	filtroCmd,
	silencioCmd,
	umbralCmd,
	categoriasCmd,
	telegramCommandRateLimiter,
} = require('./src/controllers/commands');
const app = require('./app.js');
const { Telegraf, Markup } = require('telegraf');
const { getRoutes } = require('./src/routes');
const { initializeNotificationServices } = require('./src/controllers/webhooks/handlers/alert/alert');
const { getNewsMonitor } = require('./src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const { getCacheInstance } = require('./src/controllers/webhooks/handlers/newsMonitor/cache');
const { registerDebugSentryRoute } = require('./src/lib/debugSentryRoute');
const { telegramMaintenanceMode } = require('./src/lib/maintenanceMode');
const { createProcessLifecycle } = require('./src/lib/processLifecycle');
const { waitForBackgroundTasks } = require('./src/lib/backgroundTaskTracker');
const { getTelegramBootstrapConfig, sendStartupDeploymentNotification } = require('./src/lib/telegramBootstrap');
const bootstrapReadiness = require('./src/lib/bootstrapReadiness');
const { attachReadinessOverrides } = require('./src/controllers/readiness');
const { launchTelegramBot } = require('./src/lib/telegramCommandMenu');
const { attachTelegramErrorBoundary, handlePollingError, startTelegramHealthProbe, stopTelegramHealthProbe } = require('./src/lib/telegramErrorBoundary');
const { registerAlertActionHandlers } = require('./src/lib/telegramAlertActions');
const { registerAuthMiddleware: registerTelegramCommandAuth } = require('./src/lib/telegramCommandAuth');
const { jobService } = require('./src/services/jobs/JobService');
const { jobBacklogService } = require('./src/services/jobs/JobBacklogService');
const { jobQueue } = require('./src/services/jobs/JobQueue');
const SignalOutcomeService = require('./src/services/storage/SignalOutcomeService');
const { notificationRedriveService } = require('./src/services/notification/NotificationRedriveService');
const { whatsAppCommandBridgeService } = require('./src/services/notification/WhatsAppCommandBridgeService');
const { scannerPresetSchedulerService } = require('./src/services/scannerPresets');
const { userPriceAlertService } = require('./src/services/alerts/UserPriceAlertService');
const { newsMonitorSchedulerService } = require('./src/services/newsMonitorScheduler');
const { alertSchedulerService } = require('./src/services/scheduler');
const { adminSseService } = require('./src/services/sse/AdminSseService');
const sentryService = require('./src/services/monitoring/SentryService');
const remoteConfigService = require('./src/services/remoteConfig/RemoteConfigService');
const { probeManagedPromptReadiness } = require('./src/services/prompts');
const { configureServerTimeouts } = require('./src/lib/serverTimeouts');
const Sentry = require('@sentry/node');

const { token, shouldStartTelegramBot } = getTelegramBootstrapConfig();
bootstrapReadiness.begin({
	telegramRequired: shouldStartTelegramBot,
	newsMonitorRequired: process.env.ENABLE_NEWS_MONITOR === 'true',
});

let bot;
let botLaunchPromise;
let bootstrapPromise;


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
	stopJobBacklogMonitor: (options) => jobBacklogService.stop(options),
	stopUserPriceAlertWorker: (options) => userPriceAlertService.stopWorker(options),
	stopNewsMonitorScheduler: (options) => newsMonitorSchedulerService.stopWorker(options),
	stopAlertScheduler: (options) => alertSchedulerService.stopWorker(options),
	stopRemoteConfig: () => remoteConfigService.stop(),
	closeAllSseConnections: () => adminSseService.closeAll(),
	stopTelegramHealthProbe: () => stopTelegramHealthProbe(),
	shutdownNewsMonitor: () => getCacheInstance().shutdown(),
	flushSentry: (timeout) => sentryService.flush(timeout),
	timeoutMs: process.env.SHUTDOWN_TIMEOUT_MS,
});
lifecycle.register();

async function bootstrapApplication() {
	console.log(now + ' - Running server on port ' + port);
	if (lifecycle.isShuttingDown()) return;

	void remoteConfigService.start();

	// Proven, bounded and detached: `dependencies.langfuse.ready` on /api/status
	// needs one observed resolution to flip to true, and without this an idle
	// deployment could not tell working prompts from a valid-credential /
	// unpublished-label pair that falls back to the local file forever (#1178).
	void probeManagedPromptReadiness();

	// Start background signal outcome evaluation worker if enabled
	SignalOutcomeService.startWorker();
	// Start background notification redrive worker if enabled
	notificationRedriveService.startWorker();
	// Start background scanner preset scheduler if enabled
	scannerPresetSchedulerService.botGetter = () => bot;
	scannerPresetSchedulerService.startWorker();
	// Start background job backlog monitor if enabled
	jobBacklogService.startMonitor();
	// Prove broker connectivity at boot so /api/capabilities reports a real queue
	// verdict on an idle deployment. Without this, readiness only ever became true
	// as a side effect of the first enqueue, so a correct render-worker cut-over
	// read as "not_started" and an operator could not tell it apart from a broker
	// that was configured but unreachable.
	void jobQueue.probeBrokerReadiness().then((result) => {
		if (result.skipped) {
			return;
		}
		console.log(
			`Job queue broker ${result.reachable ? 'reachable' : 'UNREACHABLE'}` +
			(result.reachable ? '' : ` (lastErrorCode=${result.errorCode})`),
		);
	});
	// Start background user price alert worker if enabled
	userPriceAlertService.setBotGetter(() => bot);
	userPriceAlertService.startWorker({ source: 'web' });
	// Start background news-monitor scheduler if enabled
	newsMonitorSchedulerService.startWorker({ source: 'web' });
	// Start background alert scheduler (JSON-defined news + scanner schedules) if enabled
	alertSchedulerService.botGetter = () => bot;
	alertSchedulerService.startWorker({ source: 'web' });
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
		// Give the readiness probe a live handle on the bot so its Telegram check
		// performs a real getMe round-trip instead of reporting a permanent
		// `telegram_bot_unavailable`. Registered before the probe can ever run.
		attachReadinessOverrides(app, {
			getBot: () => bot,
			isBotEnabled: () => Boolean(bot) && !lifecycle.isShuttingDown(),
		});
		bot.use(telegramMaintenanceMode);
		registerTelegramCommandAuth(bot);
		bot.use(telegramCommandRateLimiter);
		bot.command(['precio'], getPrice);
		bot.command(['alerta', 'alert'], userPriceAlertCmd);
		bot.command(['cryptobot'], cryptoBotCmd);
		bot.command(['analisis', 'analysis'], expandedAnalysisCmd);
		bot.command(['scanner'], marketScannerCmd);
		bot.command(['jobs', 'trabajos'], jobsCommand);
		bot.command(['noticias', 'news'], newsMonitorCmd);
		bot.command(['outcomes', 'rendimiento'], outcomesCommand);
		bot.command(['preferencias', 'preferences'], preferenciasCmd);
		bot.command(['filtro', 'filter'], filtroCmd);
		bot.command(['silencio', 'quiet'], silencioCmd);
		bot.command(['umbral', 'threshold'], umbralCmd);
		bot.command(['categorias', 'categories'], categoriasCmd);
		bot.command(['help', 'start'], helpCmd);

		// Register inline keyboard action handlers for Telegram alerts.
		registerAlertActionHandlers(bot);

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

		// Telegraf v4 has no polling-success event, so without an external
		// signal the consecutive-failures counter is monotonic for the
		// process lifetime. A periodic getMe probe (default 30s) lets
		// recordPollingSuccess() reset the streak on a healthy round-trip.
		startTelegramHealthProbe(bot);

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

const server = app.listen(port, () => {
	bootstrapPromise = bootstrapApplication();
	void bootstrapPromise.catch((error) => {
		bootstrapReadiness.fail(error);
		console.error('[index] Application bootstrap failed:', error.message);
	});
});

// Bound slow clients before the 'listening' event, not inside the listen callback:
// the server already accepts connections by then, which would leave a window where
// headersTimeout/requestTimeout are still Node's unbounded defaults.
configureServerTimeouts(server);

module.exports = { bot };
