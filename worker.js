'use strict';

require('dotenv').config();
require('./instrument.js');
const { printWarnings, validateEnv } = require('./scripts/validate-env');

printWarnings(validateEnv());

const { Telegraf } = require('telegraf');
const { initializeNotificationServices } = require('./src/controllers/webhooks/handlers/alert/alert');
const { startJobWorker } = require('./src/services/jobs/jobWorker');
const { notificationRedriveService } = require('./src/services/notification/NotificationRedriveService');
const { newsMonitorSchedulerService } = require('./src/services/newsMonitorScheduler');
const { alertSchedulerService } = require('./src/services/scheduler');
const { userPriceAlertService } = require('./src/services/alerts/UserPriceAlertService');
const sentryService = require('./src/services/monitoring/SentryService');
const { stopAllBackgroundTimers } = require('./src/lib/backgroundTimerRegistry');
const remoteConfigService = require('./src/services/remoteConfig/RemoteConfigService');
const { probeManagedPromptReadiness } = require('./src/services/prompts');

async function drainManagedTimers(timeoutMs) {
	let stats;
	try {
		stats = await stopAllBackgroundTimers({ timeoutMs });
	} catch (error) {
		console.warn('[worker] Managed timer drain failed:', error.message);
		return;
	}

	if (typeof sentryService.captureInfo === 'function') {
		try {
			await sentryService.captureInfo({
				message: 'shutdown.timer_drain',
				feature: 'shutdown.timer_drain',
				extra: stats,
			});
		} catch (error) {
			console.warn('[worker] Failed to report managed timer drain:', error.message);
		}
	}
}

function buildNotificationBot() {
	if (process.env.ENABLE_TELEGRAM_BOT !== 'true' || !process.env.BOT_TOKEN) {
		return null;
	}

	return new Telegraf(process.env.BOT_TOKEN);
}

function stopNotificationBot(bot, signal) {
	if (bot && typeof bot.stop === 'function' && (bot.polling || bot.webhookServer)) {
		bot.stop(signal);
	}
}

async function main() {
	const mode = process.env.JOB_EXECUTION_MODE;
	if (mode !== 'render-worker' && mode !== 'firestore-poller') {
		const error = new Error('The worker requires JOB_EXECUTION_MODE=render-worker or JOB_EXECUTION_MODE=firestore-poller.');
		error.code = 'JOB_WORKER_DISABLED';
		throw error;
	}

	const bot = buildNotificationBot();
	let runtime = null;
	let stopping = false;
	let backgroundWorkersStarted = false;

	const shutdown = async (signal, exitCode = 0) => {
		if (stopping) {
			return;
		}
		stopping = true;
		console.log(`[worker] ${signal} received; stopping redrive intake and draining TradingView jobs.`);
		const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 60000;
		try {
			if (backgroundWorkersStarted) {
				await notificationRedriveService.stopWorker({ drain: false });
				await newsMonitorSchedulerService.stopWorker({ drain: true, timeoutMs: shutdownTimeoutMs });
				await alertSchedulerService.stopWorker({ drain: true, timeoutMs: shutdownTimeoutMs });
				await userPriceAlertService.stopWorker({ drain: true, timeoutMs: shutdownTimeoutMs });
			}
			if (runtime && typeof runtime.stop === 'function') {
				await runtime.stop();
			}
			if (backgroundWorkersStarted) {
				await notificationRedriveService.stopWorker({ drain: true });
			}
			stopNotificationBot(bot, signal);
			remoteConfigService.stop();
			await drainManagedTimers(Math.min(2000, shutdownTimeoutMs));
			await sentryService.flush(2000);
			process.exit(exitCode);
		} catch (error) {
			console.error('[worker] Graceful shutdown failed:', error.message);
			try {
				remoteConfigService.stop();
			} catch (stopError) {
				console.warn('[worker] Remote Config stop failed:', stopError.message);
			}
			await drainManagedTimers(Math.min(2000, shutdownTimeoutMs));
			await sentryService.flush(2000);
			process.exit(1);
		}
	};

	// Install signal handlers before awaiting Remote Config or worker jitter so
	// shutdown can cancel pending startup work without waiting for its timer.
	process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
	process.once('SIGINT', () => { void shutdown('SIGINT'); });

	// Worker startup settings must be resolved only after the first published
	// Remote Config load, with start() already providing its environment fallback.
	await remoteConfigService.start();
	if (stopping) {
		return runtime;
	}

	// `newsMonitorSchedulerService` and `alertSchedulerService` below resolve prompts
	// through the same PromptService, so this process needs the same probe as the
	// web service or its /api/status verdict would stay `unverified` by design (#1178).
	void probeManagedPromptReadiness();
	await initializeNotificationServices(bot);
	if (stopping) {
		return runtime;
	}
	runtime = await startJobWorker({ botOrGetter: bot, unref: false });
	notificationRedriveService.startWorker({ source: 'worker', unref: false });
	newsMonitorSchedulerService.startWorker({ source: 'worker' });
	alertSchedulerService.botGetter = () => bot;
	alertSchedulerService.startWorker({ source: 'worker' });
	userPriceAlertService.setBotGetter(() => bot);
	userPriceAlertService.startWorker({ source: 'worker' });
	backgroundWorkersStarted = true;
	if (runtime && runtime.ready) {
		try {
			await runtime.ready;
		} catch (error) {
			await shutdown('STARTUP_FAILURE', 1);
			throw error;
		}
	}
	return runtime;
}

if (require.main === module) {
	main().catch((error) => {
		console.error('[worker] Failed to start:', error.message);
		process.exitCode = 1;
	});
}

module.exports = {
	buildNotificationBot,
	stopNotificationBot,
	main,
};
