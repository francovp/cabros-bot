'use strict';

// Covers the distributed sweep lease added for GH-1110.
//
// `render.yaml` declares two candidate evaluators for signal outcomes: the web
// service (`SIGNAL_OUTCOME_WORKER_ROLE=web`) and the dedicated paid worker
// `cabros-crypto-bot-signal-outcome-worker` (`SIGNAL_OUTCOME_WORKER_ROLE=worker`).
// Before this lease, "which process evaluates?" was decided entirely by the
// `ENABLE_SIGNAL_OUTCOME_TRACKING` value on each service, and that value is a
// dashboard-managed (`sync: false`) variable on the dedicated worker. Turning the
// flag on therefore made double evaluation a deployment accident, and a second
// evaluator re-prices and re-writes every pending signal, doubling Binance /
// Gemini / Twelve Data quota spend (see GH-284 for the quota incident history).
//
// The invariant these tests protect: exactly one evaluator acts on a pending
// signal, regardless of role or replica topology, and a lease failure never
// silently disables evaluation.

const admin = require('firebase-admin');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

const mockGetKlines = jest.fn();
jest.mock('binance', () => {
	return {
		MainClient: jest.fn().mockImplementation(() => {
			return {
				getKlines: mockGetKlines,
			};
		}),
	};
});

const LOCK_COLLECTION = 'signalOutcomeLocks';

const { LEASE_RENEWAL } = SignalOutcomeService;

// Builds a Firestore double that supports the transaction-backed lease while
// delegating every other collection operation to the shared firebase-admin mock.
// `lockState` is shared by reference so a test can simulate a second replica
// holding (or having released) the lease.
function createLeaseAwareFirestore(lockState, options = {}) {
	const base = AlertStorageService.getFirestore();

	const docRef = {
		get: async () => ({
			exists: Object.keys(lockState).length > 0,
			data: () => ({ ...lockState }),
		}),
		set: async (data, setOptions) => {
			if (!setOptions || setOptions.merge !== true) {
				Object.keys(lockState).forEach((key) => delete lockState[key]);
			}
			Object.assign(lockState, data);
			return { id: 'singleton' };
		},
	};

	const runTransaction = options.transactionError
		? async () => {
			throw new Error(options.transactionError);
		}
		: async (callback) => callback({
			get: async () => docRef.get(),
			set: async (ref, data, setOptions) => docRef.set(data, setOptions),
		});

	return {
		...base,
		collection: (name) => {
			if (name === LOCK_COLLECTION) {
				return { doc: () => docRef };
			}
			return base.collection(name);
		},
		runTransaction,
	};
}

function seedPendingSignal(id, overrides = {}) {
	const past = new Date(Date.now() - 3600000);
	return [id, {
		receivedAt: admin.firestore.Timestamp.fromDate(past),
		symbol: 'BTCUSDT',
		exchange: 'BINANCE',
		side: 'BUY',
		price: 50000,
		outcomeEvaluated: false,
		outcomes: {
			'1h': {
				status: 'pending',
				targetTime: new Date(Date.now() - 1000).toISOString(),
			},
		},
		...overrides,
	}];
}

describe('SignalOutcomeService distributed sweep lease', () => {
	let lockState;

	beforeEach(() => {
		jest.clearAllMocks();
		admin.__resetApps();
		admin.__resetCollectionState();
		AlertStorageService._resetForTesting();
		remoteConfigService._resetForTesting();
		SignalOutcomeService.stopWorker();
		SignalOutcomeService._resetForTesting();
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS;
		lockState = {};
		mockGetKlines.mockResolvedValue([
			[1600000000000, '50000', '51000', '49500', '50500', '100'],
		]);
	});

	afterEach(() => {
		SignalOutcomeService.stopWorker();
		jest.restoreAllMocks();
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.SIGNAL_OUTCOME_WORKER_ROLE;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS;
		delete process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS;
	});

	function enableTracking() {
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'web';
	}

	describe('single-evaluator invariant', () => {
		it('skips the sweep and makes no provider calls while another replica holds the lease', async () => {
			enableTracking();
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_1')]),
			);

			// A different replica holds a live lease.
			lockState.lockedBy = 'other-replica-worker-id';
			lockState.lockedUntil = new Date(Date.now() + 60000).toISOString();

			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			const result = await SignalOutcomeService.evaluatePendingOutcomes();

			expect(result.skipped).toBe(true);
			expect(result.reason).toBe('lease-held');
			expect(result.evaluatedCount).toBe(0);
			// The whole point: a losing replica must not re-price the signal.
			expect(mockGetKlines).not.toHaveBeenCalled();

			const status = SignalOutcomeService.getWorkerStatus();
			expect(status.leaseHeldSkipCount).toBe(1);
			expect(status.lastRunLeaseHeld).toBe(true);
		});

		it('evaluates and releases the lease so the next sweep can acquire it again', async () => {
			enableTracking();
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_1')]),
			);

			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			const first = await SignalOutcomeService.evaluatePendingOutcomes();

			expect(first.skipped).toBeUndefined();
			expect(first.evaluatedCount).toBe(1);
			expect(mockGetKlines).toHaveBeenCalledTimes(1);
			// Released: the lock must not be left behind to deadlock the sweep.
			expect(lockState.lockedBy).toBeNull();
			expect(lockState.lockedUntil).toBeNull();
			expect(SignalOutcomeService.getWorkerStatus().lastRunLeaseHeld).toBe(false);

			// A second matured signal proves the released lease is re-acquirable.
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_2')]),
			);

			const second = await SignalOutcomeService.evaluatePendingOutcomes();
			expect(second.skipped).toBeUndefined();
			expect(second.evaluatedCount).toBe(1);
		});

		it('takes over an expired lease instead of skipping forever', async () => {
			enableTracking();
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_1')]),
			);

			lockState.lockedBy = 'dead-replica';
			lockState.lockedUntil = new Date(Date.now() - 1000).toISOString();

			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			const result = await SignalOutcomeService.evaluatePendingOutcomes();

			expect(result.skipped).toBeUndefined();
			expect(result.evaluatedCount).toBe(1);
			expect(mockGetKlines).toHaveBeenCalledTimes(1);
		});

		it('does not release or overwrite a lease that another replica has since taken', async () => {
			enableTracking();
			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			await SignalOutcomeService.acquireSweepLease(Date.now(), 60000);
			expect(lockState.lockedBy).toBeTruthy();

			// Another replica steals the lease mid-sweep.
			lockState.lockedBy = 'other-replica-worker-id';
			lockState.lockedUntil = new Date(Date.now() + 60000).toISOString();

			await SignalOutcomeService.releaseSweepLease(Date.now());

			expect(lockState.lockedBy).toBe('other-replica-worker-id');
		});
	});

	describe('fail-open behaviour', () => {
		it('still evaluates when the lease transaction throws', async () => {
			enableTracking();
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_1')]),
			);

			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState, { transactionError: 'lease-unavailable' }));

			const result = await SignalOutcomeService.evaluatePendingOutcomes();

			// A lease blip must never permanently disable outcome evaluation.
			expect(result.skipped).toBeUndefined();
			expect(result.evaluatedCount).toBe(1);
			expect(mockGetKlines).toHaveBeenCalledTimes(1);
		});

		it('acquires the lease without a transaction-capable Firestore (unit doubles)', async () => {
			enableTracking();
			// The shared firebase-admin mock exposes no runTransaction.
			const firestore = AlertStorageService.getFirestore();
			expect(typeof firestore.runTransaction).toBe('undefined');

			await expect(SignalOutcomeService.acquireSweepLease(Date.now(), 60000)).resolves.toBe(true);
		});

		it('reports tracking disabled without touching Firestore', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'false';
			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			const result = await SignalOutcomeService.evaluatePendingOutcomes();

			expect(result).toEqual({ scannedCount: 0, evaluatedCount: 0, skipped: true, reason: 'disabled' });
			expect(mockGetKlines).not.toHaveBeenCalled();
		});
	});

	describe('renewSweepLease()', () => {
		it('extends the lease it still owns', async () => {
			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			await expect(SignalOutcomeService.acquireSweepLease(Date.now(), 60000)).resolves.toBe(true);
			const acquiredUntil = lockState.lockedUntil;

			await expect(SignalOutcomeService.renewSweepLease(Date.now() + 30000, 60000))
				.resolves.toBe(LEASE_RENEWAL.ACQUIRED);

			// Pushed out, so a long sweep is not taken over while it is still working.
			expect(lockState.lockedUntil).not.toBe(acquiredUntil);
			expect(new Date(lockState.lockedUntil).getTime()).toBeGreaterThan(
				new Date(acquiredUntil).getTime(),
			);
		});

		it('reports ownership lost when another replica now holds the lease', async () => {
			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			lockState.lockedBy = 'other-replica-worker-id';
			lockState.lockedUntil = new Date(Date.now() + 60000).toISOString();
			const stolenUntil = lockState.lockedUntil;

			await expect(SignalOutcomeService.renewSweepLease(Date.now(), 60000))
				.resolves.toBe(LEASE_RENEWAL.LOST);

			// Nothing written: the losing replica must not rewrite the winner's lock.
			expect(lockState.lockedBy).toBe('other-replica-worker-id');
			expect(lockState.lockedUntil).toBe(stolenUntil);
		});

		it('reports ownership lost when the lease document no longer exists', async () => {
			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			// The acquire path creates the document, so a missing one mid-sweep is
			// external interference and ownership cannot be proven.
			await expect(SignalOutcomeService.renewSweepLease(Date.now(), 60000))
				.resolves.toBe(LEASE_RENEWAL.LOST);
		});

		it.each([
			['no Firestore at all', null],
			['a Firestore without transaction support', {}],
		])('stays undetermined with %s', async (_label, firestore) => {
			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(firestore);

			// Deliberately not LOST: an unchecked lease is not proof of ownership
			// loss, and failing closed here would let a Firestore blip stop
			// outcome evaluation entirely.
			await expect(SignalOutcomeService.renewSweepLease(Date.now(), 60000))
				.resolves.toBe(LEASE_RENEWAL.UNDETERMINED);
		});

		it('stays undetermined when the lease transaction throws', async () => {
			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState, { transactionError: 'lease-unavailable' }));

			await expect(SignalOutcomeService.renewSweepLease(Date.now(), 60000))
				.resolves.toBe(LEASE_RENEWAL.UNDETERMINED);
		});
	});

	describe('mid-sweep ownership loss', () => {
		it('stops acting on signals once a renewal proves the lease is gone', async () => {
			enableTracking();
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_1'), seedPendingSignal('sig_2')]),
			);

			const firestore = createLeaseAwareFirestore(lockState);
			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(firestore);

			// Slow the first document long enough for the renewal to land.
			let call = 0;
			mockGetKlines.mockImplementation(() => {
				call += 1;
				return new Promise((resolve) => {
					setTimeout(() => resolve([
						[1600000000000, '50000', '51000', '49500', '50500', '100'],
					]), call === 1 ? 60 : 0);
				});
			});

			// Another replica takes the lease while this sweep is pricing sig_1.
			setTimeout(() => {
				lockState.lockedBy = 'other-replica-worker-id';
				lockState.lockedUntil = new Date(Date.now() + 60000).toISOString();
			}, 20);

			const result = await SignalOutcomeService.evaluatePendingOutcomes({
				leaseMs: 60000,
				leaseRenewIntervalMs: 30,
			});

			// sig_1 finished before ownership was lost; sig_2 must not be touched.
			expect(result.evaluatedCount).toBe(1);
			expect(mockGetKlines).toHaveBeenCalledTimes(1);

			// The sweep is reported as not having run as the lease holder, even
			// though it did evaluate one signal before losing ownership.
			const status = SignalOutcomeService.getWorkerStatus();
			expect(status.lastRunLeaseHeld).toBe(true);
			expect(status.leaseHeldSkipCount).toBe(1);
			expect(status.lastRunEvaluatedCount).toBe(1);

			// The winner's lock is never cleared by the losing replica.
			expect(lockState.lockedBy).toBe('other-replica-worker-id');
		});

		it('keeps the sweep result unchanged while the renewal keeps succeeding', async () => {
			enableTracking();
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_1')]),
			);

			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			const result = await SignalOutcomeService.evaluatePendingOutcomes({
				leaseMs: 60000,
				leaseRenewIntervalMs: 30,
			});

			expect(result.evaluatedCount).toBe(1);
			const status = SignalOutcomeService.getWorkerStatus();
			expect(status.lastRunLeaseHeld).toBe(false);
			expect(status.leaseHeldSkipCount).toBe(0);
			expect(lockState.lockedBy).toBeNull();
		});
	});

	describe('lease duration configuration', () => {
		it('defaults to a lease that covers the sweep budget', () => {
			expect(SignalOutcomeService.getLeaseMs()).toBe(120000);
		});

		it('accepts an in-range configured lease', () => {
			process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS = '45000';
			expect(SignalOutcomeService.getLeaseMs()).toBe(45000);
		});

		it.each([
			['0', 'zero'],
			['-1', 'negative'],
			['not-a-number', 'non-numeric'],
			['5000', 'below the 10s floor'],
			['900000', 'above the 600s ceiling'],
		])('falls back to the default for %s (%s)', (raw) => {
			process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS = raw;
			expect(SignalOutcomeService.getLeaseMs()).toBe(120000);
		});

		it('accepts the documented boundaries', () => {
			process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS = '10000';
			expect(SignalOutcomeService.getLeaseMs()).toBe(10000);

			process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS = '600000';
			expect(SignalOutcomeService.getLeaseMs()).toBe(600000);
		});

		it('warns at startup when the lease does not outlast the sweep budget', () => {
			enableTracking();
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
			process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS = '10000';
			process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS = '30000';

			SignalOutcomeService.startWorker({ source: 'web', intervalMs: 60000 });

			expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not exceed the sweep duration budget'));
		});

		it('stays silent at startup when the lease outlasts the sweep budget', () => {
			enableTracking();
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
			process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS = '120000';
			process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS = '30000';

			SignalOutcomeService.startWorker({ source: 'web', intervalMs: 60000 });

			expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('does not exceed the sweep duration budget'));
		});
	});

	describe('scheduled worker', () => {
		it('reports a lease-held sweep through the worker status contract', async () => {
			enableTracking();
			global.__firebaseAdminMockState.collections.set(
				SignalOutcomeService.COLLECTION_NAME,
				new Map([seedPendingSignal('sig_1')]),
			);
			lockState.lockedBy = 'other-replica-worker-id';
			lockState.lockedUntil = new Date(Date.now() + 60000).toISOString();

			jest.spyOn(AlertStorageService, 'getFirestore')
				.mockReturnValue(createLeaseAwareFirestore(lockState));

			const statusBefore = SignalOutcomeService.getWorkerStatus();
			expect(statusBefore.leaseHeldSkipCount).toBe(0);
			expect(statusBefore.leaseMs).toBe(120000);

			await SignalOutcomeService.evaluatePendingOutcomes();

			const statusAfter = SignalOutcomeService.getWorkerStatus();
			expect(statusAfter.lastRunLeaseHeld).toBe(true);
			expect(statusAfter.leaseHeldSkipCount).toBe(1);
			// A skipped sweep must not look like a productive one.
			expect(statusAfter.lastRunEvaluatedCount).toBe(0);
		});
	});
});