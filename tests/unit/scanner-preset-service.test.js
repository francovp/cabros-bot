'use strict';

const admin = require('firebase-admin');

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
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	});

	it('persists a created preset across service instances when Firestore storage is enabled', async () => {
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

		const { ScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
		const serviceA = new ScannerPresetService();
		const created = await serviceA.createPreset({
			name: 'Momentum preset',
			exchange: 'binance',
			timeframe: '1h',
			scans: ['top_gainers', 'volume_breakout_scanner'],
			limit: 7,
			bbwThreshold: 0.08,
		});

		jest.resetModules();
		const {
			ScannerPresetService: ReloadedScannerPresetService,
		} = require('../../src/services/scannerPresets/ScannerPresetService');
		const fetched = await new ReloadedScannerPresetService().getPreset(created.id);

		expect(fetched).toMatchObject({
			id: created.id,
			name: 'Momentum preset',
			exchange: 'BINANCE',
			timeframe: '1h',
			scans: ['top_gainers', 'volume_breakout_scanner'],
			limit: 7,
			bbwThreshold: 0.08,
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
});
