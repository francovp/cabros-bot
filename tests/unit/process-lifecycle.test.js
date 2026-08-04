const { createProcessLifecycle, parseShutdownTimeout } = require('../../src/lib/processLifecycle');

describe('process lifecycle coordinator', () => {
	it('bounds configured shutdown timeouts and falls back for invalid values', () => {
		expect(parseShutdownTimeout('1500')).toBe(1500);
		expect(parseShutdownTimeout('60000')).toBe(30000);
		expect(parseShutdownTimeout('invalid')).toBe(10000);
		expect(parseShutdownTimeout('0')).toBe(10000);
	});

	it('drains the server and runs cleanup once when signals repeat', async () => {
		const server = { close: jest.fn((callback) => callback()) };
		const bot = { stop: jest.fn().mockResolvedValue(undefined) };
		const stopWorker = jest.fn().mockResolvedValue(undefined);
		const shutdownNewsMonitor = jest.fn();
		const flushSentry = jest.fn().mockResolvedValue(true);
		const forceExit = jest.fn();

		const lifecycle = createProcessLifecycle({
			getServer: () => server,
			getBot: () => bot,
			stopSignalOutcomeWorker: stopWorker,
			shutdownNewsMonitor,
			flushSentry,
			timeoutMs: 100,
			forceExit,
		});

		const firstShutdown = lifecycle.handleSignal('SIGTERM');
		const secondShutdown = lifecycle.handleSignal('SIGINT');

		expect(lifecycle.isShuttingDown()).toBe(true);
		expect(secondShutdown).toBe(firstShutdown);
		await firstShutdown;

		expect(server.close).toHaveBeenCalledTimes(1);
		expect(stopWorker).toHaveBeenCalledWith({ drain: true });
		expect(shutdownNewsMonitor).toHaveBeenCalledTimes(1);
		expect(bot.stop).toHaveBeenCalledWith('SIGTERM');
		expect(flushSentry).toHaveBeenCalledWith(100);
		expect(forceExit).toHaveBeenCalledWith(0);
	});

	it('forces exit and closes remaining connections after the deadline', async () => {
		const server = {
			close: jest.fn(),
			closeAllConnections: jest.fn(),
		};
		const forceExit = jest.fn();
		const finalizeBackgroundJobs = jest.fn().mockResolvedValue(undefined);

		const lifecycle = createProcessLifecycle({
			getServer: () => server,
			finalizeBackgroundJobs,
			timeoutMs: 5,
			forceExit,
		});

		await expect(lifecycle.handleSignal('SIGTERM')).resolves.toEqual({ timedOut: true });

		expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
		expect(finalizeBackgroundJobs).toHaveBeenCalledTimes(1);
		expect(forceExit).toHaveBeenCalledWith(1);
	});

	it('bounds unfinished-job finalization before forced exit', async () => {
		const server = { close: jest.fn() };
		const finalizeBackgroundJobs = jest.fn(() => new Promise(() => {}));
		const forceExit = jest.fn();
		const lifecycle = createProcessLifecycle({
			getServer: () => server,
			finalizeBackgroundJobs,
			timeoutMs: 5,
			finalizationTimeoutMs: 5,
			forceExit,
		});

		await lifecycle.handleSignal('SIGTERM');

		expect(finalizeBackgroundJobs).toHaveBeenCalledTimes(1);
		expect(forceExit).toHaveBeenCalledWith(1);
	});

	it('waits for background jobs and Telegram polling before flushing Sentry', async () => {
		const events = [];
		let releaseJobs;
		let releasePolling;
		const jobsPromise = new Promise((resolve) => { releaseJobs = resolve; });
		const pollingPromise = new Promise((resolve) => { releasePolling = resolve; });
		const server = { close: jest.fn((callback) => { events.push('server'); callback(); }) };
		const bot = { stop: jest.fn(() => events.push('bot')) };
		const forceExit = jest.fn((code) => events.push(`exit:${code}`));

		const lifecycle = createProcessLifecycle({
			getServer: () => server,
			getBot: () => bot,
			getBotLaunchPromise: () => pollingPromise,
			waitForBackgroundJobs: () => {
				events.push('jobs');
				return jobsPromise;
			},
			stopSignalOutcomeWorker: () => events.push('worker'),
			shutdownNewsMonitor: () => events.push('news'),
			flushSentry: () => events.push('sentry'),
			forceExit,
		});

		const shutdown = lifecycle.handleSignal('SIGTERM');
		await new Promise((resolve) => setImmediate(resolve));

		expect(events).toEqual(['server', 'bot']);
		expect(forceExit).not.toHaveBeenCalled();

		releasePolling();
		await new Promise((resolve) => setImmediate(resolve));
		expect(events.slice(0, 3)).toEqual(['server', 'bot', 'jobs']);
		expect(events).not.toContain('sentry');

		releaseJobs();
		await shutdown;

		expect(events).toEqual(['server', 'bot', 'jobs', 'worker', 'news', 'sentry', 'exit:0']);
	});
});
