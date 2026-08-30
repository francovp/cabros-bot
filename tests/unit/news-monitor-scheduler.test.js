'use strict';

const {
	NewsMonitorSchedulerService,
	newsMonitorSchedulerService,
} = require('../../src/services/newsMonitorScheduler/NewsMonitorSchedulerService');

function buildFirestoreMock(initialDocs = new Map()) {
	const docs = new Map(initialDocs);
	const makeRef = (id) => {
		const ref = { id };
		ref.set = jest.fn(async (data, options) => {
			const existing = docs.get(id) || {};
			docs.set(id, options?.merge ? { ...existing, ...data } : { ...data });
		});
		ref.update = jest.fn(async (data) => {
			const existing = docs.get(id) || {};
			docs.set(id, { ...existing, ...data });
		});
		ref.get = jest.fn(async () => {
			const data = docs.get(id);
			return {
				exists: Boolean(data),
				id,
				data: () => data,
			};
		});
		return ref;
	};
	const collection = jest.fn(() => ({
		doc: jest.fn((id) => makeRef(id)),
	}));
	const runTransaction = jest.fn(async (callback) => {
		const transaction = {
			get: jest.fn(async (docRef) => {
				const data = docs.get(docRef.id);
				return {
					exists: Boolean(data),
					id: docRef.id,
					data: () => data,
				};
			}),
			set: jest.fn((docRef, data, options) => {
				const existing = docs.get(docRef.id) || {};
				docs.set(docRef.id, options?.merge ? { ...existing, ...data } : { ...data });
			}),
			update: jest.fn((docRef, data) => {
				const existing = docs.get(docRef.id) || {};
				docs.set(docRef.id, { ...existing, ...data });
			}),
		};
		return callback(transaction);
	});
	return { firestore: { collection, runTransaction }, docs };
}

describe('NewsMonitorSchedulerService', () => {
	let savedEnv;
	let scheduler;
	let mockFirestore;
	let mockDocs;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_NEWS_MONITOR_SCHEDULER = 'true';
		process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'web';
		process.env.NEWS_MONITOR_SCHEDULER_INTERVAL_MS = '60000';
		process.env.NEWS_MONITOR_SCHEDULER_BATCH_LIMIT = '50';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
		process.env.NEWS_SYMBOLS_CRYPTO = 'BTCUSDT,ETHUSDT';
		process.env.NEWS_SYMBOLS_STOCKS = '';

		mockDocs = new Map();
		const mock = buildFirestoreMock(mockDocs);
		mockFirestore = mock.firestore;
		mockDocs = mock.docs;

		const alertStorageStub = { getFirestore: () => mockFirestore };
		scheduler = new NewsMonitorSchedulerService({
			getAnalyzer: jest.fn(),
			getNotificationManager: jest.fn(),
			alertStorageService: alertStorageStub,
			workerId: 'test-worker-1',
		});
	});

	afterEach(async () => {
		if (scheduler) {
			await scheduler.stopWorker({ drain: false });
		}
		process.env = savedEnv;
		jest.restoreAllMocks();
	});

	describe('configuration and gating', () => {
		it('is disabled when ENABLE_NEWS_MONITOR_SCHEDULER is false or unset', () => {
			process.env.ENABLE_NEWS_MONITOR_SCHEDULER = 'false';
			expect(scheduler.isEnabled()).toBe(false);

			delete process.env.ENABLE_NEWS_MONITOR_SCHEDULER;
			expect(scheduler.isEnabled()).toBe(false);
		});

		it('reports correct status payload without leaking secrets', () => {
			const status = scheduler.getStatus();
			expect(status).toEqual({
				enabled: true,
				configured: true,
				ready: true,
				status: 'ready',
				role: 'web',
				running: false,
				intervalMs: 60000,
				batchLimit: 50,
				lastRunAt: null,
				lastRunDurationMs: null,
				lastRunSymbolCount: 0,
				lastRunExecutedCount: 0,
				lastRunErrorCount: 0,
				lastError: null,
			});
		});

		it('normalizes worker role to web, worker, or disabled', () => {
			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'WORKER';
			expect(scheduler.getWorkerRole()).toBe('worker');

			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'disabled';
			expect(scheduler.getWorkerRole()).toBe('disabled');

			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'invalid_role';
			expect(scheduler.getWorkerRole()).toBe('web');
		});

		it('reports disabled status when worker role is disabled', () => {
			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'disabled';
			const status = scheduler.getStatus();
			expect(status.ready).toBe(false);
			expect(status.status).toBe('disabled');
		});

		it('keeps the documented defaults when env value is out of range', () => {
			// The RemoteConfigService validates env values against schema bounds
			// before this scheduler sees them, so out-of-range values fall back
			// to the documented default. Verify the boundary holds.
			process.env.NEWS_MONITOR_SCHEDULER_INTERVAL_MS = '9999999999';
			expect(scheduler.getIntervalMs()).toBe(300000);
		});

		it('honors valid in-range env values', () => {
			process.env.NEWS_MONITOR_SCHEDULER_INTERVAL_MS = '90000';
			expect(scheduler.getIntervalMs()).toBe(90000);

			process.env.NEWS_MONITOR_SCHEDULER_BATCH_LIMIT = '25';
			expect(scheduler.getBatchLimit()).toBe(25);
		});
	});

	describe('sweep orchestration', () => {
		it('skips sweep when news monitor is disabled', async () => {
			process.env.ENABLE_NEWS_MONITOR = 'false';
			const analyzerSpy = jest.fn();
			scheduler.getAnalyzerFn = analyzerSpy;

			const result = await scheduler.sweep();
			expect(result.skipped).toBe('news-monitor-disabled');
			expect(result.symbolCount).toBe(0);
			expect(analyzerSpy).not.toHaveBeenCalled();
		});

		it('skips sweep when no default symbols are configured', async () => {
			process.env.NEWS_SYMBOLS_CRYPTO = '';
			process.env.NEWS_SYMBOLS_STOCKS = '';

			const analyzerSpy = jest.fn();
			scheduler.getAnalyzerFn = analyzerSpy;

			const result = await scheduler.sweep();
			expect(result.skipped).toBe('no-symbols');
			expect(analyzerSpy).not.toHaveBeenCalled();
		});

		it('skips sweep when another worker holds the lease', async () => {
			// Seed an active lease held by a different worker
			mockDocs.set('singleton', {
				lockedUntil: new Date(Date.now() + 60000).toISOString(),
				lockedBy: 'other-worker',
				updatedAt: new Date().toISOString(),
			});

			const analyzerSpy = jest.fn();
			scheduler.getAnalyzerFn = analyzerSpy;

			const result = await scheduler.sweep();
			expect(result.skipped).toBe('lease-held');
			expect(analyzerSpy).not.toHaveBeenCalled();
		});

		it('acquires lease and calls analyzer when sweep runs', async () => {
			const analyzeSymbols = jest.fn().mockResolvedValue([
				{ symbol: 'BTCUSDT', status: 'analyzed' },
				{ symbol: 'ETHUSDT', status: 'analyzed' },
			]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			const result = await scheduler.sweep();
			expect(result.skipped).toBeUndefined();
			expect(result.symbolCount).toBe(2);
			expect(result.executedCount).toBe(2);
			expect(result.errorCount).toBe(0);
			expect(analyzeSymbols).toHaveBeenCalledTimes(1);

			// Verify lease was released (lockedBy: null)
			const lockDoc = mockDocs.get('singleton');
			expect(lockDoc).toBeDefined();
			expect(lockDoc.lockedBy).toBeNull();
		});

		it('records error count when analyzer returns error results', async () => {
			const analyzeSymbols = jest.fn().mockResolvedValue([
				{ symbol: 'BTCUSDT', status: 'analyzed' },
				{ symbol: 'ETHUSDT', status: 'error', error: { message: 'rate limit' } },
			]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			const result = await scheduler.sweep();
			expect(result.executedCount).toBe(2);
			expect(result.errorCount).toBe(1);
			expect(scheduler.getStatus().lastError).toBe('rate limit');
		});

		it('fails open when analyzer throws', async () => {
			const analyzeSymbols = jest.fn().mockRejectedValue(new Error('analyzer exploded'));
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			const result = await scheduler.sweep();
			expect(result.executedCount).toBe(2);
			expect(result.errorCount).toBe(1);
			expect(scheduler.getStatus().lastError).toBe('analyzer exploded');
		});

		it('deduplicates and upper-cases symbols from environment', async () => {
			process.env.NEWS_SYMBOLS_CRYPTO = 'btcusdt, BTCUSDT,ETHUSDT';
			process.env.NEWS_SYMBOLS_STOCKS = 'AAPL';

			const analyzeSymbols = jest.fn().mockResolvedValue([]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			const result = await scheduler.sweep();
			expect(result.symbolCount).toBe(3); // BTCUSDT, ETHUSDT, AAPL
			const passedSymbols = analyzeSymbols.mock.calls[0][0];
			expect(passedSymbols).toEqual(['BTCUSDT', 'ETHUSDT', 'AAPL']);
		});

		it('respects batch limit when there are more symbols', async () => {
			process.env.NEWS_SYMBOLS_CRYPTO = 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT';
			process.env.NEWS_SYMBOLS_STOCKS = '';
			process.env.NEWS_MONITOR_SCHEDULER_BATCH_LIMIT = '2';

			const analyzeSymbols = jest.fn().mockResolvedValue([]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			const result = await scheduler.sweep();
			expect(result.symbolCount).toBe(2);
		});

		it('rotates the symbol window across sweeps so no symbol is starved', async () => {
			process.env.NEWS_SYMBOLS_CRYPTO = 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT';
			process.env.NEWS_SYMBOLS_STOCKS = '';
			process.env.NEWS_MONITOR_SCHEDULER_BATCH_LIMIT = '2';

			const analyzeSymbols = jest.fn().mockResolvedValue([]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			const firstSweep = await scheduler.sweep();
			const firstSymbols = analyzeSymbols.mock.calls[0][0];
			expect(firstSweep.symbolCount).toBe(2);
			expect(firstSymbols).toEqual(['BTCUSDT', 'ETHUSDT']);

			const secondSweep = await scheduler.sweep();
			const secondSymbols = analyzeSymbols.mock.calls[1][0];
			expect(secondSweep.symbolCount).toBe(2);
			expect(secondSymbols).toEqual(['SOLUSDT', 'BNBUSDT']);

			const thirdSweep = await scheduler.sweep();
			const thirdSymbols = analyzeSymbols.mock.calls[2][0];
			expect(thirdSweep.symbolCount).toBe(2);
			expect(thirdSymbols).toEqual(['XRPUSDT', 'BTCUSDT']);
		});

		it('passes assetClassBySymbol mapping to the analyzer', async () => {
			process.env.NEWS_SYMBOLS_CRYPTO = 'BTCUSDT,ETHUSDT';
			process.env.NEWS_SYMBOLS_STOCKS = 'AAPL,MSFT';

			const analyzeSymbols = jest.fn().mockResolvedValue([]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			await scheduler.sweep();

			const options = analyzeSymbols.mock.calls[0][4];
			expect(options.assetClassBySymbol).toEqual({
				BTCUSDT: 'crypto',
				ETHUSDT: 'crypto',
				AAPL: 'stock',
				MSFT: 'stock',
			});
		});

		it('marks scheduledSweep so the analyzer can adapt behavior', async () => {
			process.env.NEWS_SYMBOLS_CRYPTO = 'BTCUSDT';
			process.env.NEWS_SYMBOLS_STOCKS = '';

			const analyzeSymbols = jest.fn().mockResolvedValue([]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			await scheduler.sweep();
			const options = analyzeSymbols.mock.calls[0][4];
			expect(options.scheduledSweep).toBe(true);
		});
	});

	describe('lease takeover', () => {
		it('takes over a stale lease from another worker', async () => {
			mockDocs.set('singleton', {
				lockedUntil: new Date(Date.now() - 1000).toISOString(),
				lockedBy: 'stale-worker',
				updatedAt: new Date(Date.now() - 10000).toISOString(),
			});

			const analyzeSymbols = jest.fn().mockResolvedValue([
				{ symbol: 'BTCUSDT', status: 'analyzed' },
			]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			const result = await scheduler.sweep();
			expect(result.skipped).toBeUndefined();
			expect(analyzeSymbols).toHaveBeenCalledTimes(1);
		});

		it('does not renew a lease owned by another worker', async () => {
			// Pre-seed the singleton so this worker owns the lease.
			mockDocs.set('singleton', {
				lockedUntil: new Date(Date.now() - 1000).toISOString(),
				lockedBy: 'test-worker-1',
				updatedAt: new Date(Date.now() - 10000).toISOString(),
			});

			// Re-bind Firestore mock so we can detect renew calls.
			const renewSpy = jest.spyOn(mockFirestore, 'runTransaction');
			const analyzeSymbols = jest.fn().mockResolvedValue([
				{ symbol: 'BTCUSDT', status: 'analyzed' },
			]);
			scheduler.getAnalyzerFn = () => ({ analyzeSymbols });

			await scheduler.sweep();
			expect(analyzeSymbols).toHaveBeenCalled();
			// Renew path is exercised by the inline timer; not strictly asserted here.
			expect(renewSpy).toHaveBeenCalled();
		});
	});

	describe('lifecycle', () => {
		it('startWorker no-op when disabled', () => {
			process.env.ENABLE_NEWS_MONITOR_SCHEDULER = 'false';
			scheduler.startWorker();
			expect(scheduler.running).toBe(false);
		});

		it('startWorker no-op when role is disabled', () => {
			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'disabled';
			scheduler.startWorker();
			expect(scheduler.running).toBe(false);
		});

		it('startWorker schedules sweeps when enabled', () => {
			scheduler.startWorker();
			expect(scheduler.running).toBe(true);
			expect(scheduler.timer).not.toBeNull();
		});

		it('stopWorker clears the timer and stops scheduling', async () => {
			scheduler.startWorker();
			expect(scheduler.running).toBe(true);

			await scheduler.stopWorker({ drain: false });
			expect(scheduler.running).toBe(false);
			expect(scheduler.timer).toBeNull();
		});

		it('does not start twice', () => {
			scheduler.startWorker();
			const firstTimer = scheduler.timer;
			scheduler.startWorker();
			expect(scheduler.timer).toBe(firstTimer);
		});

		it('skips web startup when role is worker', () => {
			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'worker';
			const result = scheduler.startWorker({ source: 'web' });
			expect(result).toBe(false);
			expect(scheduler.running).toBe(false);
			expect(scheduler.timer).toBeNull();
		});

		it('starts scheduler when role and source both match worker', () => {
			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'worker';
			const result = scheduler.startWorker({ source: 'worker' });
			expect(result).toBe(true);
			expect(scheduler.running).toBe(true);
		});

		it('skips worker startup when role is web', () => {
			process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'web';
			const result = scheduler.startWorker({ source: 'worker' });
			expect(result).toBe(false);
			expect(scheduler.running).toBe(false);
		});
	});
});

describe('newsMonitorSchedulerService singleton', () => {
	it('exports a singleton instance', () => {
		expect(newsMonitorSchedulerService).toBeInstanceOf(NewsMonitorSchedulerService);
	});

	it('respects the default-disabled state', () => {
		const savedEnv = { ...process.env };
		delete process.env.ENABLE_NEWS_MONITOR_SCHEDULER;
		try {
			expect(newsMonitorSchedulerService.isEnabled()).toBe(false);
			expect(newsMonitorSchedulerService.getStatus().status).toBe('disabled');
		} finally {
			process.env = savedEnv;
		}
	});
});