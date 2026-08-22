'use strict';

const request = require('supertest');
const admin = require('firebase-admin');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

const mockGetKlines = jest.fn();
const mockGetAvgPrice = jest.fn().mockResolvedValue({ price: '68000.00' });
jest.mock('binance', () => {
	return {
		MainClient: jest.fn().mockImplementation(() => {
			return {
				getKlines: mockGetKlines,
				getAvgPrice: mockGetAvgPrice,
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
		mockGetAvgPrice.mockClear();

		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'true',
			ENABLE_GEMINI_GROUNDING: 'false',
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

		// Manually trigger and await evaluation since it runs in the background in production
		await SignalOutcomeService.evaluatePendingOutcomes();

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
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'false';

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

	it('keeps alert delivery fail-open when the equity provider is rate limited', async () => {
		process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
		process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
		process.env.TWELVE_DATA_API_KEY = 'test-twelve-data-key';
		const originalFetch = global.fetch;
		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 429,
			json: async () => ({ status: 'error', code: 429, message: 'quota exceeded' }),
		});

		try {
			const postRes = await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: 'NASDAQ:AAPL (1h) BUY' });

			expect(postRes.status).toBe(200);
			expect(postRes.body.success).toBe(true);
			await new Promise((resolve) => setImmediate(resolve));

			const outcomesMap = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME);
			const [, docData] = [...outcomesMap.entries()][0];
			expect(docData.eligibilityState).toBe('equity_provider_unavailable');
			expect(docData.eligibilityReason).toBe('twelve_data_rate_limited');
			expect(docData.outcomeEvaluated).toBe(true);
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('records signal outcome using structured MCP entry price without calling Binance getAvgPrice', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
		const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
		const originalEnrich = tradingViewMcpService.enrichFromAlertText;
		tradingViewMcpService.enrichFromAlertText = jest.fn().mockResolvedValue({
			original_text: 'BINANCE:BTCUSDT (1h) BUY',
			sentiment: 'BULLISH',
			sentiment_score: 0.75,
			current_price: 64863.03,
			price_data: { current_price: 64863.03, high: 65000, low: 64000 },
			insights: ['Señal detectada: COMPRA para BTCUSDT en 1h (BINANCE)'],
			technical_levels: { supports: ['64000'], resistances: ['66000'] },
			sources: [],
			truncated: false,
			tradingViewEnrichmentApplied: true,
		});

		try {
			const postRes = await request(app)
				.post('/api/webhook/alert?useTradingViewData=true')
				.set('x-api-key', 'test-key')
				.send({ text: 'BINANCE:BTCUSDT (1h) BUY' });

			expect(postRes.status).toBe(200);
			expect(postRes.body.success).toBe(true);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mockGetAvgPrice).not.toHaveBeenCalled();

			const outcomesMap = global.__firebaseAdminMockState.collections.get(SignalOutcomeService.COLLECTION_NAME);
			expect(outcomesMap).toBeDefined();
			expect(outcomesMap.size).toBe(1);

			const [, docData] = [...outcomesMap.entries()][0];
			expect(docData.symbol).toBe('BTCUSDT');
			expect(docData.exchange).toBe('BINANCE');
			expect(docData.side).toBe('BUY');
			expect(docData.price).toBe(64863.03);
			expect(docData.entryPriceSource).toBe('tradingview-mcp');
			expect(docData.eligibilityState).toBe('supported_provider');
			expect(docData.outcomeEvaluated).toBe(false);
		} finally {
			tradingViewMcpService.enrichFromAlertText = originalEnrich;
		}
	});
});
