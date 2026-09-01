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
				applyRuntimeConfig: jest.fn(),
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
});
