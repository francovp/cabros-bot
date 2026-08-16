'use strict';

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	listAlerts: jest.fn(),
	getAlertById: jest.fn(),
	saveReplayAttempt: jest.fn(),
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
					deliveryResults: [{ channel: 'whatsapp', success: false, messageId: null, errorCode: 'PROVIDER_LIMIT', statusCode: 429 }],
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
		});
		expect(res.headers['content-type']).toContain('text/csv');
		expect(res.text).toContain('id,receivedAt,source,enriched,useTradingViewData,tradingViewEnrichmentApplied,channels,deliveryResults,tokenUsage,text');
		expect(res.text).toContain("'=alert-1,-42,'@webhook");
		expect(res.text).toContain('"\'=@SUM(1,1), ""quoted""\r\n+next"');
		expect(res.text).not.toContain('=alert-1,-42,@webhook');
		expect(res.text).toContain('PROVIDER_LIMIT');
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
});
