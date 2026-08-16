'use strict';

const fs = require('node:fs');
const path = require('node:path');
jest.unmock('firebase-admin');
const admin = require('firebase-admin');
const {
	assertFails,
	initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, setLogLevel } = require('firebase/firestore');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-cabros';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081';
setLogLevel('silent');

process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
process.env.FIREBASE_PROJECT_ID = PROJECT_ID;

const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const idempotencyStorageService = require('../../src/services/storage/IdempotencyStorageService');
const jobRepositoryModule = require('../../src/services/jobs/JobRepository');
const scannerPresetModule = require('../../src/services/scannerPresets/ScannerPresetService');
const { JobRepository } = jobRepositoryModule;
const { ScannerPresetService } = scannerPresetModule;
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

describe('Firestore emulator integration', () => {
	let testEnvironment;
	let firestore;
	let jobRepository;
	let scannerPresetService;

	beforeAll(async () => {
		expect(PROJECT_ID).toBe('demo-cabros');
		expect(FIRESTORE_HOST).toBe('127.0.0.1:8081');
		expect(process.env.FIREBASE_SERVICE_ACCOUNT_JSON).toBeUndefined();
		expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();

		testEnvironment = await initializeTestEnvironment({
			projectId: PROJECT_ID,
			firestore: {
				host: FIRESTORE_HOST.split(':')[0],
				port: Number(FIRESTORE_HOST.split(':')[1]),
				rules,
			},
		});

		if (!admin.apps.length) {
			admin.initializeApp({ projectId: PROJECT_ID });
		}
		firestore = admin.firestore();
		jobRepository = new JobRepository();
		scannerPresetService = new ScannerPresetService();
	});

	beforeEach(async () => {
		await testEnvironment.clearFirestore();
		alertStorageService._resetForTesting();
		idempotencyStorageService._resetForTesting();
		jobRepositoryModule._resetForTesting();
		scannerPresetModule._resetForTesting();
	});

	afterAll(async () => {
		if (testEnvironment) {
			await testEnvironment.clearFirestore();
			await testEnvironment.cleanup();
		}
		await Promise.all(admin.apps.map((app) => app.delete()));
	});

	it('writes and reads an alert through the server-side Admin SDK', async () => {
		const alertId = await alertStorageService.saveAlert({
			text: 'BINANCE:BTCUSDT (1h)',
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			enriched: false,
			enrichmentData: null,
			tokenUsage: null,
			channels: ['telegram'],
			deliveryResults: [{ channel: 'telegram', success: true }],
			useTradingViewData: false,
		});

		expect(alertId).toEqual(expect.any(String));
		expect(await alertStorageService.getAlertById(alertId)).toMatchObject({
			id: alertId,
			text: 'BINANCE:BTCUSDT (1h)',
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			source: 'webhook',
		});
		expect((await alertStorageService.listAlerts({ limit: 1 })).alerts.map((alert) => alert.id)).toContain(alertId);
		expect((await firestore.collection('alerts').doc(alertId).get()).exists).toBe(true);
	});

	it('keeps idempotency reservations transactional and persists completed responses', async () => {
		const freshReservation = await idempotencyStorageService.reserveEntry('firebase-key', 'payload-a', 60000);
		expect(freshReservation).toMatchObject({
			state: 'fresh',
		});
		expect(await idempotencyStorageService.reserveEntry('firebase-key', 'payload-b', 60000)).toMatchObject({
			state: 'conflict',
		});

		await idempotencyStorageService.setEntry(
			'firebase-key',
			'payload-a',
			{ statusCode: 202, body: { accepted: true }, headers: { 'x-test': 'ok' } },
			60000,
			freshReservation.claimToken,
		);
		expect(await idempotencyStorageService.getEntry('firebase-key', 'payload-a')).toMatchObject({
			state: 'completed',
			statusCode: 202,
			responseBody: { accepted: true },
		});

		const releaseReservation = await idempotencyStorageService.reserveEntry('released-key', 'payload', 60000);
		await idempotencyStorageService.releaseEntry('released-key', 'payload', releaseReservation.claimToken);
		expect((await firestore.collection('idempotency_keys').get()).docs).toHaveLength(1);
	});

	it('persists, queries, and deletes sanitized async jobs', async () => {
		await jobRepository.save({
			jobId: 'firebase-job',
			type: 'tradingview-analysis',
			status: 'processing',
			createdAt: new Date().toISOString(),
			payload: { secret: 'must-not-persist' },
		});

		expect(await jobRepository.get('firebase-job')).toMatchObject({
			jobId: 'firebase-job',
			type: 'tradingview-analysis',
			status: 'processing',
		});
		expect((await jobRepository.list({ type: 'tradingview-analysis', limit: 1 })).map((job) => job.jobId)).toContain('firebase-job');
		expect((await firestore.collection('tradingviewJobs').doc('firebase-job').get()).data()).not.toHaveProperty('payload');
		expect(await jobRepository.delete('firebase-job')).toBe(true);
		expect(await jobRepository.get('firebase-job')).toBeNull();
	});

	it('stores terminal job expiry without expiring active jobs', async () => {
		const createdAt = new Date(Date.now() - 1000).toISOString();
		await jobRepository.save({
			jobId: 'terminal-retention-job',
			type: 'expanded-analysis',
			status: 'completed',
			createdAt,
		});
		await jobRepository.save({
			jobId: 'active-retention-job',
			type: 'expanded-analysis',
			status: 'processing',
			createdAt,
		});

		const terminal = await firestore.collection('tradingviewJobs').doc('terminal-retention-job').get();
		const active = await firestore.collection('tradingviewJobs').doc('active-retention-job').get();

		expect(terminal.data().expiresAt.toDate()).toEqual(
			new Date(new Date(createdAt).getTime() + 3600000),
		);
		expect(active.data()).not.toHaveProperty('expiresAt');
	});

	it('persists, lists, and deletes scanner presets', async () => {
		const preset = await scannerPresetService.createPreset({
			name: 'Emulator smoke test',
			exchange: 'BINANCE',
			timeframe: '4h',
			scans: ['top_gainers'],
		});

		expect(preset).toMatchObject({ name: 'Emulator smoke test' });
		expect(preset.id).toEqual(expect.any(String));
		expect((await scannerPresetService.listPresets()).map((item) => item.id)).toContain(preset.id);
		expect(await scannerPresetService.getPreset(preset.id)).toMatchObject({
			id: preset.id,
			name: 'Emulator smoke test',
		});
		expect(await scannerPresetService.deletePreset(preset.id)).toBe(true);
		expect(await scannerPresetService.getPreset(preset.id)).toBeNull();
	});

	it('writes and reads a signal outcome record without external market data', async () => {
		const signalId = await signalOutcomeService.recordSignal({
			requestId: 'firebase-signal',
			source: 'firebase-test',
			symbol: 'NASDAQ:NVDA',
			price: 100,
			timeframe: '1D',
			side: 'BUY',
			score: 0.8,
		});

		expect(signalId).toEqual(expect.any(String));
		expect((await firestore.collection('tradingSignalOutcomes').doc(signalId).get()).data()).toMatchObject({
			requestId: 'firebase-signal',
			exchange: 'NASDAQ',
			symbol: 'NVDA',
			outcomeEvaluated: true,
		});

		const metrics = await signalOutcomeService.getMetricsSummary({
			from: new Date(Date.now() - 1000).toISOString(),
			to: new Date(Date.now() + 1000).toISOString(),
			limit: 1,
		});
		expect(metrics).toMatchObject({ totalSignalsReceived: 1, totalSignalsUnavailable: 1 });
	});

	it('denies direct client reads and writes under firestore.rules', async () => {
		const clientFirestore = testEnvironment.unauthenticatedContext().firestore();

		await assertFails(getDoc(doc(clientFirestore, 'client-access-contract', 'denied')));
		await assertFails(setDoc(doc(clientFirestore, 'client-access-contract', 'denied'), { allowed: false }));
	});
});
