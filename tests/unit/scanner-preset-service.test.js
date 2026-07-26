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

		expect(await service.listPresets()).toEqual([
			expect.objectContaining({ name: 'Trigger flush' }),
	]);
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
});
