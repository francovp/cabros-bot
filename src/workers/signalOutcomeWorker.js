'use strict';

require('dotenv').config();
require('../../instrument.js');
const { printWarnings, validateEnv } = require('../../scripts/validate-env');
const { parseEntryPriceSources } = require('../lib/signalOutcomeEntryPriceSources');
const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');

printWarnings(validateEnv());
if (process.env.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES) {
	parseEntryPriceSources(process.env.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES);
}

const SignalOutcomeService = require('../services/storage/SignalOutcomeService');
const sentryService = require('../services/monitoring/SentryService');

async function main() {
	try {
		await remoteConfigService.start();
	} catch (error) {
		console.warn('[SignalOutcomeWorker] Remote Config failed to start; continuing with environment/default values:', error.message);
	}

	const status = SignalOutcomeService.getWorkerStatus();
	if (status.role !== 'worker') {
		console.error(`[SignalOutcomeWorker] Refusing to start with SIGNAL_OUTCOME_WORKER_ROLE=${status.role}; expected worker.`);
		process.exitCode = 1;
		return;
	}

	let keepAlive = null;
	let shutdownPromise = null;
	const started = SignalOutcomeService.startWorker({ source: 'worker', unref: false });

	if (!started) {
		console.warn('[SignalOutcomeWorker] Signal outcome tracking is disabled; worker is idle.');
		keepAlive = setInterval(() => {}, 60000);
	}

	const shutdown = (signal) => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		console.log(`[SignalOutcomeWorker] Received ${signal}; draining active sweep.`);
		shutdownPromise = Promise.resolve(SignalOutcomeService.stopWorker({ drain: true }))
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
			.finally(() => {
				process.exit(0);
			});

		return shutdownPromise;
	};

	process.once('SIGINT', () => { void shutdown('SIGINT'); });
	process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

if (require.main === module) {
	main().catch((error) => {
		console.error('[SignalOutcomeWorker] Failed to start:', error.message);
		process.exitCode = 1;
	});
}

module.exports = { main };
