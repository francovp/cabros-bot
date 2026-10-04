'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const {
	isEnabled,
	isReady,
	hashKey,
	getStorageStatus,
	reserveEntry,
	setEntry,
	releaseEntry,
	getEntry,
	waitForPendingCompletion,
	REASONS,
	_resetForTesting,
} = require('../../src/services/storage/IdempotencyStorageService');

describe('IdempotencyStorageService', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		Object.keys(process.env).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);
		_resetForTesting();
		jest.restoreAllMocks();
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);
	});

	test('hashKey should generate a deterministic SHA-256 hex string and never include raw key', () => {
		const rawKey = 'user-secret-idempotency-key-12345';
		const hashed = hashKey(rawKey);

		expect(typeof hashed).toBe('string');
		expect(hashed).toHaveLength(64);
		expect(hashed).not.toContain(rawKey);
		expect(hashKey(rawKey)).toBe(hashed);
		expect(hashKey('different-key')).not.toBe(hashed);
	});

	test('isEnabled should return true only when ENABLE_FIRESTORE_IDEMPOTENCY is true', () => {
		delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY;
		delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE;
		expect(isEnabled()).toBe(false);

		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';
		expect(isEnabled()).toBe(false);

		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		expect(isEnabled()).toBe(true);

		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE = 'true';
		expect(isEnabled()).toBe(true);
	});

	test('getStorageStatus should correctly reflect ephemeral vs durable state', () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';
		const statusEphemeral = getStorageStatus();
		expect(statusEphemeral.enabled).toBe(false);
		expect(statusEphemeral.mode).toBe('ephemeral');
		expect(statusEphemeral.backend).toBe('memory');

		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		const statusDurable = getStorageStatus();
		expect(statusDurable.enabled).toBe(true);
		expect(statusDurable.mode).toBe('ephemeral'); // since firebase app not initialized in test env
	});

	test('reserveEntry should fail open when disabled or Firestore unavailable', async () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';

		const res = await reserveEntry('test-key', 'hash123', 300000);
		expect(res).toBeNull();
	});

	test('setEntry and releaseEntry should handle disabled state safely', async () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';

		await expect(setEntry('test-key', 'hash123', { statusCode: 200, body: 'ok' }, 300000)).resolves.toBeUndefined();
		await expect(releaseEntry('test-key', 'hash123')).resolves.toBeUndefined();
		await expect(getEntry('test-key', 'hash123')).resolves.toBeNull();
	});

	test('waitForPendingCompletion should handle disabled state safely', async () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';

		const res = await waitForPendingCompletion('test-key', 'hash123', 500, 100);
		expect(res).toEqual({ state: 'released' });
	});

	test('COLLECTION_NAME should be idempotency_keys matching documented collection name', () => {
		const storageModule = require('../../src/services/storage/IdempotencyStorageService');
		expect(storageModule.COLLECTION_NAME).toBe('idempotency_keys');
	});

	test('setEntry should strip undefined header values when writing to Firestore', async () => {
		_resetForTesting();
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
		});
		const setMock = jest.fn().mockResolvedValue({});
		const transactionSetMock = jest.fn();
		const transactionMock = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({ state: 'pending', payloadHash: 'hash123', claimToken: 'claim-token' }),
			}),
			set: transactionSetMock,
		};
		const docMock = jest.fn().mockReturnValue({ set: setMock });
		const collectionMock = jest.fn().mockReturnValue({ doc: docMock });
		const firestoreMock = {
			collection: collectionMock,
			runTransaction: jest.fn(async (callback) => callback(transactionMock)),
		};
		const firestoreFn = jest.fn().mockReturnValue(firestoreMock);
		jest.spyOn(admin, 'firestore').mockImplementation(firestoreFn);
		admin.firestore.Timestamp = { fromMillis: (ms) => ms };
		jest.spyOn(admin.credential, 'cert').mockReturnValue({});
		jest.spyOn(admin, 'initializeApp').mockReturnValue({});

		await setEntry('test-key', 'hash123', {
			statusCode: 200,
			body: { ok: true },
			headers: { 'content-type': 'application/json', undefinedHeader: undefined },
		}, 300000, 'claim-token');

		expect(collectionMock).toHaveBeenCalledWith('idempotency_keys');
		expect(transactionSetMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			headers: { 'content-type': 'application/json' },
		}));
		expect(setMock).not.toHaveBeenCalled();
	});

	test('reserveEntry should protect live pending claims even when replay TTL has expired', async () => {
		_resetForTesting();
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
		});

		const nowMs = Date.now();
		const mockData = {
			state: 'pending',
			payloadHash: 'hash123',
			createdAt: { toMillis: () => nowMs - 5000 },
			expiresAt: { toMillis: () => nowMs - 1000 }, // Expired replay TTL
		};

		const transactionMock = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => mockData,
			}),
			set: jest.fn(),
		};

		const docMock = jest.fn().mockReturnValue({});
		const collectionMock = jest.fn().mockReturnValue({ doc: docMock });
		const firestoreMock = {
			collection: collectionMock,
			runTransaction: jest.fn(async (cb) => cb(transactionMock)),
		};

		jest.spyOn(admin, 'firestore').mockReturnValue(firestoreMock);
		admin.firestore.Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };
		jest.spyOn(admin.credential, 'cert').mockReturnValue({});
		jest.spyOn(admin, 'initializeApp').mockReturnValue({});

		const result = await reserveEntry('test-key', 'hash123', 2000);

		expect(result).toEqual({ state: 'pending', record: mockData });
		expect(transactionMock.set).not.toHaveBeenCalled();
	});

	test('reserveEntry should overwrite expired completed records and stale pending claims', async () => {
		_resetForTesting();
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
		});

		const nowMs = Date.now();
		const stalePendingData = {
			state: 'pending',
			payloadHash: 'hash123',
			createdAt: { toMillis: () => nowMs - 200000 }, // Stale (> 180000ms)
			expiresAt: { toMillis: () => nowMs + 10000 },
		};

		const transactionMock = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => stalePendingData,
			}),
			set: jest.fn(),
		};

		const docMock = jest.fn().mockReturnValue({});
		const collectionMock = jest.fn().mockReturnValue({ doc: docMock });
		const firestoreMock = {
			collection: collectionMock,
			runTransaction: jest.fn(async (cb) => cb(transactionMock)),
		};

		jest.spyOn(admin, 'firestore').mockReturnValue(firestoreMock);
		admin.firestore.Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };
		jest.spyOn(admin.credential, 'cert').mockReturnValue({});
		jest.spyOn(admin, 'initializeApp').mockReturnValue({});

		const result = await reserveEntry('test-key', 'hash123', 5000);

		expect(result).toMatchObject({ state: 'fresh', claimToken: expect.any(String) });
		expect(transactionMock.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
		claimToken: result.claimToken,
	}));
	});

	test('setEntry should ignore a late completion after the reservation token was reclaimed', async () => {
		_resetForTesting();
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
		});

		const transactionSetMock = jest.fn();
		const directSetMock = jest.fn();
		const transactionMock = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({ state: 'pending', payloadHash: 'hash123', claimToken: 'new-claim' }),
			}),
			set: transactionSetMock,
		};
		const docMock = jest.fn().mockReturnValue({ set: directSetMock });
		const collectionMock = jest.fn().mockReturnValue({ doc: docMock });
		const firestoreMock = {
			collection: collectionMock,
			runTransaction: jest.fn(async (callback) => callback(transactionMock)),
		};

		jest.spyOn(admin, 'firestore').mockReturnValue(firestoreMock);
		admin.firestore.Timestamp = { fromMillis: (ms) => ms };
		jest.spyOn(admin.credential, 'cert').mockReturnValue({});
		jest.spyOn(admin, 'initializeApp').mockReturnValue({});

		await setEntry('test-key', 'hash123', { statusCode: 200, body: { old: true }, headers: {} }, 300000, 'old-claim');

		expect(transactionMock.get).toHaveBeenCalled();
		expect(transactionSetMock).not.toHaveBeenCalled();
		expect(directSetMock).not.toHaveBeenCalled();
	});

	test('releaseEntry should not delete a record owned by a newer reservation token', async () => {
		_resetForTesting();
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
		});

		const transactionDeleteMock = jest.fn();
		const directGetMock = jest.fn().mockResolvedValue({
			exists: true,
			data: () => ({ state: 'pending', payloadHash: 'hash123', claimToken: 'new-claim' }),
		});
		const directDeleteMock = jest.fn();
		const transactionMock = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({ state: 'pending', payloadHash: 'hash123', claimToken: 'new-claim' }),
			}),
			delete: transactionDeleteMock,
		};
		const docMock = jest.fn().mockReturnValue({ get: directGetMock, delete: directDeleteMock });
		const collectionMock = jest.fn().mockReturnValue({ doc: docMock });
		const firestoreMock = {
			collection: collectionMock,
			runTransaction: jest.fn(async (callback) => callback(transactionMock)),
		};

		jest.spyOn(admin, 'firestore').mockReturnValue(firestoreMock);
		jest.spyOn(admin.credential, 'cert').mockReturnValue({});
		jest.spyOn(admin, 'initializeApp').mockReturnValue({});

		await releaseEntry('test-key', 'hash123', 'old-claim');

		expect(transactionMock.get).toHaveBeenCalled();
		expect(transactionDeleteMock).not.toHaveBeenCalled();
		expect(directGetMock).not.toHaveBeenCalled();
		expect(directDeleteMock).not.toHaveBeenCalled();
	});

	test('reserveEntry should set pending expiresAt to at least PENDING_STALE_TIMEOUT_MS to protect against native TTL deletion', async () => {
		_resetForTesting();
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
		});

		const capturedSets = [];
		const transactionMock = {
			get: jest.fn().mockResolvedValue({ exists: false }),
			set: jest.fn((_ref, data) => capturedSets.push(data)),
		};

		const docMock = jest.fn().mockReturnValue({});
		const collectionMock = jest.fn().mockReturnValue({ doc: docMock });
		const firestoreMock = {
			collection: collectionMock,
			runTransaction: jest.fn(async (cb) => cb(transactionMock)),
		};

		jest.spyOn(admin, 'firestore').mockReturnValue(firestoreMock);
		// Return a plain object from Timestamp.fromMillis so we can inspect _ms
		admin.firestore.Timestamp = { fromMillis: (ms) => ({ _ms: ms, toMillis: () => ms }) };
		jest.spyOn(admin.credential, 'cert').mockReturnValue({});
		jest.spyOn(admin, 'initializeApp').mockReturnValue({});

		// Use a very short TTL (1 second) — well below PENDING_STALE_TIMEOUT_MS (180 s)
		const shortTtlMs = 1000;
		const beforeMs = Date.now();
		await reserveEntry('test-key-short-ttl', 'hash-short', shortTtlMs);
		const afterMs = Date.now();

		expect(capturedSets).toHaveLength(1);
		const writtenExpiresAt = capturedSets[0].expiresAt._ms;

		// expiresAt must be at least PENDING_STALE_TIMEOUT_MS (180 s) from now,
		// not just shortTtlMs (1 s) — ensuring native TTL cannot delete the pending claim early
		expect(writtenExpiresAt).toBeGreaterThanOrEqual(beforeMs + 180_000);
		expect(writtenExpiresAt).toBeLessThanOrEqual(afterMs + 180_000);
	});
});

// Issue #1111 turns on durable webhook idempotency in production. Until this
// change, `getStorageStatus()` derived `status: 'ready'` from credential shape
// alone (`enabled && configured`), so a deployment whose Firestore could not be
// reached reported exactly the same verdict as a working one — and because every
// Firestore error in this service is swallowed into in-memory fallback, the
// operator had no signal that the enablement was not taking effect. This is the
// repo's "shape is not readiness" rule, previously applied to
// `firebaseRemoteConfig.ready` (#598), Firestore `readHealth` (#1285) and
// `equityMarketData.ready` (#1116).
describe('durable readiness is proven, not inferred from credential shape (issue #1111)', () => {
	const originalEnv = { ...process.env };

	// `isFirestoreConfigured()` parses the private key with `createPrivateKey`, so a
	// placeholder string never reaches `configured: true`. A real throwaway key keeps
	// these tests on the credential-shape path without checking one into the repo.
	const TEST_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	}).privateKey;

	const VALID_SERVICE_ACCOUNT = JSON.stringify({
		type: 'service_account',
		project_id: 'test-project',
		client_email: 'test@example.com',
		private_key: TEST_PRIVATE_KEY,
	});

	// Carries a valid project id, client email and parseable private key, so it passes
	// `isFirestoreConfigured()`, but the credential loader refuses it as an inline
	// `authorized_user` document — issue #1127's documented case.
	const INLINE_AUTHORIZED_USER = JSON.stringify({
		type: 'authorized_user',
		project_id: 'test-project',
		client_email: 'test@example.com',
		private_key: TEST_PRIVATE_KEY,
		client_id: 'client-id',
		client_secret: 'client-secret',
		refresh_token: 'refresh-token',
	});

	function enableWithValidCredentials() {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE;
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
		jest.spyOn(admin.credential, 'cert').mockReturnValue({});
		jest.spyOn(admin, 'initializeApp').mockReturnValue({});
	}

	function mockFirestore({ transactionError = null } = {}) {
		admin.firestore.Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };
		const docRef = {
			set: jest.fn().mockResolvedValue({}),
			get: jest.fn().mockResolvedValue({ exists: false }),
			delete: jest.fn().mockResolvedValue({}),
		};
		const transactionMock = {
			get: jest.fn().mockResolvedValue({ exists: false }),
			set: jest.fn(),
			delete: jest.fn(),
		};
		const firestoreMock = {
			collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue(docRef) }),
			runTransaction: jest.fn(async (cb) => {
				if (transactionError) {
					throw transactionError;
				}
				return cb(transactionMock);
			}),
		};
		jest.spyOn(admin, 'firestore').mockReturnValue(firestoreMock);
		return { docRef, firestoreMock, transactionMock };
	}

	beforeEach(() => {
		Object.keys(process.env).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);
		_resetForTesting();
		jest.restoreAllMocks();
	});

	afterEach(() => {
		_resetForTesting();
		jest.restoreAllMocks();
		Object.keys(process.env).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);
	});

	it('reports unverified, not ready, when enabled and configured but nothing has persisted yet', () => {
		enableWithValidCredentials();

		const status = getStorageStatus();

		// `mode`/`backend` stay intent-derived so an operator reading the flag still
		// sees that Firestore is the configured target.
		expect(status.enabled).toBe(true);
		expect(status.configured).toBe(true);
		expect(status.mode).toBe('durable');
		expect(status.backend).toBe('firestore');
		// The proof question is separate from the intent question.
		expect(status.ready).toBe(false);
		expect(status.readiness).toBe('unverified');
		expect(status.status).toBe('unverified');
		expect(status.failOpen).toBe(true);
		expect(status.collection).toBe('idempotency_keys');
		expect(status.operationsAttempted).toBe(0);
		expect(status.lastErrorReason).toBeNull();
	});

	it('never turns a status read into a durable attempt', () => {
		enableWithValidCredentials();
		mockFirestore();

		for (let i = 0; i < 5; i += 1) {
			getStorageStatus();
		}

		// Asserted on the counters rather than on `admin.firestore` call counts: that
		// mock is shared across this file, so its tally carries state from other tests
		// and cannot answer "did a status read do durable work".
		const status = getStorageStatus();
		expect(status.operationsAttempted).toBe(0);
		expect(status.operationsFailed).toBe(0);
		// Still unproven, which is only possible if no durable work ran.
		expect(status.readiness).toBe('unverified');
	});

	it('reports ready only after an observed successful durable write', async () => {
		enableWithValidCredentials();
		mockFirestore();

		await reserveEntry('key', 'hash', 300000);

		const status = getStorageStatus();
		expect(status.readiness).toBe('verified');
		expect(status.status).toBe('ready');
		expect(status.ready).toBe(true);
		expect(status.operationsAttempted).toBe(1);
		expect(status.operationsSucceeded).toBe(1);
		expect(status.operationsFailed).toBe(0);
		expect(status.consecutiveFailures).toBe(0);
		expect(status.lastSuccessAt).not.toBeNull();
	});

	it('keeps durability available on a cold process: isReady does not require a prior success', async () => {
		enableWithValidCredentials();
		mockFirestore();

		// `IdempotencyService` gates durable behaviour on `isEnabled()` and relies on
		// `reserveEntry()` returning null to fall back, so `isReady()` must answer the
		// availability question. Folding the proven-readiness verdict into it would
		// make a freshly restarted process skip durable storage until it had already
		// proven it works — the exact cold-start failure this issue must not introduce.
		expect(isReady()).toBe(true);
		expect(getStorageStatus().readiness).toBe('unverified');

		await reserveEntry('key', 'hash', 300000);
		expect(isReady()).toBe(true);
	});

	it('degrades on the first durable failure and self-heals on the next success without a restart', async () => {
		enableWithValidCredentials();
		mockFirestore();
		await reserveEntry('key', 'hash', 300000);
		expect(getStorageStatus().status).toBe('ready');

		_resetForTesting();
		mockFirestore({ transactionError: new Error('UNAVAILABLE: projects/demo-project/databases/(default)') });
		await reserveEntry('key-2', 'hash', 300000);

		const degraded = getStorageStatus();
		expect(degraded.status).toBe('degraded');
		expect(degraded.readiness).toBe('degraded');
		expect(degraded.ready).toBe(false);
		// The verdict stays `ready`-free while it is broken, but intent is unchanged.
		expect(degraded.mode).toBe('durable');
		expect(degraded.backend).toBe('firestore');
		expect(degraded.operationsFailed).toBe(1);
		expect(degraded.consecutiveFailures).toBe(1);
		expect(degraded.lastFailureAt).not.toBeNull();
		expect(degraded.lastErrorReason).toBe('firestore_unavailable');

		_resetForTesting();
		mockFirestore();
		await reserveEntry('key-3', 'hash', 300000);

		const recovered = getStorageStatus();
		expect(recovered.status).toBe('ready');
		expect(recovered.consecutiveFailures).toBe(0);
	});

	it('never leaks a Firestore error message into the reported reason', async () => {
		enableWithValidCredentials();
		mockFirestore({
			transactionError: new Error(
				'FAILED_PRECONDITION: 5 NOT_FOUND: no matching index found for collection group "idempotency_keys"; project demo-project',
			),
		});

		await reserveEntry('key', 'hash', 300000);

		const status = getStorageStatus();
		expect(Object.values(REASONS)).toContain(status.lastErrorReason);
		expect(JSON.stringify(status)).not.toContain('project demo-project');
		expect(JSON.stringify(status)).not.toContain('NOT_FOUND');
	});

	it('records a rejected Firebase initialization as not_initialized', async () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE;
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = INLINE_AUTHORIZED_USER;
		admin.__resetApps();

		expect(isReady()).toBe(false);

		const status = getStorageStatus();
		// Credential shape is valid, so the gate does not report `misconfigured`; the
		// failure is observed, so it must not read as an unproven `ready` either.
		expect(status.configured).toBe(true);
		expect(status.status).toBe('degraded');
		expect(status.lastErrorReason).toBe('firestore_not_initialized');
		expect(status.operationsFailed).toBe(1);
		expect(status.operationsAttempted).toBe(1);
		expect(status.operationsSucceeded).toBe(0);

		admin.__resetApps();
	});

	it('lets gate state win over observed provider health', async () => {
		enableWithValidCredentials();
		mockFirestore();
		await reserveEntry('key', 'hash', 300000);
		expect(getStorageStatus().status).toBe('ready');

		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';
		const disabled = getStorageStatus();
		expect(disabled.status).toBe('disabled');
		expect(disabled.ready).toBe(false);
		expect(disabled.mode).toBe('ephemeral');
		expect(disabled.backend).toBe('memory');

		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		const misconfigured = getStorageStatus();
		expect(misconfigured.status).toBe('misconfigured');
		expect(misconfigured.ready).toBe(false);
	});

	it('records nothing when the feature is disabled', async () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'false';

		await reserveEntry('key', 'hash', 300000);
		await setEntry('key', 'hash', { statusCode: 200, body: 'ok', headers: {} }, 300000, 'token');
		await releaseEntry('key', 'hash', 'token');
		await getEntry('key', 'hash');

		const status = getStorageStatus();
		expect(status.operationsAttempted).toBe(0);
		expect(status.operationsFailed).toBe(0);
		expect(status.readiness).toBe('unverified');
	});

	it('keeps every operation fail-open: a broken Firestore never rejects the caller', async () => {
		enableWithValidCredentials();
		mockFirestore({ transactionError: new Error('UNAVAILABLE') });

		await expect(reserveEntry('key', 'hash', 300000)).resolves.toBeNull();
		await expect(setEntry('key', 'hash', { statusCode: 200, body: 'ok', headers: {} }, 300000, 'token'))
			.resolves.toBeUndefined();
		await expect(releaseEntry('key', 'hash', 'token')).resolves.toBeUndefined();
	});

	it('resets counters on restart', () => {
		enableWithValidCredentials();
		mockFirestore();
		getStorageStatus();
		_resetForTesting();

		const status = getStorageStatus();
		expect(status.operationsAttempted).toBe(0);
		expect(status.operationsSucceeded).toBe(0);
		expect(status.operationsFailed).toBe(0);
		expect(status.lastSuccessAt).toBeNull();
		expect(status.lastFailureAt).toBeNull();
		expect(status.lastErrorReason).toBeNull();
	});
});
