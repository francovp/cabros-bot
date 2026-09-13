'use strict';

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	listAlerts: jest.fn(),
	getAlertById: jest.fn(),
	getAlertsByIds: jest.fn(),
	exportAlertsByIds: jest.fn(),
	deleteAlerts: jest.fn(),
	batchReplayAlerts: jest.fn(),
	saveReplayAttempt: jest.fn(),
	getReplayAttemptByIdempotencyKey: jest.fn(),
	listReplayAttempts: jest.fn(),
	getLatestReplayForAlert: jest.fn(),
	summarizeAlerts: jest.fn(),
	exportAlerts: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	INVALID_CURSOR_MESSAGE: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
	parseAlertPaginationCursor: jest.fn(),
}));

jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
	postAlert: jest.fn(() => (_req, res) => res.status(501).json({ error: 'not mocked' })),
	initializeNotificationServices: jest.fn(),
	getNotificationManager: jest.fn(),
}));

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	getMetricsSummary: jest.fn(),
}));

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const alertHandler = require('../../src/controllers/webhooks/handlers/alert/alert');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const { encodeAlertPaginationCursor } = require('../../src/services/storage/alertPaginationCursor');

const { idempotencyService } = require('../../src/services/storage/IdempotencyService');

describe('Alerts API Integration Tests', () => {
	let savedEnv;
	let mockNotificationManager;

	beforeEach(() => {
		savedEnv = saveEnv();
		idempotencyService.clear();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
		});

		jest.clearAllMocks();
		mockNotificationManager = {
			sendToChannels: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true, messageId: 'tg-1' }]),
		};
		alertHandler.getNotificationManager.mockReturnValue(mockNotificationManager);
		alertHandler.initializeNotificationServices.mockResolvedValue(mockNotificationManager);
		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.saveReplayAttempt.mockResolvedValue('replay-1');
		alertStorageService.listReplayAttempts.mockResolvedValue({ replays: [], hasMore: false, nextBefore: null });
		alertStorageService.getLatestReplayForAlert.mockResolvedValue(null);
		signalOutcomeService.isEnabled.mockReturnValue(false);
		signalOutcomeService.getMetricsSummary.mockResolvedValue('No measurements found');
		const { parseAlertPaginationCursor: actualParseCursor } = jest.requireActual('../../src/services/storage/alertPaginationCursor');
		alertStorageService.parseAlertPaginationCursor.mockImplementation(actualParseCursor);
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('returns 401 when GET /api/alerts lacks a valid api key', async () => {
		const res = await request(app)
			.get('/api/alerts')
			.expect(401);

		expect(res.body.error).toContain('Unauthorized');
	});

	it('returns stored alerts with parsed filters and pagination metadata', async () => {
		const nextBefore = encodeAlertPaginationCursor({
			receivedAt: '2026-06-06T12:00:00.000Z',
			id: 'alert-1',
		});
		alertStorageService.listAlerts.mockResolvedValue({
			alerts: [
				{
					id: 'alert-1',
					receivedAt: '2026-06-06T12:00:00.000Z',
					text: 'BTC alert',
					enriched: true,
					enrichmentData: { sentiment: 'bullish' },
					tokenUsage: { totalTokens: 42 },
					deliveryResults: [{ channel: 'telegram', success: true }],
					source: 'webhook',
					useTradingViewData: false,
				},
			],
			hasMore: true,
			nextBefore,
		});

		const res = await request(app)
			.get('/api/alerts?limit=1&before=2026-06-06T13:00:00.000Z&source=webhook&enriched=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.listAlerts).toHaveBeenCalledWith({
			before: '2026-06-06T13:00:00.000Z',
			enriched: true,
			limit: 1,
			source: 'webhook',
		});
		expect(res.body).toEqual({
			success: true,
			alerts: [
				{
					id: 'alert-1',
					receivedAt: '2026-06-06T12:00:00.000Z',
					text: 'BTC alert',
					enriched: true,
					enrichmentData: { sentiment: 'bullish' },
					tokenUsage: { totalTokens: 42 },
					deliveryResults: [{ channel: 'telegram', success: true }],
					source: 'webhook',
					useTradingViewData: false,
				},
			],
			pagination: {
				hasMore: true,
				limit: 1,
				nextBefore,
			},
		});
	});

	it('passes include and includeEnrichmentSummary when include=enrichment_summary is requested', async () => {
		alertStorageService.listAlerts.mockResolvedValue({
			alerts: [
				{
					id: 'alert-1',
					receivedAt: '2026-06-06T12:00:00.000Z',
					text: 'BTC alert',
					enriched: true,
					enrichmentData: {
						sentiment: 'BULLISH',
						sentiment_score: 0.9,
						setup_type: 'breakout',
						invalidation_level: 64000,
						target_level: 68000,
						risk_reward_ratio: 2,
						sourceCount: 1,
						sourceDomains: ['coindesk.com'],
						tradingViewEnrichmentApplied: true,
						tradingViewEnrichmentStatus: 'full',
						promptProvenance: {
							name: 'crypto-sentiment',
							source: 'langfuse',
							label: 'production',
							version: 1,
						},
					},
					enrichmentSummary: {
						sentiment: 'BULLISH',
						sentiment_score: 0.9,
						setup_type: 'breakout',
						invalidation_level: 64000,
						target_level: 68000,
						risk_reward_ratio: 2,
						sourceCount: 1,
						sourceDomains: ['coindesk.com'],
						tradingViewEnrichmentApplied: true,
						tradingViewEnrichmentStatus: 'full',
						promptProvenance: {
							name: 'crypto-sentiment',
							source: 'langfuse',
							label: 'production',
							version: 1,
						},
					},
					channels: ['telegram'],
					deliveryResults: [{ channel: 'telegram', success: true }],
					source: 'webhook',
					useTradingViewData: false,
					tradingViewEnrichmentApplied: true,
				},
			],
			hasMore: false,
			nextBefore: null,
		});

		const res = await request(app)
			.get('/api/alerts?limit=10&include=enrichment_summary')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.listAlerts).toHaveBeenCalledWith({
			before: undefined,
			enriched: undefined,
			limit: 10,
			source: undefined,
			include: ['enrichment_summary'],
			includeEnrichmentSummary: true,
		});
		expect(res.body.success).toBe(true);
		expect(res.body.alerts[0].enrichmentData.sentiment).toBe('BULLISH');
		expect(res.body.alerts[0].enrichmentSummary.sentiment).toBe('BULLISH');
	});

	it('returns 400 for invalid include values', async () => {
		const res = await request(app)
			.get('/api/alerts?include=unknown_field')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body).toEqual({
			error: "Invalid include parameter 'unknown_field'. Allowed values: enrichment_summary.",
			code: 'INVALID_REQUEST',
		});
	});

	it('returns 400 for invalid before cursor values', async () => {
		const res = await request(app)
			.get('/api/alerts?before=not-a-date')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body).toEqual({
			error: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
			code: 'INVALID_REQUEST',
		});
	});

	it('passes symbol, eventCategory, and exchange filters to alertStorageService.listAlerts', async () => {
		alertStorageService.listAlerts.mockResolvedValue({
			alerts: [],
			hasMore: false,
			nextBefore: null,
		});

		await request(app)
			.get('/api/alerts?symbol=BTCUSDT&eventCategory=price_surge&exchange=BINANCE')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.listAlerts).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			eventCategory: 'price_surge',
			exchange: 'BINANCE',
		}));
	});

	it('returns 400 when GET /api/alerts receives invalid filter values', async () => {
		const emptySymbol = await request(app)
			.get('/api/alerts?symbol=')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(emptySymbol.body).toEqual({
			error: 'Invalid symbol filter. Use a non-empty string up to 64 characters.',
			code: 'INVALID_REQUEST',
		});

		const emptyCategory = await request(app)
			.get('/api/alerts?eventCategory=')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(emptyCategory.body).toEqual({
			error: 'Invalid eventCategory filter. Use a non-empty string up to 64 characters.',
			code: 'INVALID_REQUEST',
		});

		const emptyExchange = await request(app)
			.get('/api/alerts?exchange=')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(emptyExchange.body).toEqual({
			error: 'Invalid exchange filter. Use a non-empty string up to 64 characters.',
			code: 'INVALID_REQUEST',
		});

		const whitespaceSymbol = await request(app)
			.get('/api/alerts?symbol=%20%20%20')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(whitespaceSymbol.body).toEqual({
			error: 'Invalid symbol filter. Use a non-empty string up to 64 characters.',
			code: 'INVALID_REQUEST',
		});
	});

	it('accepts an opaque nextBefore cursor from a previous response', async () => {
		const before = encodeAlertPaginationCursor({
			receivedAt: '2026-06-06T12:00:00.000Z',
			id: 'alert-1',
		});
		alertStorageService.listAlerts.mockResolvedValue({
			alerts: [],
			hasMore: false,
			nextBefore: null,
		});

		await request(app)
			.get(`/api/alerts?before=${encodeURIComponent(before)}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.listAlerts).toHaveBeenCalledWith({
			before,
			enriched: undefined,
			limit: 50,
			source: undefined,
		});
	});

	it('returns 403 when alert storage is disabled', async () => {
		alertStorageService.isEnabled.mockReturnValue(false);

		const res = await request(app)
			.get('/api/alerts')
			.set('x-api-key', 'test-key')
			.expect(403);

		expect(res.body).toEqual({
			error: 'Alert storage feature is disabled. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to enable.',
			code: 'FEATURE_DISABLED',
		});
	});

	it('returns 503 when Firestore reads are unavailable for the list endpoint', async () => {
		const error = new Error('Alert storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
		error.code = 'STORAGE_UNAVAILABLE';
		alertStorageService.listAlerts.mockRejectedValue(error);

		const res = await request(app)
			.get('/api/alerts')
			.set('x-api-key', 'test-key')
			.expect(503);

		expect(res.body).toEqual({
			error: 'Alert storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.',
			code: 'STORAGE_UNAVAILABLE',
		});
	});

	it('returns an alert analytics summary for a bounded time window', async () => {
		alertStorageService.summarizeAlerts.mockResolvedValue({
			window: {
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
				maxDays: 31,
			},
			totalAlerts: 2,
			bySource: { webhook: 2 },
			bySymbol: { BTCUSDT: 1, ETHUSDT: 1 },
			byFeatureFlag: {
				enriched: 1,
				plain: 1,
				tradingViewData: 1,
				withoutTradingViewData: 1,
			},
			enrichment: {
				enrichedAlerts: 1,
				plainAlerts: 1,
				tokenUsage: {
					inputTokens: 10,
					outputTokens: 20,
					totalTokens: 30,
					totalCost: 0.001,
				},
			},
			delivery: {
				totalSuccess: 2,
				totalFailure: 1,
				byChannel: {
					telegram: { total: 2, success: 1, failure: 1 },
					whatsapp: { total: 1, success: 1, failure: 0 },
				},
			},
			latency: {
				averageProcessingMs: null,
				averageDeliveryMs: 125,
			},
		});

		const res = await request(app)
			.get('/api/alerts/summary?from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&limit=200&source=webhook&enriched=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.summarizeAlerts).toHaveBeenCalledWith({
			from: '2026-06-06T00:00:00.000Z',
			limit: 200,
			to: '2026-06-07T00:00:00.000Z',
			source: 'webhook',
			enriched: true,
		});
		expect(res.body).toEqual({
			success: true,
			summary: {
				window: {
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
					maxDays: 31,
				},
				totalAlerts: 2,
				bySource: { webhook: 2 },
				bySymbol: { BTCUSDT: 1, ETHUSDT: 1 },
				byFeatureFlag: {
					enriched: 1,
					plain: 1,
					tradingViewData: 1,
					withoutTradingViewData: 1,
				},
				enrichment: {
					enrichedAlerts: 1,
					plainAlerts: 1,
					tokenUsage: {
						inputTokens: 10,
						outputTokens: 20,
						totalTokens: 30,
						totalCost: 0.001,
					},
				},
				delivery: {
					totalSuccess: 2,
					totalFailure: 1,
					byChannel: {
						telegram: { total: 2, success: 1, failure: 1 },
						whatsapp: { total: 1, success: 1, failure: 0 },
					},
				},
				latency: {
					averageProcessingMs: null,
					averageDeliveryMs: 125,
				},
			},
		});
	});

	it('returns risk metadata coverage from the protected summary endpoint', async () => {
		const riskMetadataCoverage = {
			denominator: 2,
			fields: {
				invalidation_level: { populated: 1, percentage: 50 },
				target_level: { populated: 0, percentage: 0 },
				setup_type: { populated: 1, percentage: 50 },
				risk_reward_ratio: { populated: 1, percentage: 50 },
			},
			byPromptProvenance: [],
		};
		alertStorageService.summarizeAlerts.mockResolvedValue({
			enrichment: { riskMetadataCoverage },
		});

		const res = await request(app)
			.get('/api/alerts/summary')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.summary.enrichment.riskMetadataCoverage).toEqual(riskMetadataCoverage);
		expect(res.body.summary.shadowModeMetrics).toBe('No measurements found');
	});

	it('returns evidence coverage from the protected summary endpoint', async () => {
		const evidenceCoverage = {
			denominator: 2,
			zeroSources: { populated: 1, percentage: 50 },
			oneToTwoSources: { populated: 0, percentage: 0 },
			threePlusSources: { populated: 1, percentage: 50 },
			totalSourceCount: 3,
			averageSourceCount: 1.5,
			byPromptProvenance: [],
		};
		alertStorageService.summarizeAlerts.mockResolvedValue({
			enrichment: { evidenceCoverage },
		});

		const res = await request(app)
			.get('/api/alerts/summary')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.summary.enrichment.evidenceCoverage).toEqual(evidenceCoverage);
	});

	it('omits unfiltered shadow metrics from filtered summaries', async () => {
		signalOutcomeService.isEnabled.mockReturnValue(true);
		signalOutcomeService.getMetricsSummary.mockResolvedValue({ totalSignalsReceived: 99 });
		alertStorageService.summarizeAlerts.mockResolvedValue({ totalAlerts: 1 });

		const res = await request(app)
			.get('/api/alerts/summary?source=webhook&enriched=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.summary.shadowModeMetrics).toBeUndefined();
		expect(signalOutcomeService.getMetricsSummary).not.toHaveBeenCalled();
	});

	it('returns 400 when the summary window is invalid', async () => {
		const res = await request(app)
			.get('/api/alerts/summary?from=not-a-date')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body).toEqual({
			error: 'Invalid from timestamp. Use an ISO-8601 timestamp.',
			code: 'INVALID_REQUEST',
		});
		expect(alertStorageService.summarizeAlerts).not.toHaveBeenCalled();
	});

	it('returns 400 when the summary service rejects an inverted time window', async () => {
		const error = new Error('Invalid summary window. from must be before or equal to to.');
		error.code = 'INVALID_REQUEST';
		alertStorageService.summarizeAlerts.mockRejectedValue(error);

		const res = await request(app)
			.get('/api/alerts/summary?from=2026-06-07T00:00:00.000Z&to=2026-06-06T00:00:00.000Z')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body).toEqual({
			error: 'Invalid summary window. from must be before or equal to to.',
			code: 'INVALID_REQUEST',
		});
	});

	it('passes symbol, eventCategory, and exchange filters to alertStorageService.summarizeAlerts', async () => {
		alertStorageService.summarizeAlerts.mockResolvedValue({
			totalAlerts: 0,
			bySource: {},
			bySymbol: {},
		});

		await request(app)
			.get('/api/alerts/summary?symbol=BTCUSDT&eventCategory=price_surge&exchange=BINANCE')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.summarizeAlerts).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			eventCategory: 'price_surge',
			exchange: 'BINANCE',
		}));
	});

	it('returns 400 when GET /api/alerts/summary receives invalid filter values', async () => {
		const emptySymbol = await request(app)
			.get('/api/alerts/summary?symbol=')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(emptySymbol.body).toEqual({
			error: 'Invalid symbol filter. Use a non-empty string up to 64 characters.',
			code: 'INVALID_REQUEST',
		});

		const emptyCategory = await request(app)
			.get('/api/alerts/summary?eventCategory=')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(emptyCategory.body).toEqual({
			error: 'Invalid eventCategory filter. Use a non-empty string up to 64 characters.',
			code: 'INVALID_REQUEST',
		});

		const emptyExchange = await request(app)
			.get('/api/alerts/summary?exchange=')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(emptyExchange.body).toEqual({
			error: 'Invalid exchange filter. Use a non-empty string up to 64 characters.',
			code: 'INVALID_REQUEST',
		});
	});

	it('exports bounded stored alerts as JSONL without raw text by default', async () => {
		alertStorageService.exportAlerts.mockResolvedValue({
			window: {
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 2,
				maxDays: 31,
			},
			alerts: [
				{
					id: 'alert-1',
					receivedAt: '2026-06-06T12:00:00.000Z',
					source: 'webhook',
					enriched: true,
					useTradingViewData: false,
					deliveryResults: [{ channel: 'telegram', success: true, messageId: 'tg-1', errorCode: null, statusCode: null }],
					tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, totalCost: 0.001 },
				},
			],
		});

		const res = await request(app)
			.get('/api/alerts/export?format=jsonl&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&limit=2&source=webhook&enriched=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.exportAlerts).toHaveBeenCalledWith({
			from: '2026-06-06T00:00:00.000Z',
			to: '2026-06-07T00:00:00.000Z',
			limit: 2,
			source: 'webhook',
			enriched: true,
			includeText: false,
			includeEnrichment: false,
		});
		expect(res.headers['content-type']).toContain('application/x-ndjson');
		expect(res.headers['x-shadow-mode-metrics']).toBeUndefined();
		expect(res.text.trim().split('\n').map(line => JSON.parse(line))).toEqual([
			{
				id: 'alert-1',
				receivedAt: '2026-06-06T12:00:00.000Z',
				source: 'webhook',
				enriched: true,
				useTradingViewData: false,
				deliveryResults: [{ channel: 'telegram', success: true, messageId: 'tg-1', errorCode: null, statusCode: null }],
				tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, totalCost: 0.001 },
			},
		]);
		expect(res.text).not.toContain('raw secret text');
	});

	it('exports bounded stored alerts as CSV with optional text', async () => {
		alertStorageService.exportAlerts.mockResolvedValue({
			window: {
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 1,
				maxDays: 31,
			},
			alerts: [
				{
					id: '=alert-1',
					receivedAt: '-42',
					source: '@webhook',
					enriched: false,
					useTradingViewData: true,
					tradingViewEnrichmentStatus: 'partial',
					deliveryResults: [{ channel: 'whatsapp', success: false, messageId: null, errorCode: 'PROVIDER_LIMIT', statusCode: 429 }],
				suppressedRepeat: true,
				tokenUsage: null,
					text: '=@SUM(1,1), "quoted"\r\n+next',
				},
			],
		});

		const res = await request(app)
			.get('/api/alerts/export?format=csv&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&limit=1&includeText=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.exportAlerts).toHaveBeenCalledWith({
			from: '2026-06-06T00:00:00.000Z',
			to: '2026-06-07T00:00:00.000Z',
			limit: 1,
			source: undefined,
			enriched: undefined,
			includeText: true,
			includeEnrichment: false,
		});
		expect(res.headers['content-type']).toContain('text/csv');
		expect(res.text).toContain('id,requestId,receivedAt,source,enriched,useTradingViewData,tradingViewEnrichmentApplied,tradingViewEnrichmentStatus,eventCategory,confidence,sentimentScore,dedupStatus,channels,deliveryResults,suppressedRepeat,tokenUsage,text');
		expect(res.text).toContain("'=alert-1,,-42,'@webhook");
		expect(res.text).toContain('"\'=@SUM(1,1), ""quoted""\r\n+next"');
		expect(res.text).not.toContain('=alert-1,-42,@webhook');
		expect(res.text).toContain('PROVIDER_LIMIT');
		expect(res.text).toContain('}]",true,,');
	});

	it('includes news-monitor metadata in CSV export', async () => {
		alertStorageService.exportAlerts.mockResolvedValue({
			alerts: [
				{
					id: 'news-123',
					requestId: 'req-news-456',
					receivedAt: '2026-06-06T12:00:00.000Z',
					source: 'news-monitor',
					enriched: true,
					useTradingViewData: false,
					tradingViewEnrichmentApplied: false,
					tradingViewEnrichmentStatus: 'not_applicable',
					eventCategory: 'price_surge',
					confidence: 0.85,
					sentimentScore: 0.75,
					dedupStatus: 'fresh',
					channels: ['telegram'],
					deliveryResults: [{ channel: 'telegram', success: true }],
					tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, totalCost: 0.001 },
					text: 'BTCUSDT: Bitcoin surges past 100k',
				},
			],
		});

		const res = await request(app)
			.get('/api/alerts/export?format=csv&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&source=news-monitor&includeText=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.headers['content-type']).toContain('text/csv');
		expect(res.text).toContain('id,requestId,receivedAt,source,enriched,useTradingViewData,tradingViewEnrichmentApplied,tradingViewEnrichmentStatus,eventCategory,confidence,sentimentScore,dedupStatus,channels,deliveryResults,suppressedRepeat,tokenUsage,text');
		expect(res.text).toContain('news-123,req-news-456,2026-06-06T12:00:00.000Z,news-monitor,true,false,false,not_applicable,price_surge,0.85,0.75,fresh');
		expect(res.text).toContain('BTCUSDT: Bitcoin surges past 100k');
	});

	it('neutralizes tab- and carriage-return-prefixed formulas in CSV strings', async () => {
		alertStorageService.exportAlerts.mockResolvedValue({
			alerts: [{
				id: '\t=alert-1',
				receivedAt: '\r@received-at',
				source: 'webhook',
				text: '\n=alert-text',
			}],
		});

		const res = await request(app)
			.get('/api/alerts/export?format=csv&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&includeText=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.text).toContain("'\t=alert-1");
		expect(res.text).toContain('"\'\r@received-at"');
		expect(res.text).toContain('"\'\n=alert-text"');
	});

	it('returns 400 when export bounds are missing', async () => {
		const res = await request(app)
			.get('/api/alerts/export?format=jsonl&from=2026-06-06T00:00:00.000Z')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body).toEqual({
			error: 'Export requests require bounded from and to ISO-8601 timestamps.',
			code: 'INVALID_REQUEST',
		});
		expect(alertStorageService.exportAlerts).not.toHaveBeenCalled();
	});

	it('returns 400 when export format is invalid', async () => {
		const res = await request(app)
			.get('/api/alerts/export?format=xlsx&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body).toEqual({
			error: 'Invalid export format. Use jsonl or csv.',
			code: 'INVALID_REQUEST',
		});
		expect(alertStorageService.exportAlerts).not.toHaveBeenCalled();
	});

	it('returns 400 when includeEnrichment flag is invalid', async () => {
		const res = await request(app)
			.get('/api/alerts/export?format=jsonl&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&includeEnrichment=maybe')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body).toEqual({
			error: 'Invalid includeEnrichment flag. Use true or false.',
			code: 'INVALID_REQUEST',
		});
		expect(alertStorageService.exportAlerts).not.toHaveBeenCalled();
	});

	it('exports bounded stored alerts with enrichmentData when includeEnrichment=true is requested', async () => {
		alertStorageService.exportAlerts.mockResolvedValue({
			window: {
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 1,
				maxDays: 31,
			},
			alerts: [
				{
					id: 'alert-enrich-1',
					receivedAt: '2026-06-06T12:00:00.000Z',
					source: 'webhook',
					enriched: true,
					enrichmentData: {
						sentiment: 'BULLISH',
						sentiment_score: 0.85,
						setup_type: 'breakout',
						invalidation_level: 64200,
						target_level: 68500,
						risk_reward_ratio: 2.5,
						sourceCount: 2,
						sourceDomains: ['coindesk.com'],
						tradingViewEnrichmentApplied: true,
						tradingViewEnrichmentStatus: 'full',
						promptProvenance: {
							name: 'crypto-sentiment',
							source: 'langfuse',
							label: 'production',
							version: 3,
							schemaDriftDetected: false,
						},
					},
				},
			],
		});

		const res = await request(app)
			.get('/api/alerts/export?format=jsonl&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&includeEnrichment=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.exportAlerts).toHaveBeenCalledWith({
			from: '2026-06-06T00:00:00.000Z',
			to: '2026-06-07T00:00:00.000Z',
			limit: 500,
			source: undefined,
			enriched: undefined,
			includeText: false,
			includeEnrichment: true,
		});

		const parsed = JSON.parse(res.text.trim());
		expect(parsed).toHaveProperty('enrichmentData');
		expect(parsed.enrichmentData.sentiment).toBe('BULLISH');
		expect(parsed.enrichmentData.sourceDomains).toEqual(['coindesk.com']);
	});

	it('exports bounded stored alerts as CSV with enrichmentData column when includeEnrichment=true', async () => {
		alertStorageService.exportAlerts.mockResolvedValue({
			window: {
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 1,
				maxDays: 31,
			},
			alerts: [
				{
					id: 'alert-csv-enrich-1',
					receivedAt: '2026-06-06T12:00:00.000Z',
					source: 'webhook',
					enriched: true,
					enrichmentData: {
						sentiment: 'BULLISH',
						sentiment_score: 0.85,
						setup_type: 'breakout',
					},
				},
			],
		});

		const res = await request(app)
			.get('/api/alerts/export?format=csv&from=2026-06-06T00:00:00.000Z&to=2026-06-07T00:00:00.000Z&includeEnrichment=true')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.headers['content-type']).toContain('text/csv');
		expect(res.text).toContain('enrichmentData');
		expect(res.text).toContain('alert-csv-enrich-1');
		expect(res.text).toContain('""sentiment"":""BULLISH""');
	});

	it('returns a single stored alert by id', async () => {
		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-123',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Single alert',
			enriched: false,
			enrichmentData: null,
			tokenUsage: null,
			deliveryResults: [],
			source: 'webhook',
			useTradingViewData: true,
		});

		const res = await request(app)
			.get('/api/alerts/alert-123')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.getAlertById).toHaveBeenCalledWith('alert-123');
		expect(res.body).toEqual({
			success: true,
			alert: {
				id: 'alert-123',
				receivedAt: '2026-06-06T12:34:56.000Z',
				text: 'Single alert',
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				deliveryResults: [],
				source: 'webhook',
				useTradingViewData: true,
			},
			lastReplay: null,
		});
	});

	it('returns 404 when the alert id is not found', async () => {
		alertStorageService.getAlertById.mockResolvedValue(null);

		const res = await request(app)
			.get('/api/alerts/missing-alert')
			.set('x-api-key', 'test-key')
			.expect(404);

		expect(res.body).toEqual({
			error: 'Alert not found',
			code: 'NOT_FOUND',
		});
	});

	it('returns 503 when Firestore reads are unavailable for the detail endpoint', async () => {
		const error = new Error('Alert storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
		error.code = 'STORAGE_UNAVAILABLE';
		alertStorageService.getAlertById.mockRejectedValue(error);

		const res = await request(app)
			.get('/api/alerts/alert-123')
			.set('x-api-key', 'test-key')
			.expect(503);

		expect(res.body).toEqual({
			error: 'Alert storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.',
			code: 'STORAGE_UNAVAILABLE',
		});
	});

	it('replays a stored alert to selected channels and records the replay attempt', async () => {
		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-123',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Replay me',
			enriched: true,
			enrichmentData: { sentiment: 'bullish' },
			tokenUsage: { totalTokens: 42 },
			deliveryResults: [{ channel: 'whatsapp', success: false }],
			source: 'webhook',
			useTradingViewData: false,
		});

		const res = await request(app)
			.post('/api/alerts/alert-123/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-key-1')
			.send({ channels: ['telegram'] })
			.expect(200);

		expect(mockNotificationManager.sendToChannels).toHaveBeenCalledWith({
			text: 'Replay me',
			enriched: { sentiment: 'bullish' },
			source: 'webhook',
			replay: {
				originalAlertId: 'alert-123',
				idempotencyKey: 'replay-key-1',
			},
		}, ['telegram']);
		expect(alertStorageService.saveReplayAttempt).toHaveBeenCalledWith({
			alertId: 'alert-123',
			idempotencyKey: 'replay-key-1',
			channels: ['telegram'],
			deliveryResults: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
		});
		expect(res.body).toEqual({
			success: true,
			alertId: 'alert-123',
			replayId: 'replay-1',
			results: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
		});
	});

	it('accepts x-idempotency-key when replaying a stored alert', async () => {
		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-123',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Replay me',
			enriched: false,
			enrichmentData: null,
			tokenUsage: null,
			deliveryResults: [],
			source: 'webhook',
			useTradingViewData: false,
		});

		const res = await request(app)
			.post('/api/alerts/alert-123/replay')
			.set('x-api-key', 'test-key')
			.set('x-idempotency-key', 'replay-x-key-1')
			.send({ channels: ['telegram'] })
			.expect(200);

		expect(alertStorageService.saveReplayAttempt).toHaveBeenCalledWith({
			alertId: 'alert-123',
			idempotencyKey: 'replay-x-key-1',
			channels: ['telegram'],
			deliveryResults: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
		});
		expect(res.body.success).toBe(true);
	});

	it('returns 400 when replay is missing an idempotency key', async () => {
		const res = await request(app)
			.post('/api/alerts/alert-123/replay')
			.set('x-api-key', 'test-key')
			.send({ channels: ['telegram'] })
			.expect(400);

		expect(res.body).toEqual({
			error: 'Replay requests require an idempotency-key or x-idempotency-key header or idempotencyKey body field.',
			code: 'INVALID_REQUEST',
		});
	});

	it('returns 400 when replay channels contain unsupported names', async () => {
		const res = await request(app)
			.post('/api/alerts/alert-123/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-key-2')
			.send({ channels: ['telegram', 'slack'] })
			.expect(400);

		expect(res.body).toEqual({
			error: 'Unknown channel(s): slack. Valid channels: telegram, whatsapp, discord.',
			code: 'INVALID_REQUEST',
		});
	});

	it('returns payload preview and skips delivery/persistence on dryRun=true via body', async () => {
		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-123',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Replay me (dry-run)',
			enriched: true,
			enrichmentData: { sentiment: 'bullish' },
			tokenUsage: { totalTokens: 42 },
			deliveryResults: [{ channel: 'telegram', success: true, threadId: 7 }],
			source: 'webhook',
			useTradingViewData: false,
			telegramChatId: '111',
			whatsappChatId: '222',
		});

		const res = await request(app)
			.post('/api/alerts/alert-123/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-dry-key-1')
			.send({ channels: ['telegram'], dryRun: true })
			.expect(200);

		expect(mockNotificationManager.sendToChannels).not.toHaveBeenCalled();
		expect(alertStorageService.saveReplayAttempt).not.toHaveBeenCalled();

		const expectedHashPrefix1 = crypto.createHash('sha256').update('replay-dry-key-1').digest('hex').slice(0, 12);
		expect(res.body).toEqual({
			success: true,
			dryRun: true,
			alertId: 'alert-123',
			channels: ['telegram'],
			idempotencyKeyHashPrefix: expectedHashPrefix1,
			payloadPreview: {
				text: 'Replay me (dry-run)',
				enriched: { sentiment: 'bullish' },
				channelRouting: {
					telegramChatId: '111',
					telegramThreadId: 7,
					whatsappChatId: '222',
				},
			},
		});
		expect(res.body.idempotencyKey).toBeUndefined();
	});

	it('returns payload preview when dryRun is provided via query string', async () => {
		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-456',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Body-less dry-run',
			enriched: false,
			enrichmentData: null,
			deliveryResults: [],
			source: 'webhook',
		});

		delete process.env.WHATSAPP_CHAT_ID;

		const res = await request(app)
			.post('/api/alerts/alert-456/replay?dryRun=true')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-dry-key-2')
			.send({ channels: ['whatsapp'] })
			.expect(200);

		expect(mockNotificationManager.sendToChannels).not.toHaveBeenCalled();
		expect(alertStorageService.saveReplayAttempt).not.toHaveBeenCalled();

		const expectedHashPrefix2 = crypto.createHash('sha256').update('replay-dry-key-2').digest('hex').slice(0, 12);
		expect(res.body.dryRun).toBe(true);
		expect(res.body.alertId).toBe('alert-456');
		expect(res.body.channels).toEqual(['whatsapp']);
		expect(res.body.idempotencyKeyHashPrefix).toBe(expectedHashPrefix2);
		expect(res.body.idempotencyKey).toBeUndefined();
		expect(res.body.payloadPreview).toEqual({
			text: 'Body-less dry-run',
			enriched: null,
			channelRouting: {},
		});
	});

	it('resolves effective channel routing and topic routes from environment when stored alert lacks overrides', async () => {
		process.env.TELEGRAM_CHAT_ID = '-100123456789';
		process.env.TELEGRAM_TOPIC_ROUTES = 'webhook-signal:88,alert-replay:99';
		process.env.WHATSAPP_CHAT_ID = '12345@c.us';
		process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/xyz';

		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-effective-1',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Effective routing preview',
			enriched: false,
			enrichmentData: null,
			deliveryResults: [{ channel: 'telegram', success: false }],
			source: 'webhook-signal',
		});

		const res = await request(app)
			.post('/api/alerts/alert-effective-1/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-effective-key')
			.send({ channels: ['telegram', 'whatsapp', 'discord'], dryRun: true })
			.expect(200);

		expect(mockNotificationManager.sendToChannels).not.toHaveBeenCalled();
		expect(alertStorageService.saveReplayAttempt).not.toHaveBeenCalled();

		const expectedHashPrefix = crypto.createHash('sha256').update('replay-effective-key').digest('hex').slice(0, 12);
		expect(res.body.dryRun).toBe(true);
		expect(res.body.idempotencyKeyHashPrefix).toBe(expectedHashPrefix);
		expect(res.body.idempotencyKey).toBeUndefined();
		expect(res.body.payloadPreview.channelRouting).toEqual({
			telegramChatId: '-100123456789',
			telegramThreadId: 88,
			whatsappChatId: '12345@c.us',
			discordWebhookUrl: 'https://discord.com/api/webhooks/123/xyz',
		});
	});

	it('resolves alert-replay topic route when stored alert has no source and env routes are present', async () => {
		process.env.TELEGRAM_CHAT_ID = '-100123456789';
		process.env.TELEGRAM_TOPIC_ROUTES = 'webhook-signal:88,alert-replay:99';

		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-effective-2',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Replay fallback topic route',
			enriched: false,
			enrichmentData: null,
			deliveryResults: [],
		});

		const res = await request(app)
			.post('/api/alerts/alert-effective-2/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-fallback-source')
			.send({ channels: ['telegram'], dryRun: true })
			.expect(200);

		expect(res.body.payloadPreview.channelRouting).toEqual({
			telegramChatId: '-100123456789',
			telegramThreadId: 99,
		});
	});

	it('preserves custom chat without applying topic routes from environment', async () => {
		process.env.TELEGRAM_CHAT_ID = '-100123456789';
		process.env.TELEGRAM_TOPIC_ROUTES = 'webhook-signal:88,alert-replay:99';

		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-effective-3',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Custom chat without topic route',
			enriched: false,
			enrichmentData: null,
			deliveryResults: [],
			source: 'webhook-signal',
			telegramChatId: '-100999999999',
		});

		const res = await request(app)
			.post('/api/alerts/alert-effective-3/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-custom-chat')
			.send({ channels: ['telegram'], dryRun: true })
			.expect(200);

		expect(res.body.payloadPreview.channelRouting).toEqual({
			telegramChatId: '-100999999999',
		});
	});

	it('still returns payload preview when dryRun=false is explicitly provided', async () => {
		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-789',
			receivedAt: '2026-06-06T12:34:56.000Z',
			text: 'Explicit false',
			enriched: false,
			enrichmentData: null,
			deliveryResults: [],
			source: 'webhook',
		});

		const res = await request(app)
			.post('/api/alerts/alert-789/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-explicit-false')
			.send({ channels: ['telegram'], dryRun: false })
			.expect(200);

		expect(res.body.dryRun).toBeUndefined();
		expect(mockNotificationManager.sendToChannels).toHaveBeenCalledTimes(1);
		expect(alertStorageService.saveReplayAttempt).toHaveBeenCalledWith({
			alertId: 'alert-789',
			idempotencyKey: 'replay-explicit-false',
			channels: ['telegram'],
			deliveryResults: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
		});
	});

	it('returns 404 in dry-run mode when the stored alert does not exist', async () => {
		alertStorageService.getAlertById.mockResolvedValue(null);

		const res = await request(app)
			.post('/api/alerts/missing/replay')
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'replay-dry-key-3')
			.send({ channels: ['telegram'], dryRun: true })
			.expect(404);

		expect(res.body).toEqual({
			error: 'Alert not found',
			code: 'NOT_FOUND',
		});
		expect(mockNotificationManager.sendToChannels).not.toHaveBeenCalled();
		expect(alertStorageService.saveReplayAttempt).not.toHaveBeenCalled();
	});

	it('returns 403 when GET /api/alerts/replays has storage disabled', async () => {
		alertStorageService.isEnabled.mockReturnValue(false);

		const res = await request(app)
			.get('/api/alerts/replays')
			.set('x-api-key', 'test-key')
			.expect(403);

		expect(res.body).toEqual({
			error: 'Alert storage feature is disabled. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to enable.',
			code: 'FEATURE_DISABLED',
		});
		expect(alertStorageService.listReplayAttempts).not.toHaveBeenCalled();
	});

	it('returns bounded replay records with safe fields and pagination', async () => {
		const replayRecord = {
			id: '1234_uuid',
			alertId: 'alert-1',
			idempotencyKeyHashPrefix: 'abcdef012345',
			channels: ['telegram'],
			deliverySummary: [
				{ channel: 'telegram', success: true, messageId: 'tg-1' },
			],
			replayedAt: '2026-06-06T12:34:56.000Z',
			attemptId: '1234_uuid',
		};
		alertStorageService.listReplayAttempts.mockResolvedValue({
			replays: [replayRecord],
			hasMore: false,
			nextBefore: null,
		});

		const res = await request(app)
			.get('/api/alerts/replays?limit=10')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.listReplayAttempts).toHaveBeenCalledWith({
			limit: 10,
			alertId: undefined,
			before: undefined,
		});
		expect(res.body).toEqual({
			success: true,
			replays: [replayRecord],
			pagination: { hasMore: false, limit: 10, nextBefore: null },
		});
	});

	it('passes alertId filter through to listReplayAttempts', async () => {
		alertStorageService.listReplayAttempts.mockResolvedValue({
			replays: [],
			hasMore: false,
			nextBefore: null,
		});

		await request(app)
			.get('/api/alerts/replays?alertId=alert-42&limit=5')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.listReplayAttempts).toHaveBeenCalledWith({
			limit: 5,
			alertId: 'alert-42',
			before: undefined,
		});
	});

	it('passes the replay before cursor through to listReplayAttempts', async () => {
		const before = encodeAlertPaginationCursor({
			receivedAt: '2026-06-06T12:34:56.000Z',
			id: 'alert-1_replayhash_1234',
		});

		await request(app)
			.get(`/api/alerts/replays?before=${encodeURIComponent(before)}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(alertStorageService.listReplayAttempts).toHaveBeenCalledWith({
			limit: 50,
			alertId: undefined,
			before,
		});
	});

	it('returns 400 for invalid limit on GET /api/alerts/replays', async () => {
		const res = await request(app)
			.get('/api/alerts/replays?limit=999')
			.set('x-api-key', 'test-key')
			.expect(400);

		expect(res.body.code).toBe('INVALID_REQUEST');
		expect(alertStorageService.listReplayAttempts).not.toHaveBeenCalled();
	});

	it('returns 503 when GET /api/alerts/replays hits storage unavailable', async () => {
		const storageError = new Error('Firestore down');
		storageError.code = 'STORAGE_UNAVAILABLE';
		alertStorageService.listReplayAttempts.mockRejectedValue(storageError);

		const res = await request(app)
			.get('/api/alerts/replays')
			.set('x-api-key', 'test-key')
			.expect(503);

		expect(res.body).toEqual({
			error: 'Firestore down',
			code: 'STORAGE_UNAVAILABLE',
		});
	});

	it('includes lastReplay on GET /api/alerts/:alertId when a replay exists', async () => {
		const alertRecord = {
			id: 'alert-1',
			receivedAt: '2026-06-06T12:00:00.000Z',
			text: 'Hello',
			enriched: false,
			enrichmentData: null,
			tokenUsage: null,
			deliveryResults: [],
			source: 'webhook',
			useTradingViewData: false,
		};
		const lastReplay = {
			id: 'ts_uuid',
			alertId: 'alert-1',
			idempotencyKeyHashPrefix: 'abcdef012345',
			channels: ['telegram'],
			deliverySummary: [{ channel: 'telegram', success: true }],
			replayedAt: '2026-06-06T12:34:56.000Z',
			attemptId: 'ts_uuid',
		};
		alertStorageService.getAlertById.mockResolvedValue(alertRecord);
		alertStorageService.getLatestReplayForAlert.mockResolvedValue(lastReplay);

		const res = await request(app)
			.get('/api/alerts/alert-1')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.alert).toEqual(alertRecord);
		expect(res.body.lastReplay).toEqual(lastReplay);
	});

	it('omits lastReplay on GET /api/alerts/:alertId when no replay exists', async () => {
		alertStorageService.getAlertById.mockResolvedValue({
			id: 'alert-2',
			receivedAt: '2026-06-06T12:00:00.000Z',
			text: 'Hello',
			enriched: false,
			enrichmentData: null,
			tokenUsage: null,
			deliveryResults: [],
			source: 'webhook',
			useTradingViewData: false,
		});
		alertStorageService.getLatestReplayForAlert.mockResolvedValue(null);

		const res = await request(app)
			.get('/api/alerts/alert-2')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.lastReplay).toBeNull();
	});

	describe('POST /api/alerts/batch/replay', () => {
		it('returns 401 when request lacks valid api key', async () => {
			await request(app)
				.post('/api/alerts/batch/replay')
				.send({ alertIds: ['alert-1'] })
				.expect(401);
		});

		it('returns 403 when alert storage is disabled', async () => {
			alertStorageService.isEnabled.mockReturnValue(false);
			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'], idempotencyKey: 'k-1' })
				.expect(403);
			expect(res.body.code).toBe('FEATURE_DISABLED');
		});

		it('returns 400 when alertIds is missing or empty', async () => {
			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: [], idempotencyKey: 'k-1' })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when alertIds exceeds MAX_BATCH_REPLAY_LIMIT (50)', async () => {
			const tooMany = Array.from({ length: 51 }, (_, i) => `alert-${i}`);
			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: tooMany, idempotencyKey: 'k-1' })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when idempotency key is missing', async () => {
			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'] })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when channels contain invalid names', async () => {
			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'], idempotencyKey: 'k-1', channels: ['telegram', 'slack'] })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('replays alerts live to selected channels and records attempts', async () => {
			alertStorageService.getAlertById
				.mockResolvedValueOnce({
					id: 'alert-1',
					text: 'Alert 1 body',
					source: 'webhook',
					telegramChatId: '-100123',
				})
				.mockResolvedValueOnce({
					id: 'alert-2',
					text: 'Alert 2 body',
					source: 'webhook',
				});
			alertStorageService.saveReplayAttempt
				.mockResolvedValueOnce('replay-doc-1')
				.mockResolvedValueOnce('replay-doc-2');

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.set('x-idempotency-key', 'batch-k-1')
				.send({ alertIds: ['alert-1', 'alert-2'], channels: ['telegram'] })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results).toHaveLength(2);
			expect(res.body.results[0]).toEqual({
				alertId: 'alert-1',
				success: true,
				replayId: 'replay-doc-1',
				results: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
			});
			expect(mockNotificationManager.sendToChannels).toHaveBeenCalledTimes(2);
			expect(alertStorageService.saveReplayAttempt).toHaveBeenCalledTimes(2);
		});

		it('handles missing or expired alerts gracefully in the results list', async () => {
			alertStorageService.getAlertById
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({ id: 'alert-2', text: 'Live alert' });
			alertStorageService.saveReplayAttempt.mockResolvedValueOnce('replay-doc-2');

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['missing-alert', 'alert-2'], idempotencyKey: 'batch-k-2' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results[0]).toEqual({
				alertId: 'missing-alert',
				success: false,
				error: 'Alert not found',
				code: 'NOT_FOUND',
			});
			expect(res.body.results[1].success).toBe(true);
		});

		it('supports dryRun preview without sending notifications or writing to Firestore', async () => {
			alertStorageService.getAlertById.mockResolvedValueOnce({
				id: 'alert-1',
				text: 'Dry run alert',
				enrichmentData: { sentiment: 'BULLISH' },
				telegramChatId: '12345',
			});

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'], dryRun: true, idempotencyKey: 'batch-dry-1' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.dryRun).toBe(true);
			expect(res.body.results[0].dryRun).toBe(true);
			expect(res.body.results[0].payloadPreview.text).toBe('Dry run alert');
			expect(mockNotificationManager.sendToChannels).not.toHaveBeenCalled();
			expect(alertStorageService.saveReplayAttempt).not.toHaveBeenCalled();
		});

		it('reconciles and skips previously delivered alerts on batch retry', async () => {
			alertStorageService.getAlertById
				.mockResolvedValueOnce({ id: 'alert-1', text: 'Alert 1' })
				.mockResolvedValueOnce({ id: 'alert-2', text: 'Alert 2' });
			alertStorageService.getReplayAttemptByIdempotencyKey
				.mockResolvedValueOnce({ id: 'replay-doc-1', deliveryResults: [{ channel: 'telegram', success: true }] })
				.mockResolvedValueOnce(null);
			alertStorageService.saveReplayAttempt.mockResolvedValueOnce('replay-doc-2');

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.set('x-idempotency-key', 'batch-retry-key')
				.send({ alertIds: ['alert-1', 'alert-2'], channels: ['telegram'] })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results).toHaveLength(2);
			// alert-1 was reconciled, so sendToChannels was only called once (for alert-2)
			expect(mockNotificationManager.sendToChannels).toHaveBeenCalledTimes(1);
			expect(res.body.results[0]).toEqual({
				alertId: 'alert-1',
				success: true,
				replayId: 'replay-doc-1',
				results: [{ channel: 'telegram', success: true }],
			});
			expect(res.body.results[1].success).toBe(true);
			expect(res.body.results[1].replayId).toBe('replay-doc-2');
		});

		it('fails open when saveReplayAttempt rejects, preserving delivery results without returning 503', async () => {
			alertStorageService.getAlertById.mockResolvedValueOnce({ id: 'alert-1', text: 'Alert 1' });
			alertStorageService.getReplayAttemptByIdempotencyKey.mockResolvedValueOnce(null);
			alertStorageService.saveReplayAttempt.mockRejectedValueOnce(new Error('Firestore write quota exceeded'));

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'], idempotencyKey: 'fail-open-k' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results[0]).toEqual({
				alertId: 'alert-1',
				success: true,
				replayId: null,
				results: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
			});
		});

		it('records per-alert failure when sendToChannels throws without breaking remaining items in batch', async () => {
			alertStorageService.getAlertById
				.mockResolvedValueOnce({ id: 'alert-1', text: 'Alert 1' })
				.mockResolvedValueOnce({ id: 'alert-2', text: 'Alert 2' });
			alertStorageService.getReplayAttemptByIdempotencyKey
				.mockResolvedValue(null);
			mockNotificationManager.sendToChannels
				.mockRejectedValueOnce(new Error('Telegram API unreachable'))
				.mockResolvedValueOnce([{ channel: 'telegram', success: true, messageId: 'tg-2' }]);
			alertStorageService.saveReplayAttempt.mockResolvedValueOnce('replay-doc-2');

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1', 'alert-2'], idempotencyKey: 'delivery-fail-k' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results[0]).toEqual({
				alertId: 'alert-1',
				success: false,
				error: 'Telegram API unreachable',
				code: 'DELIVERY_FAILED',
			});
			expect(res.body.results[1].success).toBe(true);
		});

		it('marks replay item failed and avoids saving attempt when sendToChannels returns failure or empty array', async () => {
			alertStorageService.getAlertById
				.mockResolvedValueOnce({ id: 'alert-1', text: 'Alert 1' })
				.mockResolvedValueOnce({ id: 'alert-2', text: 'Alert 2' });
			alertStorageService.getReplayAttemptByIdempotencyKey.mockResolvedValue(null);
			mockNotificationManager.sendToChannels
				.mockResolvedValueOnce([{ channel: 'telegram', success: false, error: 'Chat not found' }])
				.mockResolvedValueOnce([]);

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1', 'alert-2'], idempotencyKey: 'fail-channels-k' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(res.body.results[0]).toEqual({
				alertId: 'alert-1',
				success: false,
				error: 'Channel delivery failed',
				code: 'DELIVERY_FAILED',
				results: [{ channel: 'telegram', success: false, error: 'Chat not found' }],
			});
			expect(res.body.results[1]).toEqual({
				alertId: 'alert-2',
				success: false,
				error: 'No notification channels delivered',
				code: 'DELIVERY_FAILED',
				results: [],
			});
			expect(alertStorageService.saveReplayAttempt).not.toHaveBeenCalled();
		});

		it('does not reconcile failed or empty past attempts as delivered on retry', async () => {
			alertStorageService.getAlertById.mockResolvedValueOnce({ id: 'alert-1', text: 'Alert 1' });
			alertStorageService.getReplayAttemptByIdempotencyKey.mockResolvedValueOnce({
				id: 'replay-doc-failed',
				deliveryResults: [{ channel: 'telegram', success: false }],
			});
			mockNotificationManager.sendToChannels.mockResolvedValueOnce([{ channel: 'telegram', success: true, messageId: 'tg-retry' }]);
			alertStorageService.saveReplayAttempt.mockResolvedValueOnce('replay-doc-new');

			const res = await request(app)
				.post('/api/alerts/batch/replay')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'], idempotencyKey: 'retry-past-failed-k' })
				.expect(200);

			expect(res.body.success).toBe(true);
			expect(mockNotificationManager.sendToChannels).toHaveBeenCalledTimes(1);
			expect(alertStorageService.saveReplayAttempt).toHaveBeenCalledTimes(1);
			expect(res.body.results[0]).toEqual({
				alertId: 'alert-1',
				success: true,
				replayId: 'replay-doc-new',
				results: [{ channel: 'telegram', success: true, messageId: 'tg-retry' }],
			});
		});
	});

	describe('POST /api/alerts/batch/export', () => {
		it('returns 401 when lacking valid api key', async () => {
			await request(app)
				.post('/api/alerts/batch/export')
				.send({ alertIds: ['alert-1'] })
				.expect(401);
		});

		it('returns 400 when alertIds is missing or invalid', async () => {
			const res = await request(app)
				.post('/api/alerts/batch/export')
				.set('x-api-key', 'test-key')
				.send({ alertIds: [] })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when alertIds exceeds 1000', async () => {
			const tooMany = Array.from({ length: 1001 }, (_, i) => `alert-${i}`);
			const res = await request(app)
				.post('/api/alerts/batch/export')
				.set('x-api-key', 'test-key')
				.send({ alertIds: tooMany })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when format is invalid', async () => {
			const res = await request(app)
				.post('/api/alerts/batch/export')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'], format: 'xml' })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('exports batch alerts as JSONL by default', async () => {
			alertStorageService.exportAlertsByIds.mockResolvedValueOnce({
				alerts: [
					{ id: 'alert-1', receivedAt: '2026-06-06T12:00:00.000Z', source: 'webhook' },
					{ id: 'alert-2', receivedAt: '2026-06-06T13:00:00.000Z', source: 'webhook' },
				],
			});

			const res = await request(app)
				.post('/api/alerts/batch/export')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1', 'alert-2'] })
				.expect(200);

			expect(res.headers['content-type']).toContain('application/x-ndjson');
			expect(res.headers['content-disposition']).toContain('attachment; filename="alerts-batch-export-');
			expect(res.text).toContain('alert-1');
			expect(res.text).toContain('alert-2');
		});

		it('exports batch alerts as CSV when requested', async () => {
			alertStorageService.exportAlertsByIds.mockResolvedValueOnce({
				alerts: [
					{ id: 'alert-1', receivedAt: '2026-06-06T12:00:00.000Z', source: 'webhook', deliverySummary: { total: 1, sent: 1, failed: 0 } },
				],
			});

			const res = await request(app)
				.post('/api/alerts/batch/export')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'], format: 'csv' })
				.expect(200);

			expect(res.headers['content-type']).toContain('text/csv');
			expect(res.text).toContain('id,requestId,receivedAt');
			expect(res.text).toContain('alert-1');
		});

		it('returns 503 when exportAlertsByIds throws STORAGE_UNAVAILABLE', async () => {
			const error = new Error('Firestore read timeout');
			error.code = 'STORAGE_UNAVAILABLE';
			alertStorageService.exportAlertsByIds.mockRejectedValueOnce(error);

			const res = await request(app)
				.post('/api/alerts/batch/export')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1'] })
				.expect(503);

			expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
		});
	});

	describe('POST /api/alerts/batch/delete', () => {
		it('returns 401 when lacking valid api key', async () => {
			await request(app)
				.post('/api/alerts/batch/delete')
				.send({ alertIds: ['alert-1'] })
				.expect(401);
		});

		it('returns 400 when alertIds is missing or invalid', async () => {
			const res = await request(app)
				.post('/api/alerts/batch/delete')
				.set('x-api-key', 'test-key')
				.send({ alertIds: [] })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when alertIds exceeds MAX_BATCH_DELETE_LIMIT (500)', async () => {
			const tooMany = Array.from({ length: 501 }, (_, i) => `alert-${i}`);
			const res = await request(app)
				.post('/api/alerts/batch/delete')
				.set('x-api-key', 'test-key')
				.send({ alertIds: tooMany })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('deletes batch of alerts and returns deleted count', async () => {
			alertStorageService.deleteAlerts.mockResolvedValueOnce({ deleted: 3 });

			const res = await request(app)
				.post('/api/alerts/batch/delete')
				.set('x-api-key', 'test-key')
				.send({ alertIds: ['alert-1', 'alert-2', 'alert-3'] })
				.expect(200);

			expect(res.body).toEqual({ success: true, deleted: 3 });
			expect(alertStorageService.deleteAlerts).toHaveBeenCalledWith(['alert-1', 'alert-2', 'alert-3']);
		});
	});
});
