'use strict';

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	listOutcomes: jest.fn(),
	summarizeOutcomes: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	INVALID_CURSOR_MESSAGE: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
}));

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const { encodeAlertPaginationCursor } = require('../../src/services/storage/alertPaginationCursor');

describe('Signal Outcomes API Integration Tests', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'true',
		});

		jest.clearAllMocks();
		signalOutcomeService.isEnabled.mockReturnValue(true);
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('returns 401 when GET /api/outcomes lacks a valid api key', async () => {
		const res = await request(app)
			.get('/api/outcomes')
			.expect(401);

		expect(res.body.error).toContain('Unauthorized');
	});

	it('returns 403 when signal outcome tracking is disabled', async () => {
		signalOutcomeService.isEnabled.mockReturnValue(false);

		const res = await request(app)
			.get('/api/outcomes')
			.set('x-api-key', 'test-key')
			.expect(403);

		expect(res.body).toEqual({
			error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
			code: 'FEATURE_DISABLED',
		});
	});

	it('returns 503 when Firestore is unavailable', async () => {
		const error = new Error('Signal outcome tracking is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
		error.code = 'STORAGE_UNAVAILABLE';
		signalOutcomeService.listOutcomes.mockRejectedValue(error);

		const res = await request(app)
			.get('/api/outcomes')
			.set('x-api-key', 'test-key')
			.expect(503);

		expect(res.body).toEqual({
			error: 'Signal outcome tracking is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.',
			code: 'STORAGE_UNAVAILABLE',
		});
	});

	it('returns 400 for invalid query parameters', async () => {
		// Invalid limit
		let res = await request(app)
			.get('/api/outcomes?limit=0')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// Invalid status
		res = await request(app)
			.get('/api/outcomes?status=unknown')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// Invalid window
		res = await request(app)
			.get('/api/outcomes?window=2h')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// Invalid before
		res = await request(app)
			.get('/api/outcomes?before=bad-cursor')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// Invalid from date
		res = await request(app)
			.get('/api/outcomes?from=not-a-date')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// from > to
		res = await request(app)
			.get('/api/outcomes?from=2026-08-23T20:00:00.000Z&to=2026-08-23T10:00:00.000Z')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('returns 200 with outcomes list and pagination for valid query', async () => {
		const nextBefore = encodeAlertPaginationCursor({
			receivedAt: '2026-08-23T12:00:00.000Z',
			id: 'doc-1',
		});
		signalOutcomeService.listOutcomes.mockResolvedValue({
			outcomes: [
				{
					id: 'doc-1',
					receivedAt: '2026-08-23T12:00:00.000Z',
					requestId: 'req-1',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					assetClass: 'crypto',
					timeframe: '1h',
					setupType: 'breakout',
					score: 0.9,
					side: 'BUY',
					price: 65000,
					entryPriceSource: 'tradingview-mcp',
					stop: 63000,
					target: 68000,
					marketDataProvider: 'binance',
					eligibilityState: 'supported_provider',
					eligibilityReason: null,
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							reason: null,
							targetTime: '2026-08-23T13:00:00.000Z',
							price: 66000,
							return: 1.5385,
							maxFavorableExcursion: 2.0,
							maxAdverseExcursion: -0.2,
							firstHit: null,
							targetHit: false,
							stopHit: false,
							firstHitTime: null,
							rMultiple: 0.5,
						},
					},
					sources: [],
					tokenUsage: {
						inputTokens: 100,
						outputTokens: 40,
						totalTokens: 140,
						totalCost: 0.00003,
					},
					processingTimeMs: 150,
				},
			],
			hasMore: true,
			nextBefore,
		});

		const res = await request(app)
			.get('/api/outcomes?symbol=BTCUSDT&exchange=BINANCE&status=evaluated&window=1h&limit=10')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(signalOutcomeService.listOutcomes).toHaveBeenCalledWith({
			before: undefined,
			limit: 10,
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			status: 'evaluated',
			window: '1h',
			from: undefined,
			to: undefined,
		});
		expect(res.body).toEqual({
			success: true,
			outcomes: [
				{
					id: 'doc-1',
					receivedAt: '2026-08-23T12:00:00.000Z',
					requestId: 'req-1',
					source: 'news-monitor',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					assetClass: 'crypto',
					timeframe: '1h',
					setupType: 'breakout',
					score: 0.9,
					side: 'BUY',
					price: 65000,
					entryPriceSource: 'tradingview-mcp',
					stop: 63000,
					target: 68000,
					marketDataProvider: 'binance',
					eligibilityState: 'supported_provider',
					eligibilityReason: null,
					outcomeEvaluated: true,
					outcomes: {
						'1h': {
							status: 'evaluated',
							reason: null,
							targetTime: '2026-08-23T13:00:00.000Z',
							price: 66000,
							return: 1.5385,
							maxFavorableExcursion: 2.0,
							maxAdverseExcursion: -0.2,
							firstHit: null,
							targetHit: false,
							stopHit: false,
							firstHitTime: null,
							rMultiple: 0.5,
						},
					},
					sources: [],
					tokenUsage: {
						inputTokens: 100,
						outputTokens: 40,
						totalTokens: 140,
						totalCost: 0.00003,
					},
					processingTimeMs: 150,
				},
			],
			pagination: {
				hasMore: true,
				limit: 10,
				nextBefore,
			},
		});
	});

	it('accepts api key in query parameters for client compatibility', async () => {
		signalOutcomeService.listOutcomes.mockResolvedValue({
			outcomes: [],
			hasMore: false,
			nextBefore: null,
		});

		const res = await request(app)
			.get('/api/outcomes?api-key=test-key')
			.expect(200);

		expect(res.body.success).toBe(true);
	});

	describe('GET /api/outcomes/summary', () => {
		it('returns 401 when request lacks a valid api key', async () => {
			const res = await request(app)
				.get('/api/outcomes/summary')
				.expect(401);

			expect(res.body.error).toContain('Unauthorized');
		});

		it('returns 403 when signal outcome tracking is disabled', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(false);

			const res = await request(app)
				.get('/api/outcomes/summary')
				.set('x-api-key', 'test-key')
				.expect(403);

			expect(res.body).toEqual({
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		});

		it('returns 503 when Firestore is unavailable', async () => {
			const error = new Error('Signal outcome tracking is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
			error.code = 'STORAGE_UNAVAILABLE';
			signalOutcomeService.summarizeOutcomes.mockRejectedValue(error);

			const res = await request(app)
				.get('/api/outcomes/summary')
				.set('x-api-key', 'test-key')
				.expect(503);

			expect(res.body).toEqual({
				error: 'Signal outcome tracking is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.',
				code: 'STORAGE_UNAVAILABLE',
			});
		});

		it('returns 400 for invalid query parameters', async () => {
			let res = await request(app)
				.get('/api/outcomes/summary?limit=0')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			res = await request(app)
				.get('/api/outcomes/summary?status=unknown')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			res = await request(app)
				.get('/api/outcomes/summary?window=2h')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			res = await request(app)
				.get('/api/outcomes/summary?from=not-a-date')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			res = await request(app)
				.get('/api/outcomes/summary?from=2026-08-23T20:00:00.000Z&to=2026-08-23T10:00:00.000Z')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 200 with summary for valid query with filters', async () => {
			const mockSummary = {
				available: true,
				totalSignalsReceived: 5,
				totalSignalsEligible: 5,
				totalSignalsEvaluated: 5,
				totalSignalsPending: 0,
				totalSignalsUnavailable: 0,
				coveragePercent: 100,
				isCoverageComplete: true,
				targetHitRatePercent: 80,
				stopHitRatePercent: 20,
				expectancyR: 1.2,
				populationNote: 'Metrics represent 100% of received signals.',
				exchangeBreakdown: { BINANCE: { received: 5, eligible: 5, evaluated: 5, pending: 0, unavailable: 0 } },
				providerBreakdown: { binance: { received: 5, eligible: 5, evaluated: 5, pending: 0, unavailable: 0 } },
				entryPriceSourceBreakdown: { 'tradingview-mcp': 5 },
				eligibilityBreakdown: { supported_provider: 5 },
				windows: {
					'1h': {
						totalSignals: 5,
						hitRatePercent: 80,
						targetEligibleWindows: 5,
						stopEligibleWindows: 5,
						targetHitRatePercent: 80,
						stopHitRatePercent: 20,
						expectancyR: 1.2,
						averageReturnPercent: 2.1,
						averageMfePercent: 3.0,
						averageMaePercent: -0.4,
						maxAdverseExcursionPercent: -1.0,
					},
				},
				drawdownProxy: {
					averageMaxAdverseExcursionPercent: -0.4,
					absoluteMaxAdverseExcursionPercent: -1.0,
				},
				falsePositiveCandidatesCount: 0,
				falsePositiveCandidates: [],
				latencyCostMetadata: {
					averageProcessingTimeMs: 110,
					tokenUsage: { inputTokens: 400, outputTokens: 150, totalCost: 0.00012 },
				},
			};
			signalOutcomeService.summarizeOutcomes.mockResolvedValue(mockSummary);

			const res = await request(app)
				.get('/api/outcomes/summary?symbol=BTCUSDT&exchange=BINANCE&status=evaluated&window=1h&limit=10')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(signalOutcomeService.summarizeOutcomes).toHaveBeenCalledWith({
				limit: 10,
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				status: 'evaluated',
				window: '1h',
				from: undefined,
				to: undefined,
			});
			expect(res.body).toEqual({
				success: true,
				summary: mockSummary,
			});
		});

		it('returns 200 with typed empty summary when dataset is empty', async () => {
			const emptySummary = {
				available: false,
				totalSignalsReceived: 0,
				totalSignalsEligible: 0,
				totalSignalsEvaluated: 0,
				totalSignalsPending: 0,
				totalSignalsUnavailable: 0,
				coveragePercent: 0,
				isCoverageComplete: true,
				targetHitRatePercent: 0,
				stopHitRatePercent: 0,
				expectancyR: null,
				populationNote: 'No outcome measurements found for the requested criteria.',
				exchangeBreakdown: {},
				providerBreakdown: {},
				entryPriceSourceBreakdown: {},
				eligibilityBreakdown: {},
				windows: {},
				drawdownProxy: {
					averageMaxAdverseExcursionPercent: 0,
					absoluteMaxAdverseExcursionPercent: 0,
				},
				falsePositiveCandidatesCount: 0,
				falsePositiveCandidates: [],
				latencyCostMetadata: {
					averageProcessingTimeMs: null,
					tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
				},
			};
			signalOutcomeService.summarizeOutcomes.mockResolvedValue(emptySummary);

			const res = await request(app)
				.get('/api/outcomes/summary')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body).toEqual({
				success: true,
				summary: emptySummary,
			});
		});

		it('accepts api key in query parameters', async () => {
			signalOutcomeService.summarizeOutcomes.mockResolvedValue({
				available: false,
				totalSignalsReceived: 0,
			});

			const res = await request(app)
				.get('/api/outcomes/summary?api-key=test-key')
				.expect(200);

			expect(res.body.success).toBe(true);
		});
	});
});
