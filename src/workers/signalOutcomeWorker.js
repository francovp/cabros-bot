'use strict';

require('dotenv').config();
require('../../instrument.js');

const SignalOutcomeService = require('../services/storage/SignalOutcomeService');

const status = SignalOutcomeService.getWorkerStatus();
if (status.role !== 'worker') {
	console.error(`[SignalOutcomeWorker] Refusing to start with SIGNAL_OUTCOME_WORKER_ROLE=${status.role}; expected worker.`);
	process.exitCode = 1;
} else {
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
				process.exit(0);
			});

		return shutdownPromise;
	};

	process.once('SIGINT', () => { void shutdown('SIGINT'); });
	process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}
