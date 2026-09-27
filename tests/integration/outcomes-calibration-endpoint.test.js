'use strict';

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	getOutcomesCalibration: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
}));

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

describe('Signal Outcomes Calibration API Integration Tests', () => {
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

	it('returns 401 when GET /api/outcomes/calibration lacks a valid api key', async () => {
		const res = await request(app)
			.get('/api/outcomes/calibration')
			.expect(401);

		expect(res.body.error).toContain('Unauthorized');
	});

	it('returns 403 when signal outcome tracking is disabled', async () => {
		signalOutcomeService.isEnabled.mockReturnValue(false);

		const res = await request(app)
			.get('/api/outcomes/calibration')
			.set('x-api-key', 'test-key')
			.expect(403);

		expect(res.body).toEqual({
			error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
			code: 'FEATURE_DISABLED',
		});
	});

	it('returns 503 when Firestore is unavailable', async () => {
		const error = new Error('Signal outcome tracking is enabled but Firestore is unavailable.');
		error.code = 'STORAGE_UNAVAILABLE';
		signalOutcomeService.getOutcomesCalibration.mockRejectedValue(error);

		const res = await request(app)
			.get('/api/outcomes/calibration')
			.set('x-api-key', 'test-key')
			.expect(503);

		expect(res.body).toEqual({
			error: 'Signal outcome tracking is enabled but Firestore is unavailable.',
			code: 'STORAGE_UNAVAILABLE',
		});
	});

	it('returns 400 for invalid query parameters', async () => {
		// Invalid limit
		let res = await request(app)
			.get('/api/outcomes/calibration?limit=0')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// Invalid window
		res = await request(app)
			.get('/api/outcomes/calibration?window=2h')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// Invalid date
		res = await request(app)
			.get('/api/outcomes/calibration?from=invalid-date')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');

		// From > To
		res = await request(app)
			.get('/api/outcomes/calibration?from=2026-08-23T20:00:00.000Z&to=2026-08-23T10:00:00.000Z')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('returns 200 with calibration payload for valid query with filters', async () => {
		const mockCalibration = {
			available: true,
			totalScoredAlerts: 25,
			buckets: [
				{
					range: '0.70-0.75',
					count: 10,
					avgReturn1h: 0.5,
					avgReturn4h: 1.2,
					targetHitRate: 0.5,
				},
				{
					range: '0.75-0.80',
					count: 15,
					avgReturn1h: 1.1,
					avgReturn4h: 2.3,
					targetHitRate: 0.67,
				},
			],
			suggestedThreshold: 0.75,
			suggestedThresholdRationale: 'Alerts at 0.75+ show 55%+ target hit rate at 4h window',
		};
		signalOutcomeService.getOutcomesCalibration.mockResolvedValue(mockCalibration);

		const res = await request(app)
			.get('/api/outcomes/calibration?symbol=BTCUSDT&exchange=BINANCE&window=4h&limit=500')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body).toEqual({
			success: true,
			calibration: mockCalibration,
		});
		expect(signalOutcomeService.getOutcomesCalibration).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			window: '4h',
			limit: 500,
		}));
	});

	it('accepts api key in query parameters', async () => {
		signalOutcomeService.getOutcomesCalibration.mockResolvedValue({
			available: false,
			totalScoredAlerts: 0,
			buckets: [],
			suggestedThreshold: null,
			suggestedThresholdRationale: 'Insufficient evaluated sample size (< 20 scored alerts).',
		});

		const res = await request(app)
			.get('/api/outcomes/calibration?api-key=test-key')
			.expect(200);

		expect(res.body.success).toBe(true);
	});
});
