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
});
