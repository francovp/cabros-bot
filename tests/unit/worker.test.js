'use strict';

const { stopNotificationBot } = require('../../worker');

describe('Render worker shutdown', () => {
	it('does not stop an unlaunched notification bot', () => {
		const bot = { stop: jest.fn() };

		stopNotificationBot(bot, 'SIGTERM');

		expect(bot.stop).not.toHaveBeenCalled();
	});

	it('stops a notification bot with an active polling transport', () => {
		const bot = { polling: {}, stop: jest.fn() };

		stopNotificationBot(bot, 'SIGTERM');

		expect(bot.stop).toHaveBeenCalledWith('SIGTERM');
	});

	it('starts and stops RemoteConfigService during worker lifecycle', async () => {
		const startRc = jest.fn();
		const stopRc = jest.fn();
		const stopWorker = jest.fn().mockResolvedValue(undefined);
		const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

		const originalMode = process.env.JOB_EXECUTION_MODE;
		process.env.JOB_EXECUTION_MODE = 'render-worker';

		let mainFn;
		jest.isolateModules(() => {
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				start: startRc,
				stop: stopRc,
				// worker.js now also starts the user price alert worker, which reads
				// the runtime config through this module.
				getRuntimeConfig: () => ({}),
			}));
			jest.doMock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
				initializeNotificationServices: jest.fn().mockResolvedValue(undefined),
			}));
			jest.doMock('../../src/services/jobs/jobWorker', () => ({
				startJobWorker: jest.fn().mockResolvedValue({ stop: stopWorker }),
			}));
			jest.doMock('../../src/services/monitoring/SentryService', () => ({
				init: jest.fn(),
				flush: jest.fn().mockResolvedValue(true),
			}));
			mainFn = require('../../worker').main;
		});

		try {
			await mainFn();
			expect(startRc).toHaveBeenCalledTimes(1);

			process.emit('SIGTERM');
			await new Promise((resolve) => setImmediate(resolve));
			expect(stopWorker).toHaveBeenCalledTimes(1);
			expect(stopRc).toHaveBeenCalledTimes(1);
		} finally {
			exitSpy.mockRestore();
			if (originalMode === undefined) {
				delete process.env.JOB_EXECUTION_MODE;
			} else {
				process.env.JOB_EXECUTION_MODE = originalMode;
			}
		}
	});

	it('waits for Remote Config bootstrap before starting background workers', async () => {
		let finishRemoteConfigStart;
		const startRc = jest.fn(() => new Promise((resolve) => {
			finishRemoteConfigStart = resolve;
		}));
		const startJobWorker = jest.fn().mockResolvedValue({ stop: jest.fn() });
		const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
		const originalMode = process.env.JOB_EXECUTION_MODE;
		const originalBotEnabled = process.env.ENABLE_TELEGRAM_BOT;
		process.env.JOB_EXECUTION_MODE = 'render-worker';
		process.env.ENABLE_TELEGRAM_BOT = 'false';

		let mainFn;
		jest.isolateModules(() => {
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({ start: startRc, stop: jest.fn() }));
			jest.doMock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
				initializeNotificationServices: jest.fn().mockResolvedValue(undefined),
			}));
			jest.doMock('../../src/services/jobs/jobWorker', () => ({ startJobWorker }));
			jest.doMock('../../src/services/monitoring/SentryService', () => ({
				init: jest.fn(),
				flush: jest.fn().mockResolvedValue(true),
			}));
			jest.doMock('../../src/services/prompts', () => ({ probeManagedPromptReadiness: jest.fn() }));
			jest.doMock('../../src/services/notification/NotificationRedriveService', () => ({
				notificationRedriveService: { startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined) },
			}));
			jest.doMock('../../src/services/newsMonitorScheduler', () => ({
				newsMonitorSchedulerService: { startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined) },
			}));
			jest.doMock('../../src/services/scheduler', () => ({
				alertSchedulerService: {
					startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined),
				},
			}));
			jest.doMock('../../src/services/alerts/UserPriceAlertService', () => ({
				userPriceAlertService: {
					setBotGetter: jest.fn(), startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined),
				},
			}));
			mainFn = require('../../worker').main;
		});

		let mainPromise;
		try {
			mainPromise = mainFn();
			await new Promise((resolve) => setImmediate(resolve));
			expect(startJobWorker).not.toHaveBeenCalled();
			finishRemoteConfigStart();
			await mainPromise;
			expect(startJobWorker).toHaveBeenCalledTimes(1);
		} finally {
			if (finishRemoteConfigStart) finishRemoteConfigStart();
			if (process.listenerCount('SIGTERM') > 0) {
				process.emit('SIGTERM');
				await new Promise((resolve) => setImmediate(resolve));
			}
			exitSpy.mockRestore();
			if (originalMode === undefined) {
				delete process.env.JOB_EXECUTION_MODE;
			} else {
				process.env.JOB_EXECUTION_MODE = originalMode;
			}
			if (originalBotEnabled === undefined) {
				delete process.env.ENABLE_TELEGRAM_BOT;
			} else {
				process.env.ENABLE_TELEGRAM_BOT = originalBotEnabled;
			}
		}
	});

	it('exits with failure when the delayed job worker cannot become ready', async () => {
		const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
		const originalMode = process.env.JOB_EXECUTION_MODE;
		const originalBotEnabled = process.env.ENABLE_TELEGRAM_BOT;
		process.env.JOB_EXECUTION_MODE = 'render-worker';
		process.env.ENABLE_TELEGRAM_BOT = 'false';

		let mainFn;
		jest.isolateModules(() => {
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				start: jest.fn().mockResolvedValue(true), stop: jest.fn(),
			}));
			jest.doMock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
				initializeNotificationServices: jest.fn().mockResolvedValue(undefined),
			}));
			jest.doMock('../../src/services/jobs/jobWorker', () => ({
				startJobWorker: jest.fn().mockResolvedValue({
					stop: jest.fn().mockResolvedValue(undefined),
					ready: Promise.reject(new Error('queue not ready')),
				}),
			}));
			jest.doMock('../../src/services/monitoring/SentryService', () => ({
				init: jest.fn(), flush: jest.fn().mockResolvedValue(true),
			}));
			jest.doMock('../../src/services/prompts', () => ({ probeManagedPromptReadiness: jest.fn() }));
			jest.doMock('../../src/services/notification/NotificationRedriveService', () => ({
				notificationRedriveService: { startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined) },
			}));
			jest.doMock('../../src/services/newsMonitorScheduler', () => ({
				newsMonitorSchedulerService: { startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined) },
			}));
			jest.doMock('../../src/services/scheduler', () => ({
				alertSchedulerService: { startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined) },
			}));
			jest.doMock('../../src/services/alerts/UserPriceAlertService', () => ({
				userPriceAlertService: {
					setBotGetter: jest.fn(), startWorker: jest.fn(), stopWorker: jest.fn().mockResolvedValue(undefined),
				},
			}));
			mainFn = require('../../worker').main;
		});

		try {
			await expect(mainFn()).rejects.toThrow('queue not ready');
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			if (process.listenerCount('SIGTERM') > 0) {
				process.emit('SIGTERM');
				await new Promise((resolve) => setImmediate(resolve));
			}
			exitSpy.mockRestore();
			if (originalMode === undefined) {
				delete process.env.JOB_EXECUTION_MODE;
			} else {
				process.env.JOB_EXECUTION_MODE = originalMode;
			}
			if (originalBotEnabled === undefined) {
				delete process.env.ENABLE_TELEGRAM_BOT;
			} else {
				process.env.ENABLE_TELEGRAM_BOT = originalBotEnabled;
			}
		}
	});
});
