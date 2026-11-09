'use strict';

const {
	postPauseNewsMonitor,
	postResumeNewsMonitor,
	getNewsMonitorStatus,
	setFirestoreForTest,
	resetNewsMonitorPauseStateForTest,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/pauseState');
const { NewsMonitorSchedulerService } = require('../../src/services/newsMonitorScheduler/NewsMonitorSchedulerService');
const { getApiStatus } = require('../../src/controllers/status');

function buildSharedFirestore() {
	let store = null;
	const docRef = {
		id: 'state',
		get: jest.fn(async () => ({
			exists: store !== null,
			data: () => (store ? { ...store } : undefined),
		})),
		set: jest.fn(async (data) => {
			store = { ...(store || {}), ...data };
		}),
	};
	const collectionRef = {
		doc: jest.fn(() => docRef),
	};
	return {
		collection: jest.fn(() => collectionRef),
		_getStore: () => store,
		_setStore: (data) => { store = data ? { ...data } : null; },
		_docRef: docRef,
	};
}

describe('Distributed News Monitor Pause (GH-1198 Regression)', () => {
	let originalEnv;
	let sharedFirestore;
	let workerScheduler;
	let mockAnalyzer;

	beforeEach(() => {
		originalEnv = { ...process.env };
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.ENABLE_NEWS_MONITOR_SCHEDULER = 'true';
		process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE = 'worker';
		process.env.ENABLE_FIRESTORE_NEWS_MONITOR_PAUSE = 'true';
		process.env.NEWS_MONITOR_PAUSE_CACHE_TTL_MS = '100';

		resetNewsMonitorPauseStateForTest();
		sharedFirestore = buildSharedFirestore();
		setFirestoreForTest(sharedFirestore);

		mockAnalyzer = {
			analyzeSymbols: jest.fn(async (symbols) => symbols.map((s) => ({ symbol: s, status: 'analyzed' }))),
		};

		workerScheduler = new NewsMonitorSchedulerService();
		workerScheduler.getAnalyzerFn = () => mockAnalyzer;
	});

	afterEach(() => {
		process.env = originalEnv;
		resetNewsMonitorPauseStateForTest();
	});

	it('worker scheduler observes pause triggered via web API and skips sweep', async () => {
		// 1. Initially unpaused: worker executes sweep normally
		const sweep1 = await workerScheduler.sweep();
		expect(sweep1.skipped).toBeUndefined();
		expect(sweep1.executedCount).toBeGreaterThan(0);
		expect(mockAnalyzer.analyzeSymbols).toHaveBeenCalledTimes(1);

		// 2. Web instance receives pause request
		const pauseReq = { body: { reason: 'Emergency Gemini quota throttle' } };
		const pauseRes = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};
		await postPauseNewsMonitor(pauseReq, pauseRes);
		expect(pauseRes.status).toHaveBeenCalledWith(200);

		// 3. Worker scheduler runs next sweep: must skip and process zero symbols
		mockAnalyzer.analyzeSymbols.mockClear();
		const sweep2 = await workerScheduler.sweep();
		expect(sweep2.skipped).toBe('news-monitor-paused');
		expect(sweep2.symbolCount).toBe(0);
		expect(sweep2.executedCount).toBe(0);
		expect(mockAnalyzer.analyzeSymbols).not.toHaveBeenCalled();

		// 4. Web status reports paused
		const statusReq = {};
		const statusRes = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};
		await getNewsMonitorStatus(statusReq, statusRes);
		expect(statusRes.status).toHaveBeenCalledWith(200);
		expect(statusRes.json).toHaveBeenCalledWith(expect.objectContaining({
			paused: true,
			reason: 'Emergency Gemini quota throttle',
		}));

		// 5. Web instance receives resume request
		const resumeReq = {};
		const resumeRes = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};
		await postResumeNewsMonitor(resumeReq, resumeRes);
		expect(resumeRes.status).toHaveBeenCalledWith(200);

		// 6. Worker scheduler runs next sweep: resumes processing
		mockAnalyzer.analyzeSymbols.mockClear();
		const sweep3 = await workerScheduler.sweep();
		expect(sweep3.skipped).toBeUndefined();
		expect(sweep3.executedCount).toBeGreaterThan(0);
		expect(mockAnalyzer.analyzeSymbols).toHaveBeenCalledTimes(1);
	});

	it('fails open when Firestore read errors occur during sweep synchronization', async () => {
		// Simulate initial unpaused state
		sharedFirestore._setStore({ paused: false });

		// Break Firestore read
		sharedFirestore._docRef.get = jest.fn().mockRejectedValue(new Error('Firestore connection reset by peer'));

		// Worker sweep should not throw; it fails open to local state and processes
		await expect(workerScheduler.sweep()).resolves.toEqual(expect.objectContaining({
			executedCount: expect.any(Number),
		}));
		expect(mockAnalyzer.analyzeSymbols).toHaveBeenCalledTimes(1);
	});

	it('status controller endpoint probes and reflects shared Firestore pause state', async () => {
		// Seed shared store as paused from another instance
		sharedFirestore._setStore({
			paused: true,
			pausedAt: '2026-11-09T01:30:00.000Z',
			reason: 'Remote worker death prevention',
		});

		const req = {};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};

		await getApiStatus(req, res);
		expect(res.status).toHaveBeenCalledWith(200);
		const payload = res.json.mock.calls[0][0];
		expect(payload.dependencies.newsMonitor.paused).toBe(true);
		expect(payload.dependencies.newsMonitor.reason).toBe('Remote worker death prevention');
		expect(payload.featureFlags.newsMonitorPaused).toBe(true);
	});
});
