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
});
