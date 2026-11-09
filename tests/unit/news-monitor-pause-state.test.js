'use strict';

const {
	isNewsMonitorPaused,
	getNewsMonitorPauseState,
	pauseNewsMonitor,
	resumeNewsMonitor,
	resetNewsMonitorPauseStateForTest,
	setFirestoreForTest,
	syncNewsMonitorPauseState,
	postPauseNewsMonitor,
	postResumeNewsMonitor,
	getNewsMonitorStatus,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/pauseState');

function buildMockFirestore(initialData = null) {
	let store = initialData ? { ...initialData } : null;
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
	const firestore = {
		collection: jest.fn(() => collectionRef),
		_getStore: () => store,
		_setStore: (data) => { store = data ? { ...data } : null; },
		_docRef: docRef,
	};
	return firestore;
}

describe('NewsMonitor pauseState', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		resetNewsMonitorPauseStateForTest();
	});

	afterEach(() => {
		process.env = originalEnv;
		resetNewsMonitorPauseStateForTest();
	});

	it('initializes in an unpaused state', () => {
		expect(isNewsMonitorPaused()).toBe(false);
		expect(getNewsMonitorPauseState()).toEqual({
			paused: false,
			pausedAt: null,
			reason: null,
		});
	});

	it('pauses with a provided reason and records timestamp', () => {
		const result = pauseNewsMonitor({ reason: 'Gemini quota exhaustion' });
		expect(result.paused).toBe(true);
		expect(result.reason).toBe('Gemini quota exhaustion');
		expect(result.pausedAt).toEqual(expect.any(String));
		expect(isNewsMonitorPaused()).toBe(true);
	});

	it('pauses without reason or with empty string falling back to null', () => {
		const result = pauseNewsMonitor({ reason: '   ' });
		expect(result.paused).toBe(true);
		expect(result.reason).toBeNull();
		expect(result.pausedAt).toEqual(expect.any(String));
	});

	it('resumes and returns previous paused state and resumed timestamp', () => {
		pauseNewsMonitor({ reason: 'Outage' });
		expect(isNewsMonitorPaused()).toBe(true);

		const result = resumeNewsMonitor();
		expect(result.paused).toBe(false);
		expect(result.wasPaused).toBe(true);
		expect(result.previouslyPausedAt).toEqual(expect.any(String));
		expect(result.resumedAt).toEqual(expect.any(String));
		expect(isNewsMonitorPaused()).toBe(false);

		expect(getNewsMonitorPauseState()).toEqual({
			paused: false,
			pausedAt: null,
			reason: null,
		});
	});

	describe('HTTP Controller Handlers (In-Memory Default)', () => {
		it('postPauseNewsMonitor returns 200 with paused status', async () => {
			const req = {
				body: { reason: 'Binance maintenance' },
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			await postPauseNewsMonitor(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				message: 'News monitor analysis paused',
				paused: true,
				reason: 'Binance maintenance',
				pausedAt: expect.any(String),
			}));
		});

		it('postResumeNewsMonitor returns 200 with resume status', async () => {
			pauseNewsMonitor({ reason: 'Test' });
			const req = {};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			await postResumeNewsMonitor(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				message: 'News monitor analysis resumed',
				paused: false,
				resumedAt: expect.any(String),
			}));
		});

		it('getNewsMonitorStatus returns 200 with current state', async () => {
			pauseNewsMonitor({ reason: 'Maintenance' });
			const req = {};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			await getNewsMonitorStatus(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith({
				paused: true,
				pausedAt: expect.any(String),
				reason: 'Maintenance',
			});
		});
	});

	describe('Firestore Distributed Persistence (ENABLE_FIRESTORE_NEWS_MONITOR_PAUSE=true)', () => {
		beforeEach(() => {
			process.env.ENABLE_FIRESTORE_NEWS_MONITOR_PAUSE = 'true';
			process.env.NEWS_MONITOR_PAUSE_CACHE_TTL_MS = '500';
		});

		it('persists pause state to Firestore when pausing', async () => {
			const mockDb = buildMockFirestore();
			setFirestoreForTest(mockDb);

			const result = await pauseNewsMonitor({ reason: 'Rate limit emergency' });

			expect(result.paused).toBe(true);
			expect(result.reason).toBe('Rate limit emergency');
			expect(mockDb._docRef.set).toHaveBeenCalledTimes(1);
			expect(mockDb._docRef.set).toHaveBeenCalledWith(
				expect.objectContaining({
					paused: true,
					reason: 'Rate limit emergency',
					pausedAt: expect.any(String),
					updatedAt: expect.any(String),
				}),
				{ merge: true }
			);
			expect(mockDb._getStore().paused).toBe(true);
		});

		it('persists resume state to Firestore when resuming', async () => {
			const mockDb = buildMockFirestore({
				paused: true,
				pausedAt: '2026-11-09T00:00:00.000Z',
				reason: 'Previous pause',
			});
			setFirestoreForTest(mockDb);

			await syncNewsMonitorPauseState({ force: true });
			expect(isNewsMonitorPaused()).toBe(true);

			const result = await resumeNewsMonitor();

			expect(result.paused).toBe(false);
			expect(result.wasPaused).toBe(true);
			expect(mockDb._docRef.set).toHaveBeenCalledWith(
				expect.objectContaining({
					paused: false,
					pausedAt: null,
					reason: null,
					resumedAt: expect.any(String),
					updatedAt: expect.any(String),
				}),
				{ merge: true }
			);
			expect(mockDb._getStore().paused).toBe(false);
		});

		it('syncs remote pause state with TTL caching', async () => {
			const mockDb = buildMockFirestore({
				paused: true,
				pausedAt: '2026-11-09T01:00:00.000Z',
				reason: 'Remote incident pause',
			});
			setFirestoreForTest(mockDb);

			// First sync reads Firestore
			const state1 = await syncNewsMonitorPauseState({ force: true });
			expect(state1.paused).toBe(true);
			expect(state1.reason).toBe('Remote incident pause');
			expect(mockDb._docRef.get).toHaveBeenCalledTimes(1);

			// Update remote store
			mockDb._setStore({
				paused: false,
				pausedAt: null,
				reason: null,
			});

			// Second sync within TTL uses cache
			const state2 = await syncNewsMonitorPauseState();
			expect(state2.paused).toBe(true);
			expect(mockDb._docRef.get).toHaveBeenCalledTimes(1);

			// Forced sync bypasses TTL and sees the update
			const state3 = await syncNewsMonitorPauseState({ force: true });
			expect(state3.paused).toBe(false);
			expect(mockDb._docRef.get).toHaveBeenCalledTimes(2);
		});

		it('fails open when Firestore read throws an error without crashing', async () => {
			const mockDb = buildMockFirestore();
			mockDb._docRef.get = jest.fn().mockRejectedValue(new Error('Firestore unavailable (DEADLINE_EXCEEDED)'));
			setFirestoreForTest(mockDb);

			pauseNewsMonitor({ reason: 'Initial local pause' });
			expect(isNewsMonitorPaused()).toBe(true);

			// Sync attempts to read but throws; fail-open retains local state and does not reject
			await expect(syncNewsMonitorPauseState({ force: true })).resolves.toEqual(
				expect.objectContaining({
					paused: true,
					reason: 'Initial local pause',
				})
			);
			expect(isNewsMonitorPaused()).toBe(true);
		});

		it('fails open when Firestore write throws an error without crashing', async () => {
			const mockDb = buildMockFirestore();
			mockDb._docRef.set = jest.fn().mockRejectedValue(new Error('Permission denied on set'));
			setFirestoreForTest(mockDb);

			// Pausing still succeeds locally and does not crash
			const result = await pauseNewsMonitor({ reason: 'Local write attempt' });
			expect(result.paused).toBe(true);
			expect(isNewsMonitorPaused()).toBe(true);
		});

		it('HTTP handlers update and retrieve shared Firestore state', async () => {
			const mockDb = buildMockFirestore();
			setFirestoreForTest(mockDb);

			const pauseReq = { body: { reason: 'Shared pause via HTTP' } };
			const pauseRes = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};
			await postPauseNewsMonitor(pauseReq, pauseRes);
			expect(pauseRes.status).toHaveBeenCalledWith(200);
			expect(mockDb._getStore().paused).toBe(true);

			const statusReq = {};
			const statusRes = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};
			await getNewsMonitorStatus(statusReq, statusRes);
			expect(statusRes.status).toHaveBeenCalledWith(200);
			expect(statusRes.json).toHaveBeenCalledWith(expect.objectContaining({
				paused: true,
				reason: 'Shared pause via HTTP',
			}));
		});
	});
});
