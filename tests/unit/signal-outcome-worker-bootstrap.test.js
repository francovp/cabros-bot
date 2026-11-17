'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('signal outcome worker bootstrap', () => {
	it('loads shared monitoring before the scheduler service', () => {
		const workerPath = path.join(__dirname, '../../src/workers/signalOutcomeWorker.js');
		const source = fs.readFileSync(workerPath, 'utf8');
		const instrumentationImport = source.indexOf("require('../../instrument.js')");
		const serviceImport = source.indexOf("require('../services/storage/SignalOutcomeService')");

		expect(instrumentationImport).toBeGreaterThanOrEqual(0);
		expect(instrumentationImport).toBeLessThan(serviceImport);
	});

	it('refuses to run when the service role is not worker', () => {
		const workerPath = path.join(__dirname, '../../src/workers/signalOutcomeWorker.js');
		const result = spawnSync(
			process.execPath,
			[workerPath],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					ENABLE_SIGNAL_OUTCOME_TRACKING: 'true',
					SIGNAL_OUTCOME_WORKER_ROLE: 'web',
					SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES: 'wat',
				},
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain('expected worker');
		expect(`${result.stdout}${result.stderr}`).not.toContain('Unknown signal outcome entry-price provider');
	});

	it('loads Remote Config before starting the dedicated worker', async () => {
		const startRemoteConfig = jest.fn().mockResolvedValue(true);
		const startWorker = jest.fn().mockReturnValue(true);
		const stopWorker = jest.fn().mockResolvedValue(undefined);
		const processOnce = jest.spyOn(process, 'once').mockImplementation(() => process);

		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';
		let main;
		jest.isolateModules(() => {
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				start: startRemoteConfig,
				stop: jest.fn(),
			}));
			jest.doMock('../../src/services/storage/SignalOutcomeService', () => ({
				getWorkerStatus: jest.fn(() => ({ role: 'worker' })),
				startWorker,
				stopWorker,
			}));
			jest.doMock('../../src/services/monitoring/SentryService', () => ({
				init: jest.fn(),
				flush: jest.fn().mockResolvedValue(true),
			}));

			main = require('../../src/workers/signalOutcomeWorker').main;
		});

		await main();
		expect(startRemoteConfig).toHaveBeenCalledTimes(1);
		expect(startWorker).toHaveBeenCalledTimes(1);
		processOnce.mockRestore();
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
	});

	it('registers shutdown handlers before waiting for Remote Config startup', async () => {
		let finishRemoteConfigStart;
		let signalsRegisteredAtRemoteConfigStart = [];
		const startRemoteConfig = jest.fn(() => {
			signalsRegisteredAtRemoteConfigStart = registeredSignals.map(([signal]) => signal);
			return new Promise((resolve) => { finishRemoteConfigStart = resolve; });
		});
		const stopRemoteConfig = jest.fn();
		const registeredSignals = [];
		const processOnce = jest.spyOn(process, 'once').mockImplementation((signal, handler) => {
			registeredSignals.push([signal, handler]);
			return process;
		});
		const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
		const flush = jest.fn().mockResolvedValue(true);
		const startWorker = jest.fn().mockReturnValue(true);
		const stopWorker = jest.fn().mockResolvedValue(undefined);
		const originalRole = process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';

		let main;
		jest.isolateModules(() => {
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				start: startRemoteConfig,
				stop: stopRemoteConfig,
			}));
			jest.doMock('../../src/services/storage/SignalOutcomeService', () => ({
				getWorkerStatus: jest.fn(() => ({ role: 'worker' })),
				startWorker,
				stopWorker,
			}));
			jest.doMock('../../src/services/monitoring/SentryService', () => ({
				init: jest.fn(),
				flush,
			}));
			main = require('../../src/workers/signalOutcomeWorker').main;
		});

		let mainPromise;
		try {
			mainPromise = main();
			await new Promise((resolve) => setImmediate(resolve));
			expect(signalsRegisteredAtRemoteConfigStart).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
			const sigtermHandler = registeredSignals.find(([signal]) => signal === 'SIGTERM')?.[1];
			sigtermHandler();
			await new Promise((resolve) => setImmediate(resolve));
			expect(stopWorker).not.toHaveBeenCalled();
			expect(stopRemoteConfig).toHaveBeenCalledTimes(1);
			expect(flush).toHaveBeenCalledWith(2000);
			expect(exitSpy).toHaveBeenCalledWith(0);
		} finally {
			if (finishRemoteConfigStart) {
				finishRemoteConfigStart();
				await mainPromise;
				expect(startWorker).not.toHaveBeenCalled();
			}
			processOnce.mockRestore();
			exitSpy.mockRestore();
			if (originalRole === undefined) delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
			else process.env.SIGNAL_OUTCOME_WORKER_ROLE = originalRole;
		}
	});
});
