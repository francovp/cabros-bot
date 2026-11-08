'use strict';

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	getAlertById: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
}));

jest.mock('../../src/services/storage/AlertAcknowledgementService', () => {
	const actual = jest.requireActual('../../src/services/storage/AlertAcknowledgementService');
	return {
		__esModule: false,
		...actual,
		isEnabled: jest.fn(),
		saveAcknowledgement: jest.fn(),
		getAcknowledgementBreakdown: jest.fn(),
		VALID_ACTIONS: actual.VALID_ACTIONS,
		STORAGE_UNAVAILABLE_CODE: actual.STORAGE_UNAVAILABLE_CODE,
		INVALID_REQUEST_CODE: actual.INVALID_REQUEST_CODE,
	};
});

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const ackService = require('../../src/services/storage/AlertAcknowledgementService');

function saveEnv() {
	return { ...process.env };
}

function restoreEnv(saved) {
	process.env = saved;
}

describe('Alert Acknowledgement API Integration Tests', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
		});
		jest.clearAllMocks();
		alertStorageService.isEnabled.mockReturnValue(true);
		ackService.isEnabled.mockReturnValue(true);
		ackService.saveAcknowledgement.mockResolvedValue({
			ackId: 'alert-1__123',
			alertId: 'alert-1',
			action: 'took_trade',
			notes: 'good setup',
			acknowledgedAt: '2026-09-02T22:00:00.000Z',
			updatedAt: '2026-09-02T22:00:00.000Z',
			storage: 'firestore',
		});
		ackService.getAcknowledgementBreakdown.mockResolvedValue({
			alertId: 'alert-1',
			total: 3,
			breakdown: { took_trade: 2, skipped: 1, no_trade_no_signal: 0, snoozed: 0 },
			storage: 'firestore',
		});
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('POST /api/alerts/:alertId/acknowledge', () => {
		it('returns 401 without an API key', async () => {
			const res = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.send({ chatId: '123', action: 'took_trade' })
				.expect(401);
			expect(res.body.error).toContain('Unauthorized');
		});

		it('returns 403 when storage is disabled', async () => {
			alertStorageService.isEnabled.mockReturnValue(false);
			ackService.isEnabled.mockReturnValue(false);
			const res = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ chatId: '123', action: 'took_trade' })
				.expect(403);
			expect(res.body.code).toBe('FEATURE_DISABLED');
			expect(ackService.saveAcknowledgement).not.toHaveBeenCalled();
		});

		it('returns 400 when chatId is missing', async () => {
			const res = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ action: 'took_trade' })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
			expect(res.body.error).toContain('chatId');
		});

		it('returns 400 when action is not in the allowed set', async () => {
			alertStorageService.getAlertById.mockResolvedValue({ id: 'alert-1' });
			ackService.saveAcknowledgement.mockImplementation(() => {
				const error = new Error('Invalid action. Must be one of: took_trade, skipped, no_trade_no_signal, snoozed.');
				error.code = 'INVALID_REQUEST';
				throw error;
			});
			const res = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ chatId: '123', action: 'random' })
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 404 when the stored alert does not exist', async () => {
			alertStorageService.getAlertById.mockResolvedValue(null);
			const res = await request(app)
				.post('/api/alerts/alert-missing/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ chatId: '123', action: 'took_trade' })
				.expect(404);
			expect(res.body.code).toBe('NOT_FOUND');
			expect(ackService.saveAcknowledgement).not.toHaveBeenCalled();
		});

		it('returns 503 when Firestore is unavailable', async () => {
			alertStorageService.getAlertById.mockResolvedValue({ id: 'alert-1' });
			ackService.saveAcknowledgement.mockImplementation(() => {
				const error = new Error('Acknowledgement storage is enabled but Firestore is unavailable.');
				error.code = 'STORAGE_UNAVAILABLE';
				throw error;
			});
			const res = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ chatId: '123', action: 'took_trade' })
				.expect(503);
			expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
		});

		it('returns 201 with sanitized acknowledgement on success', async () => {
			alertStorageService.getAlertById.mockResolvedValue({ id: 'alert-1' });
			const res = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ chatId: '123456789', action: 'took_trade', notes: 'good setup' })
				.expect(201);
			expect(res.body).toEqual({
				success: true,
				ackId: 'alert-1__123',
				alertId: 'alert-1',
				action: 'took_trade',
				notes: 'good setup',
				acknowledgedAt: '2026-09-02T22:00:00.000Z',
				updatedAt: '2026-09-02T22:00:00.000Z',
				storage: 'firestore',
			});
			// chatId must never be returned in the response
			expect(res.body.chatId).toBeUndefined();
			expect(ackService.saveAcknowledgement).toHaveBeenCalledWith({
				alertId: 'alert-1',
				chatId: '123456789',
				action: 'took_trade',
				notes: 'good setup',
			});
		});

		it('is idempotent per (alertId, chatId) — second call updates the record', async () => {
			alertStorageService.getAlertById.mockResolvedValue({ id: 'alert-1' });
			ackService.saveAcknowledgement
				.mockResolvedValueOnce({
					ackId: 'alert-1__123',
					alertId: 'alert-1',
					action: 'took_trade',
					notes: null,
					acknowledgedAt: '2026-09-02T22:00:00.000Z',
					updatedAt: '2026-09-02T22:00:00.000Z',
					storage: 'memory',
				})
				.mockResolvedValueOnce({
					ackId: 'alert-1__123',
					alertId: 'alert-1',
					action: 'skipped',
					notes: 'wait for confirmation',
					acknowledgedAt: '2026-09-02T22:00:00.000Z',
					updatedAt: '2026-09-02T22:30:00.000Z',
					storage: 'memory',
				});
			const first = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ chatId: '123', action: 'took_trade' })
				.expect(201);
			const second = await request(app)
				.post('/api/alerts/alert-1/acknowledge')
				.set('x-api-key', 'test-key')
				.send({ chatId: '123', action: 'skipped', notes: 'wait for confirmation' })
				.expect(201);
			expect(first.body.ackId).toBe(second.body.ackId);
			expect(first.body.action).toBe('took_trade');
			expect(second.body.action).toBe('skipped');
			expect(ackService.saveAcknowledgement).toHaveBeenCalledTimes(2);
		});
	});

	describe('GET /api/alerts/:alertId/acknowledgements/breakdown', () => {
		it('returns 401 without an API key', async () => {
			const res = await request(app)
				.get('/api/alerts/alert-1/acknowledgements/breakdown')
				.expect(401);
			expect(res.body.error).toContain('Unauthorized');
		});

		it('returns 403 when storage is disabled', async () => {
			alertStorageService.isEnabled.mockReturnValue(false);
			ackService.isEnabled.mockReturnValue(false);
			const res = await request(app)
				.get('/api/alerts/alert-1/acknowledgements/breakdown')
				.set('x-api-key', 'test-key')
				.expect(403);
			expect(res.body.code).toBe('FEATURE_DISABLED');
		});

		it('returns the breakdown with zero-safe counts', async () => {
			const res = await request(app)
				.get('/api/alerts/alert-1/acknowledgements/breakdown')
				.set('x-api-key', 'test-key')
				.expect(200);
			expect(res.body).toEqual({
				success: true,
				alertId: 'alert-1',
				total: 3,
				breakdown: { took_trade: 2, skipped: 1, no_trade_no_signal: 0, snoozed: 0 },
				storage: 'firestore',
			});
			expect(ackService.getAcknowledgementBreakdown).toHaveBeenCalledWith('alert-1');
		});
	});
});
