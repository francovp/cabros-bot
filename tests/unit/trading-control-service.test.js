'use strict';

jest.mock('firebase-admin', () => {
	const firestoreDoc = jest.fn();
	const firestoreCollection = jest.fn();
	return {
		apps: [],
		credential: { cert: jest.fn() },
		initializeApp: jest.fn(),
		firestore: jest.fn(() => ({
			doc: firestoreDoc,
			collection: firestoreCollection,
		})),
		_firestoreDoc: firestoreDoc,
		_firestoreCollection: firestoreCollection,
	};
});

jest.mock('../../src/services/storage/firestoreConfig', () => ({
	isFirestoreConfigured: jest.fn(() => true),
}));

const admin = require('firebase-admin');
const firestoreConfig = require('../../src/services/storage/firestoreConfig');
const {
	createTradingControlService,
	TradingControlError,
	TradingControlState,
	STATE_DOC_PATH,
} = require('../../src/services/trading/TradingControlService');

function makeFirestoreMock({ doc, collection } = {}) {
	const docApi = doc || {
		get: jest.fn(),
		set: jest.fn(),
	};
	const firestore = { doc: jest.fn(() => docApi), collection: jest.fn() };
	return { firestore, docApi };
}

function freezeTime(timestamp) {
	let current = timestamp;
	return {
		now: () => current,
		advance(ms) { current = new Date(new Date(current).getTime() + ms).toISOString(); },
	};
}

describe('TradingControlService', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		delete process.env.ENABLE_BINANCE_TRADING;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete process.env.FIREBASE_PROJECT_ID;
		jest.restoreAllMocks();
		admin.apps.length = 0;
		admin.initializeApp.mockReset();
		admin.credential.cert.mockReset();
		admin.firestore.mockReset();
		firestoreConfig.isFirestoreConfigured.mockReturnValue(true);
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	it('isBlocked() fails closed only when trading is enabled and state is unavailable', () => {
		const openState = new TradingControlState({ paused: false, unavailable: false, inactive: false });
		expect(openState.isBlocked()).toBe(false);

		const pausedState = new TradingControlState({ paused: true, unavailable: false, inactive: false });
		expect(pausedState.isBlocked()).toBe(true);

		const unavailableActive = new TradingControlState({ paused: false, unavailable: true, inactive: false });
		expect(unavailableActive.isBlocked()).toBe(true);

		const unavailableInactive = new TradingControlState({ paused: false, unavailable: true, inactive: true });
		expect(unavailableInactive.isBlocked()).toBe(false);
	});

	it('returns an inactive state when trading is disabled, even with prior pause memory', async () => {
		const service = createTradingControlService({
			firestoreFactory: () => { throw new Error('should not initialize'); },
		});
		// Pre-seed memory as if a previous run had paused.
		service._setMemoryStateForTesting({
			paused: true,
			pausedBy: 'previous',
			pausedAt: '2026-01-01T00:00:00Z',
			pausedReason: 'previous',
			lastChangedAt: '2026-01-01T00:00:00Z',
			lastChangedBy: 'previous',
			lastAction: 'pause',
		});
		process.env.ENABLE_BINANCE_TRADING = 'false';

		const snapshot = await service.getPauseState();
		expect(snapshot).toMatchObject({
			paused: false,
			inactive: true,
			storage: 'memory',
		});
		expect(snapshot.isBlocked()).toBe(false);
	});

	it('fails closed when trading is enabled but Firestore is not configured', async () => {
		firestoreConfig.isFirestoreConfigured.mockReturnValue(false);
		process.env.ENABLE_BINANCE_TRADING = 'true';

		const service = createTradingControlService({
			firestoreFactory: () => { throw new Error('must not be invoked'); },
		});

		const snapshot = await service.getPauseState();
		expect(snapshot).toMatchObject({
			paused: false,
			unavailable: true,
			inactive: false,
			storage: 'memory',
		});
		expect(snapshot.isBlocked()).toBe(true);
	});

	it('fails closed when the Firestore pause-state read times out', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'true';
		const { firestore, docApi } = makeFirestoreMock({
			doc: {
				get: jest.fn(() => new Promise(() => {})),
				set: jest.fn(),
			},
		});
		const service = createTradingControlService({ firestoreFactory: () => firestore });
		jest.useFakeTimers();

		try {
			const pending = service.getPauseState();
			await jest.advanceTimersByTimeAsync(5000);
			const snapshot = await pending;

			expect(snapshot).toMatchObject({
				paused: false,
				unavailable: true,
				inactive: false,
			});
			expect(docApi.get).toHaveBeenCalledTimes(1);
		} finally {
			jest.useRealTimers();
		}
	});

	it('reads paused state from Firestore when configured and trading is enabled', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'true';
		const { firestore, docApi } = makeFirestoreMock({
			doc: {
				get: jest.fn().mockResolvedValue({
					exists: true,
					data: () => ({
						paused: true,
						pausedBy: 'ops-user',
						pausedAt: '2026-02-01T00:00:00Z',
						pausedReason: 'incident response',
						lastChangedAt: '2026-02-01T00:00:00Z',
						lastChangedBy: 'ops-user',
						lastAction: 'pause',
					}),
				}),
				set: jest.fn(),
			},
		});

		const service = createTradingControlService({
			firestoreFactory: () => firestore,
			now: () => '2026-02-01T00:01:00Z',
		});

		const snapshot = await service.getPauseState();
		expect(snapshot).toMatchObject({
			paused: true,
			pausedBy: 'ops-user',
			pausedReason: 'incident response',
			storage: 'firestore',
			unavailable: false,
		});
		expect(docApi.get).toHaveBeenCalledTimes(1);
	});

	it('writes the pause state to Firestore with the actor and timestamp', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'true';
		const { firestore, docApi } = makeFirestoreMock({
			doc: {
				get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
				set: jest.fn().mockResolvedValue(undefined),
			},
		});
		const clock = freezeTime('2026-03-01T10:00:00Z');

		const service = createTradingControlService({
			firestoreFactory: () => firestore,
			now: clock.now,
		});

		const snapshot = await service.pause({
			actor: 'ops-user',
			reason: 'credential rotation',
		});

		expect(docApi.set).toHaveBeenCalledWith(expect.objectContaining({
			paused: true,
			pausedBy: 'ops-user',
			pausedAt: '2026-03-01T10:00:00Z',
			pausedReason: 'credential rotation',
			lastAction: 'pause',
		}), { merge: false });
		expect(snapshot).toMatchObject({
			paused: true,
			pausedBy: 'ops-user',
			storage: 'firestore',
		});
	});

	it('trims and bounds long actor names and reasons', () => {
		const service = createTradingControlService({
			firestoreFactory: () => { throw new Error('not used'); },
		});

		expect(service.normalizeActor('   ')).toBe('unknown');
		expect(service.normalizeActor('  short  ')).toBe('short');
		expect(service.normalizeActor('a'.repeat(200))).toHaveLength(80);

		expect(service.normalizeReason(null)).toBeNull();
		expect(service.normalizeReason('   ')).toBeNull();
		expect(service.normalizeReason(123)).toBeNull();
		expect(service.normalizeReason('  ok  ')).toBe('ok');
		expect(service.normalizeReason('x'.repeat(500))).toHaveLength(280);
	});

	it('returns 409 TRADING_DISABLED when pause is invoked while trading is disabled', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'false';
		const service = createTradingControlService({
			firestoreFactory: () => { throw new Error('not used'); },
		});

		await expect(service.pause({ actor: 'ops-user', reason: 'test' }))
			.rejects.toMatchObject({
				code: 'TRADING_DISABLED',
				statusCode: 409,
			});
	});

	it('returns 503 TRADING_CONTROL_UNAVAILABLE when pause state is unreadable and trading is enabled', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'true';
		const { firestore, docApi } = makeFirestoreMock({
			doc: {
				get: jest.fn().mockRejectedValue(new Error('firestore offline')),
				set: jest.fn(),
			},
		});
		const service = createTradingControlService({
			firestoreFactory: () => firestore,
		});

		await expect(service.pause({ actor: 'ops-user', reason: 'test' }))
			.rejects.toMatchObject({
				code: 'TRADING_CONTROL_UNAVAILABLE',
				statusCode: 503,
			});
		expect(docApi.get).toHaveBeenCalledTimes(1);
	});

	it('resume() restores prior behavior and writes a resume record', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'true';
		const { firestore, docApi } = makeFirestoreMock({
			doc: {
				get: jest.fn().mockResolvedValue({
					exists: true,
					data: () => ({
						paused: true,
						pausedBy: 'ops-user',
						pausedAt: '2026-04-01T00:00:00Z',
						pausedReason: 'investigation',
						lastChangedAt: '2026-04-01T00:00:00Z',
						lastChangedBy: 'ops-user',
						lastAction: 'pause',
					}),
				}),
				set: jest.fn().mockResolvedValue(undefined),
			},
		});
		const clock = freezeTime('2026-04-01T01:00:00Z');
		const service = createTradingControlService({
			firestoreFactory: () => firestore,
			now: clock.now,
		});

		const snapshot = await service.resume({
			actor: 'ops-user',
			reason: 'mitigation applied',
		});

		expect(docApi.set).toHaveBeenCalledWith(expect.objectContaining({
			paused: false,
			resumedBy: 'ops-user',
			resumedAt: '2026-04-01T01:00:00Z',
			pausedBy: null,
			lastAction: 'resume',
		}), { merge: false });
		expect(snapshot).toMatchObject({
			paused: false,
			resumedBy: 'ops-user',
			storage: 'firestore',
		});
	});

	it('falls back to memory storage when Firestore cannot be initialized and trading is disabled', async () => {
		// When trading is disabled, the pause state lives in memory only.
		process.env.ENABLE_BINANCE_TRADING = 'false';
		firestoreConfig.isFirestoreConfigured.mockReturnValue(false);
		const service = createTradingControlService({
			firestoreFactory: () => { throw new Error('not used'); },
		});

		const snapshot = await service.getPauseState();
		expect(snapshot).toMatchObject({
			paused: false,
			inactive: true,
			storage: 'memory',
		});
		expect(service.getStatus().storage).toBe('memory');
	});

	it('refuses to update pause state when Firestore initialization fails and trading is enabled', async () => {
		process.env.ENABLE_BINANCE_TRADING = 'true';
		firestoreConfig.isFirestoreConfigured.mockReturnValue(true);
		const service = createTradingControlService({
			firestoreFactory: () => null,
		});

		await expect(service.pause({ actor: 'ops-user', reason: 'test' }))
			.rejects.toMatchObject({
				code: 'TRADING_CONTROL_UNAVAILABLE',
				statusCode: 503,
			});
	});

	it('readAction and readReason tolerate malformed bodies', () => {
		const service = createTradingControlService({
			firestoreFactory: () => { throw new Error('not used'); },
		});
		expect(service.readAction(null)).toBeNull();
		expect(service.readAction({ action: 'PAUSE' })).toBe('pause');
		expect(service.readAction({ action: 'invalid' })).toBeNull();
		expect(service.readAction({ action: 123 })).toBeNull();
		expect(service.readAction({ action: 'resume' })).toBe('resume');

		expect(service.readReason({})).toBeNull();
		expect(service.readReason({ reason: 'okay' })).toBe('okay');
		expect(service.readReason({ pauseReason: 'r' })).toBe('r');
		expect(service.readReason({ reason: 1 })).toBeNull();
		expect(service.readReason({ resumeReason: '  ' })).toBeNull();
	});

	it('getStatus() reflects the in-memory state for operator surfaces', () => {
		const service = createTradingControlService({
			firestoreFactory: () => null,
		});
		service._setMemoryStateForTesting({
			paused: true,
			pausedBy: 'ops-user',
			pausedAt: '2026-05-01T00:00:00Z',
			pausedReason: 'manual',
			lastChangedAt: '2026-05-01T00:00:00Z',
			lastChangedBy: 'ops-user',
			lastAction: 'pause',
		});

		const status = service.getStatus();
		expect(status).toMatchObject({
			enabled: false,
			storage: 'memory',
			paused: true,
			pausedBy: 'ops-user',
			lastAction: 'pause',
		});
		expect(status.firestoreReady).toBe(false);
	});
});

describe('TradingControlError', () => {
	it('carries code and statusCode', () => {
		const error = new TradingControlError('test', 'TEST_CODE', 418);
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe('TEST_CODE');
		expect(error.statusCode).toBe(418);
		expect(error.message).toBe('test');
		expect(error.name).toBe('TradingControlError');
	});
});
