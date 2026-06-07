'use strict';

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	listAlerts: jest.fn(),
	getAlertById: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	INVALID_CURSOR_MESSAGE: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
	parseAlertPaginationCursor: jest.fn(),
}));

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const { encodeAlertPaginationCursor } = require('../../src/services/storage/alertPaginationCursor');

describe('Alerts API Integration Tests', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
		};

		jest.clearAllMocks();
		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.parseAlertPaginationCursor.mockImplementation((cursor) => {
			if (!cursor) {
				return null;
			}

			if (!Number.isNaN(Date.parse(cursor))) {
				return { type: 'timestamp', receivedAt: new Date(cursor).toISOString(), documentId: null };
			}

			return encodeAlertPaginationCursor({
				receivedAt: '2026-06-06T12:00:00.000Z',
				id: 'alert-1',
			}) === cursor
				? { type: 'composite', receivedAt: '2026-06-06T12:00:00.000Z', documentId: 'alert-1' }
				: null;
		});
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('returns 401 when GET /api/alerts lacks a valid api key', async () => {
		await request(app)
			.get('/api/alerts')
			.expect(401);
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
});
