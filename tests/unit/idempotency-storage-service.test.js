'use strict';

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
});
