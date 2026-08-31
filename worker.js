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
const sentryService = require('./src/services/monitoring/SentryService');
const remoteConfigService = require('./src/services/remoteConfig/RemoteConfigService');

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

	void remoteConfigService.start();
	if (typeof remoteConfigService.applyRuntimeConfig === 'function') {
		remoteConfigService.applyRuntimeConfig();
	}
	const bot = buildNotificationBot();
	await initializeNotificationServices(bot);
	const runtime = await startJobWorker({ botOrGetter: bot });
	notificationRedriveService.startWorker({ source: 'worker', unref: false });
	newsMonitorSchedulerService.startWorker({ source: 'worker' });
	let stopping = false;

	const shutdown = async (signal) => {
		if (stopping) {
			return;
		}
		stopping = true;
		console.log(`[worker] ${signal} received; stopping redrive intake and draining TradingView jobs.`);
		const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 60000;
		try {
			await notificationRedriveService.stopWorker({ drain: false });
			await newsMonitorSchedulerService.stopWorker({ drain: true, timeoutMs: shutdownTimeoutMs });
			await runtime.stop();
			await notificationRedriveService.stopWorker({ drain: true });
			stopNotificationBot(bot, signal);
			remoteConfigService.stop();
			await sentryService.flush(2000);
			process.exit(0);
		} catch (error) {
			console.error('[worker] Graceful shutdown failed:', error.message);
			remoteConfigService.stop();
			await sentryService.flush(2000);
			process.exit(1);
		}
	};

	process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
	process.once('SIGINT', () => { void shutdown('SIGINT'); });
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
