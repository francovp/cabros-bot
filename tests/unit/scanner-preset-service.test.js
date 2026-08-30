'use strict';

const { generateKeyPairSync } = require('crypto');
const admin = require('firebase-admin');

const testPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});
const validFirestoreServiceAccountJson = JSON.stringify({
	project_id: 'scanner-preset-test',
	client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
	private_key: testPrivateKey,
});

describe('ScannerPresetService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.resetModules();
		admin.__resetApps();
		admin.__resetCollectionState();
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_FIRESTORE_SCANNER_PRESETS;
		delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.FIREBASE_PROJECT_ID;
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = validFirestoreServiceAccountJson;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
	});

	it('does not use alert storage as an implicit scanner preset persistence gate', async () => {
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();

		await service.createPreset({ name: 'Memory-only preset' });

		expect(service.getStorageStatus()).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('persists a preset across service instances with the dedicated scanner storage flag', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const serviceA = new ScannerPresetService();
		const created = await serviceA.createPreset({ name: 'Dedicated storage preset' });

		jest.resetModules();
		const {
			ScannerPresetService: ReloadedScannerPresetService,
		} = require('../../src/services/scannerPresets/ScannerPresetService');
		const fetched = await new ReloadedScannerPresetService().getPreset(created.id);

		expect(fetched).toMatchObject({
			id: created.id,
			name: 'Dedicated storage preset',
		});
	});

	it('reports the in-memory storage mode when durable storage is disabled', () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');

		expect(new ScannerPresetService().getStorageStatus()).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('reports ephemeral storage after a Firestore write failure', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		require('firebase-admin').__mockDocSet.mockRejectedValueOnce(new Error('Firestore unavailable'));
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Fallback preset' });

		expect(created.name).toBe('Fallback preset');
		expect(service.getStorageStatus()).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('retries Firestore after a transient write failure and reports recovery', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore outage'));
		const service = new ScannerPresetService();

		await service.createPreset({ name: 'First attempt' });
		expect(service.getStorageStatus().mode).toBe('ephemeral');

		await service.createPreset({ name: 'Recovered attempt' });
		expect(service.getStorageStatus()).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			mode: 'durable',
			backend: 'firestore',
		});
	});

	it('does not report durable storage without usable Firestore credentials', () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');

		expect(new ScannerPresetService().getStorageStatus()).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('clears the unavailable state after a successful Firestore read recovery', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		firestoreAdmin.__mockGet.mockRejectedValueOnce(new Error('Temporary Firestore read outage'));
		const service = new ScannerPresetService();

		await service.listPresets();
		expect(service.getStorageStatus().mode).toBe('ephemeral');

		await service.listPresets();
		expect(service.getStorageStatus()).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			mode: 'durable',
			backend: 'firestore',
		});
	});

	it('keeps presets from failed writes visible and ephemeral after reads recover', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		const service = new ScannerPresetService();

		const created = await service.createPreset({ name: 'Unsynced preset' });
		const presets = await service.listPresets();

		expect(presets).toEqual([
			expect.objectContaining({ id: created.id, name: 'Unsynced preset' }),
		]);
		expect(service.getStorageStatus().mode).toBe('ephemeral');
	});

	it('does not resurrect a queued write after deleting during a Firestore outage', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		firestoreAdmin.__mockDocGet.mockRejectedValueOnce(new Error('Temporary Firestore read outage'));
		const service = new ScannerPresetService();

		const created = await service.createPreset({ name: 'Deleted queued preset' });
		expect(await service.deletePreset(created.id)).toBe(true);
		expect(await service.listPresets()).toEqual([]);
	});

	it('serializes pending writes before concurrent updates for the same preset', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Queued old value' });

		let releaseOldWrite;
		let oldWriteStarted = false;
		let newWriteStarted = false;
		const oldWriteGate = new Promise((resolve) => {
			releaseOldWrite = resolve;
		});
		firestoreAdmin.__mockDocSet.mockImplementation((data) => {
			if (data.name === 'Trigger flush') {
				return Promise.resolve();
			}
			if (data.name === 'Queued old value') {
				oldWriteStarted = true;
				return oldWriteGate;
			}
			if (data.name === 'New value') {
				newWriteStarted = true;
			}
			return Promise.resolve();
		});
		firestoreAdmin.__mockDocGet.mockImplementation(() => Promise.resolve({
			exists: true,
			data: () => ({ name: 'New value', version: 1 }),
		}));

		const triggerPromise = service.createPreset({ name: 'Trigger flush' });
		await new Promise((resolve) => setImmediate(resolve));
		const updatePromise = service.updatePreset(created.id, { name: 'New value' });
		await new Promise((resolve) => setImmediate(resolve));

		expect(oldWriteStarted).toBe(true);
		expect(newWriteStarted).toBe(false);

		releaseOldWrite();
		await Promise.all([triggerPromise, updatePromise]);
		expect(newWriteStarted).toBe(true);
	});

	it('does not resurrect a preset deleted during the update read phase', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Original value' });
		const originalGetPreset = service.getPreset.bind(service);

		service.getPreset = jest.fn(async () => {
			await service.deletePreset(created.id);
			return created;
		});

		const updated = await service.updatePreset(created.id, { name: 'Resurrected value' });

		expect(updated).toBeNull();
		expect(firestoreAdmin.__mockDocSet).toHaveBeenCalledTimes(1);
		expect(await originalGetPreset(created.id)).toBeNull();
	});

	it('preserves a newer failed write when an older write finishes', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Original value' });
		let rejectNewWrite;
		let releaseOldWrite;
		const newWrite = new Promise((resolve, reject) => {
			rejectNewWrite = reject;
		});
		const oldWrite = new Promise((resolve) => {
			releaseOldWrite = resolve;
		});
		jest.spyOn(service, 'getPreset').mockResolvedValue(created);
		jest.spyOn(service, '_writeFirestorePreset')
			.mockImplementationOnce(() => oldWrite)
			.mockImplementationOnce(() => newWrite)
			.mockImplementation(() => Promise.reject(new Error('Recovery write still unavailable')));

		const olderUpdate = service.updatePreset(created.id, { name: 'Older value' });
		await new Promise((resolve) => setImmediate(resolve));
		const newerUpdate = service.updatePreset(created.id, { name: 'Newer value' });
		await new Promise((resolve) => setImmediate(resolve));

		rejectNewWrite(new Error('Temporary Firestore update outage'));
		await newerUpdate;
		releaseOldWrite();
		await olderUpdate;

		expect(await service.listPresets()).toEqual([
			expect.objectContaining({ id: created.id, name: 'Newer value' }),
		]);
		expect(service.getStorageStatus().mode).toBe('ephemeral');
	});

	it('keeps a deletion tombstone when deleting an updated preset during an outage', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Original value' });

		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		await service.updatePreset(created.id, { name: 'Updated value' });
		firestoreAdmin.__mockDocGet.mockRejectedValueOnce(new Error('Temporary Firestore read outage'));

		expect(await service.deletePreset(created.id)).toBe(true);
		expect(await service.listPresets()).toEqual([]);
	});

	it('queues deletes behind in-flight Firestore writes', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Original value' });

		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		await service.updatePreset(created.id, { name: 'Updated value' });

		let releaseFlush;
		const flushGate = new Promise((resolve) => {
			releaseFlush = resolve;
		});
		firestoreAdmin.__mockDocSet.mockImplementation((data) => (
			data.name === 'Trigger flush' ? Promise.resolve() : flushGate
		));
		const triggerPromise = service.createPreset({ name: 'Trigger flush' });
		await new Promise((resolve) => setImmediate(resolve));
		firestoreAdmin.__mockDocGet.mockResolvedValueOnce({ exists: false });
		const deletePromise = service.deletePreset(created.id);
		await new Promise((resolve) => setImmediate(resolve));
		expect(firestoreAdmin.__mockDocDelete).not.toHaveBeenCalled();

		releaseFlush();
		await Promise.all([triggerPromise, deletePromise]);
		expect(firestoreAdmin.__mockDocDelete).toHaveBeenCalled();
	});

	it('does not flush the same pending preset twice concurrently', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		await service.createPreset({ name: 'Queued value' });

		let releaseFlush;
		let queuedWrites = 0;
		const flushGate = new Promise((resolve) => {
			releaseFlush = resolve;
		});
		firestoreAdmin.__mockDocSet.mockImplementation((data) => {
			if (data.name === 'Trigger one' || data.name === 'Trigger two') {
				return Promise.resolve();
			}
			queuedWrites += 1;
			return flushGate;
		});

		const firstTrigger = service.createPreset({ name: 'Trigger one' });
		await new Promise((resolve) => setImmediate(resolve));
		const secondTrigger = service.createPreset({ name: 'Trigger two' });
		await new Promise((resolve) => setImmediate(resolve));
		releaseFlush();
		await Promise.all([firstTrigger, secondTrigger]);

		expect(queuedWrites).toBe(1);
	});

	it('tombstones a remote-only preset when its delete fails', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const scannerPresetModule = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new scannerPresetModule.ScannerPresetService();
		const created = await service.createPreset({ name: 'Remote-only preset' });
		scannerPresetModule._resetForTesting();
		firestoreAdmin.__mockDocDelete.mockRejectedValueOnce(new Error('Temporary Firestore delete outage'));

		expect(await service.deletePreset(created.id)).toBe(true);
		expect(await service.listPresets()).toEqual([]);
	});

	it('keeps a tombstone when a queued delete fails after an in-flight update', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Original value' });
		let releaseUpdate;
		const updateGate = new Promise((resolve) => {
			releaseUpdate = resolve;
		});
		firestoreAdmin.__mockDocSet.mockImplementation((data) => (
			data.name === 'Updated value' ? updateGate : Promise.resolve()
		));

		const updatePromise = service.updatePreset(created.id, { name: 'Updated value' });
		await new Promise((resolve) => setImmediate(resolve));
		firestoreAdmin.__mockDocGet.mockResolvedValueOnce({ exists: true });
		firestoreAdmin.__mockDocDelete.mockRejectedValueOnce(new Error('Temporary Firestore delete outage'));
		const deletePromise = service.deletePreset(created.id);
		releaseUpdate();

		expect(await deletePromise).toBe(true);
		await updatePromise;
		expect(await service.listPresets()).toEqual([]);
	});

	it('does not restore a failed update after a queued delete succeeds', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Original value' });
		let rejectUpdate;
		const updateGate = new Promise((resolve, reject) => {
			rejectUpdate = reject;
		});
		firestoreAdmin.__mockDocSet.mockImplementation((data) => (
			data.name === 'Updated value' ? updateGate : Promise.resolve()
		));

		const updatePromise = service.updatePreset(created.id, { name: 'Updated value' });
		await new Promise((resolve) => setImmediate(resolve));
		firestoreAdmin.__mockDocGet.mockResolvedValueOnce({ exists: true });
		const deletePromise = service.deletePreset(created.id);
		await new Promise((resolve) => setImmediate(resolve));

		rejectUpdate(new Error('Temporary Firestore update outage'));
		expect(await deletePromise).toBe(true);
		await updatePromise;

		expect(await service.listPresets()).toEqual([]);
		expect(service.getStorageStatus().mode).toBe('durable');
	});

	it('does not restore a failed pending flush after a queued delete succeeds', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		const queued = await service.createPreset({ name: 'Queued value' });

		let rejectFlush;
		const flushGate = new Promise((resolve, reject) => {
			rejectFlush = reject;
		});
		firestoreAdmin.__mockDocSet.mockImplementation((data) => {
			if (data.name === 'Queued value') {
				return flushGate;
			}
			return Promise.resolve();
		});

		const triggerPromise = service.createPreset({ name: 'Trigger flush' });
		await new Promise((resolve) => setImmediate(resolve));
		const deletePromise = service.deletePreset(queued.id);
		await new Promise((resolve) => setImmediate(resolve));

		rejectFlush(new Error('Temporary Firestore flush outage'));
		expect(await deletePromise).toBe(true);
		await triggerPromise;

		expect(await service.listPresets()).toEqual([]);
		expect(await service.getPreset(queued.id)).toBeNull();
		expect(service.getStorageStatus().mode).toBe('durable');
	});

	it('does not flush an older pending value after a newer update starts', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		const created = await service.createPreset({ name: 'Old value' });

		let releaseNewWrite;
		const newWriteGate = new Promise((resolve) => {
			releaseNewWrite = resolve;
		});
		const writes = [];
		firestoreAdmin.__mockDocSet.mockImplementation((data) => {
			writes.push(data.name);
			if (data.name === 'New value') {
				return newWriteGate;
			}
			return Promise.resolve();
		});
		firestoreAdmin.__mockDocGet.mockImplementation(() => Promise.resolve({
			exists: true,
			data: () => ({ name: 'New value', version: 1 }),
		}));

		const updatePromise = service.updatePreset(created.id, { name: 'New value' });
		await new Promise((resolve) => setImmediate(resolve));
		const triggerPromise = service.createPreset({ name: 'Trigger flush' });
		await new Promise((resolve) => setImmediate(resolve));

		releaseNewWrite();
		await Promise.all([updatePromise, triggerPromise]);

		expect(writes.filter((name) => name === 'Old value')).toEqual([]);
		expect(writes.filter((name) => name === 'New value')).toEqual(['New value']);
	});

	it('does not accept caller-supplied create IDs', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();

		const created = await service.createPreset({ id: 'unsafe/path', name: 'Generated ID preset' });

		expect(created.id).not.toBe('unsafe/path');
		expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(service.getStorageStatus().mode).toBe('durable');
	});

	it('keeps a claimed pending preset visible during recovery', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Temporary Firestore write outage'));
		const queued = await service.createPreset({ name: 'Queued recovery value' });

		let releaseFlush;
		const flushGate = new Promise((resolve) => {
			releaseFlush = resolve;
		});
		firestoreAdmin.__mockDocSet.mockImplementation((data) => (
			data.name === 'Queued recovery value' ? flushGate : Promise.resolve()
		));

		const triggerPromise = service.createPreset({ name: 'Trigger recovery' });
		await new Promise((resolve) => setImmediate(resolve));

		expect(await service.listPresets()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: queued.id, name: 'Queued recovery value' }),
		]));
		expect(service.getStorageStatus().mode).toBe('ephemeral');

		releaseFlush();
		await triggerPromise;
	});

	it('treats successful empty Firestore reads as authoritative', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const scannerPresetModule = require('../../src/services/scannerPresets/ScannerPresetService');
		const { ScannerPresetService } = scannerPresetModule;
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Externally deleted preset' });
		firestoreAdmin.__resetCollectionState();

		expect(await service.listPresets()).toEqual([]);
		expect(await service.getPreset(created.id)).toBeNull();
	});

	it('initializes version to 1 on create and increments on each successful update', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();

		const created = await service.createPreset({ name: 'Versioned preset' });
		expect(created.version).toBe(1);

		const updatedOnce = await service.updatePreset(created.id, { name: 'Versioned preset v2' });
		expect(updatedOnce.version).toBe(2);

		const updatedTwice = await service.updatePreset(created.id, { limit: 9 });
		expect(updatedTwice.version).toBe(3);

		const refetched = await service.getPreset(created.id);
		expect(refetched.version).toBe(3);
	});

	it('rejects updates with a stale ifMatch token using PRECONDITION_FAILED', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Stale token preset' });

		let caught;
		try {
			await service.updatePreset(created.id, { name: 'Should fail' }, { ifMatchVersion: 99 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeDefined();
		expect(caught.name).toBe('MarketScannerRequestError');
		expect(caught.code).toBe('PRECONDITION_FAILED');
		expect(caught.statusCode).toBe(412);
		expect(caught.preset).toMatchObject({ id: created.id, version: 1 });

		const refetched = await service.getPreset(created.id);
		expect(refetched.name).toBe('Stale token preset');
		expect(refetched.version).toBe(1);
	});

	it('accepts updates with a matching ifMatchVersion and increments version', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Matched token preset' });

		const updated = await service.updatePreset(
			created.id,
			{ name: 'Matched token preset v2' },
			{ ifMatchVersion: created.version },
		);
		expect(updated.version).toBe(2);
		expect(updated.name).toBe('Matched token preset v2');
	});

	it('rejects updates against a locked preset using PRESET_LOCKED', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Locked preset' });
		const futureLock = new Date(Date.now() + 60000).toISOString();
		await service.updatePreset(created.id, { lockedUntil: futureLock, lockedBy: 'scheduler' });

		let caught;
		try {
			await service.updatePreset(created.id, { name: 'Should fail locked' });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeDefined();
		expect(caught.name).toBe('MarketScannerRequestError');
		expect(caught.code).toBe('PRESET_LOCKED');
		expect(caught.statusCode).toBe(409);
		expect(caught.lockedUntil).toBe(futureLock);
	});

	it('rejects deletes with a stale ifMatch token', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Stale delete preset' });

		let caught;
		try {
			await service.deletePreset(created.id, { ifMatchVersion: 42 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeDefined();
		expect(caught.code).toBe('PRECONDITION_FAILED');
		expect(caught.statusCode).toBe(412);

		expect(await service.getPreset(created.id)).not.toBeNull();
	});

	it('accepts deletes with a matching ifMatchVersion', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Matched delete preset' });

		const deleted = await service.deletePreset(created.id, { ifMatchVersion: created.version });
		expect(deleted).toBe(true);
		expect(await service.getPreset(created.id)).toBeNull();
	});

	it('returns null from updatePreset and deletePreset when the preset is missing without a token', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();

		expect(await service.updatePreset('missing-id', { name: 'gone' })).toBeNull();
		expect(await service.deletePreset('missing-id')).toBe(false);
	});

	it('persists the version across Firestore writes and reloads', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const serviceA = new ScannerPresetService();
		const created = await serviceA.createPreset({ name: 'Firestore versioned preset' });
		expect(created.version).toBe(1);

		const updated = await serviceA.updatePreset(created.id, { name: 'Firestore versioned v2' });
		expect(updated.version).toBe(2);

		jest.resetModules();
		const {
			ScannerPresetService: ReloadedScannerPresetService,
		} = require('../../src/services/scannerPresets/ScannerPresetService');
		const fetched = await new ReloadedScannerPresetService().getPreset(created.id);
		expect(fetched.version).toBe(2);
		expect(fetched.name).toBe('Firestore versioned v2');
	});

	it('atomically rejects a stale Firestore write that races a successful one', async () => {
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const firestoreAdmin = require('firebase-admin');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Race target preset' });

		const setSpy = firestoreAdmin.__mockDocSet;
		setSpy.mockClear();
		// First get: updatePreset's initial getPreset sees the local
		// in-memory preset (mock returns version 1 to match what create wrote).
		// Second get: the atomic re-check inside _writeFirestorePreset
		// sees version 2 (a concurrent writer already won). The atomic
		// write must be rejected.
		let getCalls = 0;
		firestoreAdmin.__mockDocGet.mockImplementation(() => {
			getCalls += 1;
			if (getCalls === 1) {
				return Promise.resolve({ exists: true, data: () => ({ version: 1, name: 'Race target preset' }) });
			}
			return Promise.resolve({ exists: true, data: () => ({ version: 2, name: 'Concurrent winner' }) });
		});

		const stale = await service.updatePreset(created.id, { name: 'Stale concurrent write' });
		expect(stale).toBeNull();
		// The stale write never reached Firestore: no set() call was made
		// because the atomic version check threw first.
		expect(setSpy).not.toHaveBeenCalled();
	});

	it('serializes concurrent in-memory updates so only one wins per version', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'In-memory race' });

		const [a, b] = await Promise.all([
			service.updatePreset(created.id, { name: 'Writer A' }),
			service.updatePreset(created.id, { name: 'Writer B' }),
		]);

		const winners = [a, b].filter((preset) => preset !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0].version).toBe(2);
		expect(['Writer A', 'Writer B']).toContain(winners[0].name);

		const refetched = await service.getPreset(created.id);
		expect(refetched.version).toBe(2);
	});

	it('rejects a malformed If-Match header instead of disabling the check', () => {
		const { parseIfMatchHeader } = require('../../src/services/scannerPresets/ScannerPresetService');

		expect(parseIfMatchHeader('"3"')).toEqual({ present: true, version: 3, malformed: false });
		expect(parseIfMatchHeader('W/"3"')).toEqual({ present: true, version: 3, malformed: false });
		expect(parseIfMatchHeader('3')).toEqual({ present: true, version: 3, malformed: false });
		expect(parseIfMatchHeader('"3", "4"')).toEqual({ present: true, version: null, malformed: true });
		expect(parseIfMatchHeader('*')).toEqual({ present: true, version: null, malformed: true });
		expect(parseIfMatchHeader('')).toEqual({ present: true, version: null, malformed: true });
		expect(parseIfMatchHeader(undefined)).toEqual({ present: false, version: null, malformed: false });
	});

	it('ignores a caller-supplied initial version on createPreset', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();

		const created = await service.createPreset({ name: 'Version-tampered preset', version: 999 });
		expect(created.version).toBe(1);
	});

	it('normalizes unsafe integer versions back to the safe range', async () => {
		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const { normalizeVersion } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();

		// `normalizeVersion` itself rejects unsafe integers and falls back
		// to a safe value, so the ETag chain can never loop on the same
		// tag once an unsafe value is encountered.
		expect(normalizeVersion(9007199254740992, 1)).toBe(1);
		expect(normalizeVersion(Number.MAX_SAFE_INTEGER + 1, 1)).toBe(1);
		expect(normalizeVersion(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
		expect(normalizeVersion(-1, 1)).toBe(1);
		expect(normalizeVersion(0, 1)).toBe(1);
		expect(normalizeVersion('3', 1)).toBe(3);
	});

	it('releases the in-memory write lock after the persist completes', async () => {
		const { ScannerPresetService, _memoryPresets } = require('../../src/services/scannerPresets/ScannerPresetService');
		const service = new ScannerPresetService();
		const created = await service.createPreset({ name: 'Lock release preset' });

		const internal = require('../../src/services/scannerPresets/ScannerPresetService');
		const inMemoryWriteLocksMap = internal.inMemoryWriteLocks || null;

		await service.updatePreset(created.id, { name: 'Updated once' });
		await service.deletePreset(created.id);

		// After the writes finish the lock map must be empty so
		// create/delete churn does not leak memory.
		const { inMemoryWriteLocks } = require('../../src/services/scannerPresets/ScannerPresetService');
		// Access via a getter through internal reset helper to verify cleanup.
		// The internal map is module-scoped; the absence of an exported
		// handle is itself the contract — repeated updates on the same id
		// without leaking is verified by the bounded test runtime.
		expect(inMemoryWriteLocks.size).toBe(0);
	});
});
