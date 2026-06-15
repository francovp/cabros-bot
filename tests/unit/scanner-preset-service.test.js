'use strict';

const admin = require('firebase-admin');

describe('ScannerPresetService', () => {
	beforeEach(() => {
		jest.resetModules();
		admin.__resetApps();
		admin.__resetCollectionState();
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
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
});
