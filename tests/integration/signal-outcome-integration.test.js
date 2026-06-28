'use strict';

const request = require('supertest');
const admin = require('firebase-admin');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

const mockGetKlines = jest.fn();
jest.mock('binance', () => {
	return {
		MainClient: jest.fn().mockImplementation(() => {
			return {
				getKlines: mockGetKlines,
				getAvgPrice: jest.fn().mockResolvedValue({ price: '68000.00' }),
			};
		}),
	};
});

describe('Shadow-Mode Outcome Tracking Integration Tests', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		admin.__resetApps();
		admin.__resetCollectionState();
		mockGetKlines.mockClear();

		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
			ENABLE_SHADOW_MODE_OUTCOME_TRACKING: 'true',
		};

		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('records signal outcome on /api/webhook/alert and exposes summary/export metrics', async () => {
		// Mock klines for outcomes evaluation: open, high, low, close
		mockGetKlines.mockResolvedValue([
			[Date.now() - 3600000, "68000.00", "69000.00", "67000.00", "68500.00"],
		]);

		// 1. Post webhook alert with a clear TradingView BUY signal
		const alertText = 'BINANCE:BTCUSDT (1h) BUY';
		const postRes = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: alertText });

		expect(postRes.status).toBe(200);
		expect(postRes.body.success).toBe(true);

		// Verify the signal was recorded in Firestore
		const outcomesMap = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME);
		expect(outcomesMap).toBeDefined();
		expect(outcomesMap.size).toBe(1);

		const [docId, docData] = [...outcomesMap.entries()][0];
		expect(docData.symbol).toBe('BTCUSDT');
		expect(docData.exchange).toBe('BINANCE');
		expect(docData.side).toBe('BUY');
		expect(docData.price).toBe(68000.00); // auto-resolved in background from mock getAvgPrice
		expect(docData.outcomeEvaluated).toBe(false);

		// Force the target times to the past so that getMetricsSummary evaluations will trigger
		const pastIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		for (const key of Object.keys(docData.outcomes)) {
			docData.outcomes[key].targetTime = pastIso;
		}

		const fromIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const toIso = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

		// 2. Query summary endpoint
		const summaryRes = await request(app)
			.get(`/api/alerts/summary?limit=10&from=${fromIso}&to=${toIso}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(summaryRes.body.success).toBe(true);
		expect(summaryRes.body.summary).toBeDefined();

		const metrics = summaryRes.body.summary.shadowModeMetrics;
		expect(metrics).not.toBe('No measurements found');
		expect(metrics.totalSignalsEvaluated).toBe(1);
		expect(metrics.windows['1h']).toBeDefined();
		expect(metrics.windows['1h'].hitRatePercent).toBe(100);
		expect(metrics.windows['1h'].averageReturnPercent).toBe(0.7353); // ((68500-68000)/68000)*100 = 0.7353

		// 3. Query export endpoint and verify X-Shadow-Mode-Metrics header
		const exportRes = await request(app)
			.get(`/api/alerts/export?format=jsonl&limit=10&from=${fromIso}&to=${toIso}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(exportRes.headers['x-shadow-mode-metrics']).toBeDefined();
		const headerMetrics = JSON.parse(exportRes.headers['x-shadow-mode-metrics']);
		expect(headerMetrics.totalSignalsEvaluated).toBe(1);
	});

	it('returns "No measurements found" when shadow mode is disabled or no outcomes exist', async () => {
		process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'false';

		const fromIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		const toIso = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

		const summaryRes = await request(app)
			.get(`/api/alerts/summary?limit=10&from=${fromIso}&to=${toIso}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(summaryRes.body.summary.shadowModeMetrics).toBe('No measurements found');

		const exportRes = await request(app)
			.get(`/api/alerts/export?format=jsonl&limit=10&from=${fromIso}&to=${toIso}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(JSON.parse(exportRes.headers['x-shadow-mode-metrics'])).toBe('No measurements found');
	});
});
