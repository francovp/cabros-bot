'use strict';

require('dotenv').config();
require('../../instrument.js');
const { printWarnings, validateEnv } = require('../../scripts/validate-env');
const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');

printWarnings(validateEnv());

const SignalOutcomeService = require('../services/storage/SignalOutcomeService');
const sentryService = require('../services/monitoring/SentryService');

async function main() {
	let keepAlive = null;
	let shutdownPromise = null;
	let stopping = false;
	let workerStartAttempted = false;

	const shutdown = (signal) => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		stopping = true;
		console.log(`[SignalOutcomeWorker] Received ${signal}; draining active sweep.`);
		const drainPromise = workerStartAttempted
			? Promise.resolve(SignalOutcomeService.stopWorker({ drain: true }))
			: Promise.resolve();
		shutdownPromise = drainPromise
			.catch((error) => {
				console.error('[SignalOutcomeWorker] Failed to drain active sweep:', error.message);
			})
			.finally(() => {
				if (keepAlive) {
					clearInterval(keepAlive);
				}
				remoteConfigService.stop();
				return sentryService.flush(2000);
			})
			.catch((error) => {
				console.error('[SignalOutcomeWorker] Failed to flush monitoring:', error.message);
			})
			.finally(() => {
				process.exit(0);
			});

		return shutdownPromise;
	};

	// Install handlers before Remote Config startup, which may wait for startup jitter.
	process.once('SIGINT', () => { void shutdown('SIGINT'); });
	process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

	try {
		await remoteConfigService.start();
	} catch (error) {
		console.warn('[SignalOutcomeWorker] Remote Config failed to start; continuing with environment/default values:', error.message);
	}
	if (stopping) {
		return;
	}

	const status = SignalOutcomeService.getWorkerStatus();
	if (status.role !== 'worker') {
		console.error(`[SignalOutcomeWorker] Refusing to start with SIGNAL_OUTCOME_WORKER_ROLE=${status.role}; expected worker.`);
		process.exitCode = 1;
		return;
	}

	workerStartAttempted = true;
	const started = SignalOutcomeService.startWorker({ source: 'worker', unref: false });
	workerStartAttempted = started;

	if (!started) {
		console.warn('[SignalOutcomeWorker] Signal outcome tracking is disabled; worker is idle.');
		keepAlive = setInterval(() => {}, 60000);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error('[SignalOutcomeWorker] Failed to start:', error.message);
		process.exitCode = 1;
	});
}

module.exports = { main };
