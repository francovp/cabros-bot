'use strict';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30000;

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
		waitForBackgroundJobs = () => undefined,
		stopSignalOutcomeWorker = () => undefined,
		shutdownNewsMonitor = () => undefined,
		flushSentry = () => undefined,
		timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
		logger = console,
		forceExit = (code) => process.exit(code),
	} = options;
	const shutdownTimeoutMs = parseShutdownTimeout(timeoutMs);
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
				let stopError;
				try {
					const bot = getBot();
					if (bot && typeof bot.stop === 'function') {
						await bot.stop(signal);
					}
				} catch (error) {
					stopError = error;
				}

				const launchPromise = getBotLaunchPromise();
				if (launchPromise && typeof launchPromise.then === 'function') {
					await launchPromise;
				}

				if (stopError) {
					throw stopError;
				}
			};

			const cleanup = async () => {
				await closeServer(server, logger);
				await safelyRun(logger, 'Telegram bot', stopBot);
				await safelyRun(logger, 'background jobs', waitForBackgroundJobs);
				await Promise.allSettled([
					safelyRun(logger, 'signal-outcome worker', () => stopSignalOutcomeWorker({ drain: true })),
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
