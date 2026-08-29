'use strict';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30000;
const DEFAULT_FORCED_FINALIZATION_TIMEOUT_MS = 2000;

function parseShutdownTimeout(value) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		return DEFAULT_SHUTDOWN_TIMEOUT_MS;
	}
	return Math.min(parsed, MAX_SHUTDOWN_TIMEOUT_MS);
}

function logFailure(logger, resource, error) {
	logger.warn(`[ProcessLifecycle] ${resource} cleanup failed: ${error.message}`);
}

function safelyRun(logger, resource, callback) {
	return Promise.resolve()
		.then(callback)
		.catch((error) => {
			logFailure(logger, resource, error);
		});
}

function parseFinalizationTimeout(value) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		return DEFAULT_FORCED_FINALIZATION_TIMEOUT_MS;
	}
	return Math.min(parsed, MAX_SHUTDOWN_TIMEOUT_MS);
}

async function safelyRunWithinTimeout(logger, resource, callback, timeoutMs) {
	let timer;
	const timedOut = await Promise.race([
		safelyRun(logger, resource, callback).then(() => false),
		new Promise((resolve) => {
			timer = setTimeout(() => resolve(true), timeoutMs);
		}),
	]);
	clearTimeout(timer);

	if (timedOut) {
		logger.warn(`[ProcessLifecycle] ${resource} finalization budget exceeded`, { timeoutMs });
	}
}

function closeServer(server, logger) {
	return new Promise((resolve) => {
		if (!server || typeof server.close !== 'function') {
			resolve();
			return;
		}

		try {
			server.close((error) => {
				if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
					logFailure(logger, 'HTTP server', error);
				}
				resolve();
			});
		} catch (error) {
			logFailure(logger, 'HTTP server', error);
			resolve();
		}
	});
}

function createProcessLifecycle(options = {}) {
	const {
		getServer = () => null,
		getBot = () => null,
		getBotLaunchPromise = () => null,
		getBootstrapPromise = () => undefined,
		waitForBackgroundJobs = () => undefined,
		waitForBackgroundTasks = () => undefined,
		finalizeBackgroundJobs = () => undefined,
		finalizationTimeoutMs = DEFAULT_FORCED_FINALIZATION_TIMEOUT_MS,
		stopSignalOutcomeWorker = () => undefined,
		stopNotificationRedriveWorker = () => undefined,
		stopWhatsAppCommandBridge = () => undefined,
		stopScannerPresetScheduler = () => undefined,
		stopRemoteConfig = () => undefined,
		shutdownNewsMonitor = () => undefined,
		flushSentry = () => undefined,
		timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
		logger = console,
		forceExit = (code) => process.exit(code),
	} = options;
	const shutdownTimeoutMs = parseShutdownTimeout(timeoutMs);
	const forcedFinalizationTimeoutMs = parseFinalizationTimeout(finalizationTimeoutMs);
	let shutdownPromise = null;
	let shuttingDown = false;

	const handleSignal = (signal = 'SIGTERM') => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		shuttingDown = true;
		logger.info('[ProcessLifecycle] Shutdown requested', { signal });
		shutdownPromise = (async () => {
			const server = getServer();
			const stopBot = async () => {
				const launchPromise = getBotLaunchPromise();
				const bot = getBot();
				if (!bot || typeof bot.stop !== 'function') {
					return;
				}

				if (!launchPromise || typeof launchPromise.then !== 'function') {
					try {
						await bot.stop(signal);
					} catch (error) {
						if (error.message !== 'Bot is not running!') {
							throw error;
						}
					}
					return;
				}

				let stopError;
				let retryTimer;
				let retryFinished = false;
				let finishRetry;
				const retryPromise = new Promise((resolve) => {
					finishRetry = () => {
						if (retryFinished) return;
						retryFinished = true;
						clearTimeout(retryTimer);
						resolve();
					};
				});
				const retryStop = () => {
					if (retryFinished) return;
					try {
						Promise.resolve(bot.stop(signal)).then(
							() => finishRetry(),
							(error) => {
								if (error.message !== 'Bot is not running!') {
									stopError = error;
									finishRetry();
									return;
								}
								retryTimer = setTimeout(retryStop, 10);
							},
						);
					} catch (error) {
						if (error.message !== 'Bot is not running!') {
							stopError = error;
							finishRetry();
							return;
						}
						retryTimer = setTimeout(retryStop, 10);
					}
				};

				retryStop();
				try {
					await launchPromise;
				} finally {
					finishRetry();
				}
				await retryPromise;
				if (stopError) throw stopError;
			};

			const cleanup = async () => {
				const telegramCleanup = safelyRun(logger, 'Telegram bot', stopBot);
				const bootstrapCleanup = safelyRun(logger, 'application bootstrap', getBootstrapPromise);
				await closeServer(server, logger);
				await telegramCleanup;
				await bootstrapCleanup;
				await safelyRun(logger, 'background jobs', waitForBackgroundJobs);
				await safelyRun(logger, 'background persistence tasks', waitForBackgroundTasks);
				await Promise.allSettled([
					safelyRun(logger, 'signal-outcome worker', () => stopSignalOutcomeWorker({ drain: true })),
					safelyRun(logger, 'notification redrive worker', () => stopNotificationRedriveWorker({ drain: true })),
					safelyRun(logger, 'whatsapp command bridge', () => stopWhatsAppCommandBridge({ drain: true })),
					safelyRun(logger, 'scanner preset scheduler', () => stopScannerPresetScheduler({ drain: true })),
					safelyRun(logger, 'remote config service', stopRemoteConfig),
					safelyRun(logger, 'news monitor cache', shutdownNewsMonitor),
				]);
				await safelyRun(logger, 'Sentry', () => flushSentry(Math.min(shutdownTimeoutMs, 2000)));
			};

			let deadlineTimer;
			const deadline = new Promise((resolve) => {
				deadlineTimer = setTimeout(() => resolve(true), shutdownTimeoutMs);
			});
			const completed = cleanup().then(() => false);
			const timedOut = await Promise.race([completed, deadline]);
			clearTimeout(deadlineTimer);

			if (timedOut) {
				logger.warn('[ProcessLifecycle] Shutdown deadline exceeded', { timeoutMs: shutdownTimeoutMs });
				await safelyRunWithinTimeout(
					logger,
					'unfinished background jobs',
					finalizeBackgroundJobs,
					forcedFinalizationTimeoutMs,
				);
				try {
					server?.closeAllConnections?.();
				} catch (error) {
					logFailure(logger, 'HTTP connection force-close', error);
				}
				try {
					forceExit(1);
				} catch (error) {
					logFailure(logger, 'forced process exit', error);
				}
				return { timedOut: true };
			}

			try {
				forceExit(0);
			} catch (error) {
				logFailure(logger, 'process exit', error);
			}
			return { timedOut: false };
		})();

		return shutdownPromise;
	};

	function register(processRef = process) {
		processRef.once('SIGINT', () => { void handleSignal('SIGINT'); });
		processRef.once('SIGTERM', () => { void handleSignal('SIGTERM'); });
		return processRef;
	}

	return {
		handleSignal,
		isShuttingDown: () => shuttingDown,
		register,
	};
}

module.exports = {
	createProcessLifecycle,
	parseShutdownTimeout,
};
