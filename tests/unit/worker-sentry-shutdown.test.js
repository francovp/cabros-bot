'use strict';

const events = [];

function mockSentry() {
	const flush = jest.fn(async (timeout) => {
		events.push(`flush:${timeout}`);
		return true;
	});

	jest.doMock('../../src/services/monitoring/SentryService', () => ({
		init: jest.fn(),
		flush,
	}));
}

function waitForShutdown() {
	return new Promise((resolve) => setImmediate(resolve));
}

function mockNotificationRedrive() {
	jest.doMock('../../src/services/notification/NotificationRedriveService', () => ({
		notificationRedriveService: {
			startWorker: jest.fn(() => events.push('redrive:start')),
			stopWorker: jest.fn(async ({ drain } = {}) => events.push(`redrive:stop:${drain ? 'drain' : 'intake'}`)),
		},
	}));
}

describe('standalone worker Sentry shutdown flush', () => {
	beforeEach(() => {
		jest.resetModules();
		events.length = 0;
		jest.spyOn(process, 'exit').mockImplementation((code) => {
			events.push(`exit:${code}`);
		});
	});

	afterEach(() => {
		process.exit.mockRestore();
		delete process.env.JOB_EXECUTION_MODE;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
	});

	it('flushes Sentry after TradingView job drain and before exit', async () => {
		process.env.JOB_EXECUTION_MODE = 'render-worker';
		mockSentry();
		jest.doMock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
			initializeNotificationServices: jest.fn().mockResolvedValue(undefined),
		}));
		jest.doMock('../../src/services/jobs/jobWorker', () => ({
			startJobWorker: jest.fn().mockResolvedValue({
				stop: jest.fn(async () => events.push('jobs:stop')),
			}),
		}));
		mockNotificationRedrive();

		const { main } = require('../../worker');
		await main();
		process.emit('SIGTERM');
		await waitForShutdown();

		expect(events).toEqual(['redrive:start', 'redrive:stop:intake', 'jobs:stop', 'redrive:stop:drain', 'flush:2000', 'exit:0']);
	});

	it('flushes Sentry after TradingView job drain in firestore-poller mode and before exit', async () => {
		process.env.JOB_EXECUTION_MODE = 'firestore-poller';
		mockSentry();
		jest.doMock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
			initializeNotificationServices: jest.fn().mockResolvedValue(undefined),
		}));
		jest.doMock('../../src/services/jobs/jobWorker', () => ({
			startJobWorker: jest.fn().mockResolvedValue({
				stop: jest.fn(async () => events.push('jobs:stop')),
			}),
		}));
		mockNotificationRedrive();

		const { main } = require('../../worker');
		await main();
		process.emit('SIGTERM');
		await waitForShutdown();

		expect(events).toEqual(['redrive:start', 'redrive:stop:intake', 'jobs:stop', 'redrive:stop:drain', 'flush:2000', 'exit:0']);
	});

	it('flushes Sentry before nonzero exit when TradingView job drain fails', async () => {
		process.env.JOB_EXECUTION_MODE = 'render-worker';
		mockSentry();
		jest.doMock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
			initializeNotificationServices: jest.fn().mockResolvedValue(undefined),
		}));
		jest.doMock('../../src/services/jobs/jobWorker', () => ({
			startJobWorker: jest.fn().mockResolvedValue({
				stop: jest.fn(async () => {
					events.push('jobs:stop');
					throw new Error('drain failed');
				}),
			}),
		}));
		mockNotificationRedrive();

		const { main } = require('../../worker');
		await main();
		process.emit('SIGTERM');
		await waitForShutdown();

		expect(events).toEqual(['redrive:start', 'redrive:stop:intake', 'jobs:stop', 'flush:2000', 'exit:1']);
	});

	it('flushes Sentry after signal-outcome drain and before exit', async () => {
		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';
		mockSentry();
		jest.doMock('../../src/services/storage/SignalOutcomeService', () => ({
			getWorkerStatus: jest.fn().mockReturnValue({ role: 'worker' }),
			startWorker: jest.fn().mockReturnValue(true),
			stopWorker: jest.fn(async () => events.push('outcomes:stop')),
		}));

		require('../../src/workers/signalOutcomeWorker');
		process.emit('SIGTERM');
		await waitForShutdown();

		expect(events).toEqual(['outcomes:stop', 'flush:2000', 'exit:0']);
	});
});
