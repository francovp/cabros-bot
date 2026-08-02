'use strict';

require('dotenv').config();

const { Telegraf } = require('telegraf');
const { initializeNotificationServices } = require('./src/controllers/webhooks/handlers/alert/alert');
const { startJobWorker } = require('./src/services/jobs/jobWorker');

function buildNotificationBot() {
	if (process.env.ENABLE_TELEGRAM_BOT !== 'true' || !process.env.BOT_TOKEN) {
		return null;
	}

	return new Telegraf(process.env.BOT_TOKEN);
}

async function main() {
	if (process.env.JOB_EXECUTION_MODE !== 'render-worker') {
		const error = new Error('The worker requires JOB_EXECUTION_MODE=render-worker.');
		error.code = 'JOB_WORKER_DISABLED';
		throw error;
	}

	const bot = buildNotificationBot();
	await initializeNotificationServices(bot);
	const runtime = await startJobWorker({ botOrGetter: bot });
	let stopping = false;

	const shutdown = async (signal) => {
		if (stopping) {
			return;
		}
		stopping = true;
		console.log(`[worker] ${signal} received; draining TradingView jobs.`);
		try {
			await runtime.stop();
			if (bot && typeof bot.stop === 'function') {
				bot.stop(signal);
			}
			process.exit(0);
		} catch (error) {
			console.error('[worker] Graceful shutdown failed:', error.message);
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
	main,
};
