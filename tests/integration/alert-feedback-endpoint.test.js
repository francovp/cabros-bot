'use strict';

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	listAlerts: jest.fn(),
	getAlertById: jest.fn(),
	saveReplayAttempt: jest.fn(),
	listReplayAttempts: jest.fn(),
	getLatestReplayForAlert: jest.fn(),
	summarizeAlerts: jest.fn(),
	exportAlerts: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	INVALID_CURSOR_MESSAGE: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
	parseAlertPaginationCursor: jest.fn(),
}));

jest.mock('../../src/services/storage/AlertFeedbackStorageService', () => {
	const actual = jest.requireActual('../../src/services/storage/AlertFeedbackStorageService');
	return {
		...actual,
		isEnabled: jest.fn(),
		saveFeedback: jest.fn(),
		listFeedbackEntries: jest.fn(),
		getSummaryBlock: jest.fn(),
		getStatus: jest.fn(),
		VALID_VERDICTS: actual.VALID_VERDICTS,
		STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	};
});

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
const alertFeedbackStorageService = require('../../src/services/storage/AlertFeedbackStorageService');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

const { idempotencyService } = require('../../src/services/storage/IdempotencyService');

describe('Alert Feedback API Integration Tests', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		idempotencyService.clear();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
		});

		jest.clearAllMocks();
		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.summarizeAlerts.mockResolvedValue({
			totalAlerts: 1,
			window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' },
			bySource: {},
			bySymbol: {},
			byFeatureFlag: {
				enriched: 0,
				plain: 1,
				tradingViewData: 0,
				withoutTradingViewData: 1,
			},
			enrichment: {
				enrichedAlerts: 0,
				plainAlerts: 1,
				tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
			},
			delivery: { totalSuccess: 1, totalFailure: 0, byChannel: {} },
			latency: { averageProcessingMs: 1, averageDeliveryMs: 1 },
		});
		signalOutcomeService.isEnabled.mockReturnValue(false);
		signalOutcomeService.getMetricsSummary.mockResolvedValue('No measurements found');
		alertFeedbackStorageService.isEnabled.mockReturnValue(true);
		alertFeedbackStorageService.saveFeedback.mockResolvedValue({ persisted: true, source: 'firestore' });
		alertFeedbackStorageService.listFeedbackEntries.mockResolvedValue({
			aggregate: { total: 0, up: 0, down: 0, ratio: 0, bySource: {}, bySymbol: {}, byExchange: {} },
			window: {
				from: new Date(Date.now() - 7 * 86400000).toISOString(),
				to: new Date().toISOString(),
				limit: 1000,
			},
			source: 'memory',
		});
		alertFeedbackStorageService.getSummaryBlock.mockResolvedValue({
			total: 0,
			up: 0,
			down: 0,
			ratio: 0,
			bySource: {},
			bySymbol: {},
			byExchange: {},
			source: 'memory',
		});
		alertFeedbackStorageService.getStatus.mockReturnValue({
			enabled: true,
			configured: true,
			source: 'firestore',
			inMemoryEntryCount: 0,
		});
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('POST /api/alerts/feedback', () => {
		it('returns 401 when API key is missing', async () => {
			const res = await request(app)
				.post('/api/alerts/feedback')
				.send({ alertId: 'a1', chatId: 'c1', verdict: 'up' })
				.expect(401);

			expect(res.body.error).toContain('Unauthorized');
		});

		it('returns 400 when alertId is missing', async () => {
			const res = await request(app)
				.post('/api/alerts/feedback')
				.set('x-api-key', 'test-key')
				.send({ chatId: 'c1', verdict: 'up' })
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when chatId is missing', async () => {
			const res = await request(app)
				.post('/api/alerts/feedback')
				.set('x-api-key', 'test-key')
				.send({ alertId: 'a1', verdict: 'up' })
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when verdict is invalid', async () => {
			const res = await request(app)
				.post('/api/alerts/feedback')
				.set('x-api-key', 'test-key')
				.send({ alertId: 'a1', chatId: 'c1', verdict: 'maybe' })
				.expect(400);

			expect(res.body.error).toContain('verdict');
		});

		it('persists a verdict and returns success metadata', async () => {
			const res = await request(app)
				.post('/api/alerts/feedback')
				.set('x-api-key', 'test-key')
				.send({
					alertId: 'alert-1',
					chatId: '12345',
					verdict: 'up',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					source: 'webhook-alert',
				})
				.expect(200);

			expect(alertFeedbackStorageService.saveFeedback).toHaveBeenCalledWith({
				alertId: 'alert-1',
				chatId: '12345',
				verdict: 'up',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				source: 'webhook-alert',
			});
			expect(res.body).toEqual({
				success: true,
				persisted: true,
				source: 'firestore',
				alertId: 'alert-1',
				verdict: 'up',
			});
		});

		it('replays the same payload via the idempotency middleware', async () => {
			const headers = { 'x-api-key': 'test-key', 'idempotency-key': 'fb-1' };
			const payload = { alertId: 'a1', chatId: 'c1', verdict: 'up' };
			const first = await request(app)
				.post('/api/alerts/feedback')
				.set(headers)
				.send(payload)
				.expect(200);
			const second = await request(app)
				.post('/api/alerts/feedback')
				.set(headers)
				.send(payload)
				.expect(200);

			expect(second.body.idempotencyReplayed).toBe(true);
			expect(second.body.alertId).toBe(first.body.alertId);
			// saveFeedback called only once for the replay contract.
			expect(alertFeedbackStorageService.saveFeedback).toHaveBeenCalledTimes(1);
		});

		it('returns 503 when feedback storage is unavailable', async () => {
			const error = new Error('Alert feedback storage is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			alertFeedbackStorageService.saveFeedback.mockRejectedValueOnce(error);

			const res = await request(app)
				.post('/api/alerts/feedback')
				.set('x-api-key', 'test-key')
				.send({ alertId: 'a1', chatId: 'c1', verdict: 'up' })
				.expect(503);

			expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
		});
	});

	describe('GET /api/alerts/feedback/summary', () => {
		it('returns aggregated counts without leaking raw chat ids', async () => {
			alertFeedbackStorageService.listFeedbackEntries.mockResolvedValueOnce({
				aggregate: {
					total: 4,
					up: 3,
					down: 1,
					ratio: 0.75,
					bySource: { 'webhook-alert': 3, scanner: 1 },
					bySymbol: { BTCUSDT: 4 },
					byExchange: { BINANCE: 4 },
				},
				window: {
					from: '2026-01-01T00:00:00.000Z',
					to: '2026-01-08T00:00:00.000Z',
					limit: 1000,
				},
				source: 'firestore',
			});

			const res = await request(app)
				.get('/api/alerts/feedback/summary?from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.feedback.total).toBe(4);
			expect(res.body.feedback.up).toBe(3);
			expect(res.body.feedback.down).toBe(1);
			expect(res.body.feedback.ratio).toBe(0.75);
			expect(res.body.feedback.bySource['webhook-alert']).toBe(3);
			// Raw chat ids are never returned.
			expect(res.body.feedback.chatIds).toBeUndefined();
			expect(res.body.feedback.entries).toBeUndefined();
		});

		it('returns 400 for an invalid from timestamp', async () => {
			const res = await request(app)
				.get('/api/alerts/feedback/summary?from=not-a-date')
				.set('x-api-key', 'test-key')
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when limit is out of range', async () => {
			const res = await request(app)
				.get('/api/alerts/feedback/summary?limit=99999')
				.set('x-api-key', 'test-key')
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
		});
	});

	describe('feedback block in /api/alerts/summary', () => {
		it('always includes the feedback block even with report filters', async () => {
			alertFeedbackStorageService.getSummaryBlock.mockResolvedValueOnce({
				total: 12,
				up: 9,
				down: 3,
				ratio: 0.75,
				bySource: { 'webhook-alert': 12 },
				bySymbol: { BTCUSDT: 8, ETHUSDT: 4 },
				byExchange: { BINANCE: 12 },
				source: 'firestore',
				window: { from: 'X', to: 'Y' },
			});

			const res = await request(app)
				.get('/api/alerts/summary?source=webhook')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body.summary.feedback.total).toBe(12);
			expect(res.body.summary.feedback.up).toBe(9);
			expect(res.body.summary.feedback.down).toBe(3);
			expect(res.body.summary.feedback.ratio).toBe(0.75);
			expect(res.body.summary.feedback.bySource['webhook-alert']).toBe(12);
		});
	});
});
