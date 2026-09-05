'use strict';

jest.mock('../../src/services/storage/SymbolAnalysisStorageService', () => ({
	isEnabled: jest.fn(),
	listAnalyses: jest.fn(),
	summarizeAnalyses: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	INVALID_CURSOR_MESSAGE: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
}));

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const symbolAnalysisStorageService = require('../../src/services/storage/SymbolAnalysisStorageService');

describe('Symbol Analyses API Integration Tests', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_SYMBOL_ANALYSIS_STORAGE: 'true',
		});

		jest.clearAllMocks();
		symbolAnalysisStorageService.isEnabled.mockReturnValue(true);
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('GET /api/symbol-analyses', () => {
		it('returns 401 when GET /api/symbol-analyses lacks a valid api key', async () => {
			const res = await request(app)
				.get('/api/symbol-analyses')
				.expect(401);

			expect(res.body.error).toContain('Unauthorized');
		});

		it('returns 403 when symbol analysis storage is disabled', async () => {
			symbolAnalysisStorageService.isEnabled.mockReturnValue(false);

			const res = await request(app)
				.get('/api/symbol-analyses')
				.set('x-api-key', 'test-key')
				.expect(403);

			expect(res.body).toEqual({
				error: 'Symbol analysis storage feature is disabled. Set ENABLE_SYMBOL_ANALYSIS_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		});

		it('returns 503 when Firestore is unavailable', async () => {
			const error = new Error('Symbol analysis storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
			error.code = 'STORAGE_UNAVAILABLE';
			symbolAnalysisStorageService.listAnalyses.mockRejectedValue(error);

			const res = await request(app)
				.get('/api/symbol-analyses')
				.set('x-api-key', 'test-key')
				.expect(503);

			expect(res.body).toEqual({
				error: 'Symbol analysis storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.',
				code: 'STORAGE_UNAVAILABLE',
			});
		});

		it('returns 400 for invalid query parameters', async () => {
			// Invalid limit (0)
			let res = await request(app)
				.get('/api/symbol-analyses?limit=0')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			// Invalid limit (101)
			res = await request(app)
				.get('/api/symbol-analyses?limit=101')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			// Invalid action
			res = await request(app)
				.get('/api/symbol-analyses?action=HOLD')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			// Invalid date
			res = await request(app)
				.get('/api/symbol-analyses?from=not-a-date')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 200 with list of analyses and passes filters to service', async () => {
			const mockAnalyses = [
				{
					id: 'req-1',
					requestId: 'req-1',
					recordedAt: '2026-09-04T12:00:00.000Z',
					symbol: 'BINANCE:BTCUSDT',
					exchange: 'BINANCE',
					asset: 'BTCUSDT',
					timeframe: '1h',
					action: 'BUY',
					price: 65000,
				},
			];

			symbolAnalysisStorageService.listAnalyses.mockResolvedValue({
				analyses: mockAnalyses,
				count: 1,
				limit: 25,
				nextCursor: null,
			});

			const res = await request(app)
				.get('/api/symbol-analyses?limit=25&action=BUY&symbol=BTCUSDT&exchange=BINANCE&timeframe=1h')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body).toEqual({
				success: true,
				analyses: mockAnalyses,
				count: 1,
				limit: 25,
				nextCursor: null,
			});

			expect(symbolAnalysisStorageService.listAnalyses).toHaveBeenCalledWith({
				limit: 25,
				before: undefined,
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				action: 'BUY',
				from: undefined,
				to: undefined,
			});
		});
	});

	describe('GET /api/symbol-analyses/summary', () => {
		it('returns 401 when GET /api/symbol-analyses/summary lacks a valid api key', async () => {
			const res = await request(app)
				.get('/api/symbol-analyses/summary')
				.expect(401);

			expect(res.body.error).toContain('Unauthorized');
		});

		it('returns 403 when symbol analysis storage is disabled', async () => {
			symbolAnalysisStorageService.isEnabled.mockReturnValue(false);

			const res = await request(app)
				.get('/api/symbol-analyses/summary')
				.set('x-api-key', 'test-key')
				.expect(403);

			expect(res.body).toEqual({
				error: 'Symbol analysis storage feature is disabled. Set ENABLE_SYMBOL_ANALYSIS_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		});

		it('returns 503 when Firestore is unavailable', async () => {
			const error = new Error('Symbol analysis storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
			error.code = 'STORAGE_UNAVAILABLE';
			symbolAnalysisStorageService.summarizeAnalyses.mockRejectedValue(error);

			const res = await request(app)
				.get('/api/symbol-analyses/summary')
				.set('x-api-key', 'test-key')
				.expect(503);

			expect(res.body).toEqual({
				error: 'Symbol analysis storage is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.',
				code: 'STORAGE_UNAVAILABLE',
			});
		});

		it('returns 400 for invalid limit or date range', async () => {
			let res = await request(app)
				.get('/api/symbol-analyses/summary?limit=0')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			res = await request(app)
				.get('/api/symbol-analyses/summary?limit=1001')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');

			res = await request(app)
				.get('/api/symbol-analyses/summary?to=not-a-date')
				.set('x-api-key', 'test-key')
				.expect(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 200 with summary and passes filters to service', async () => {
			const mockSummary = {
				success: true,
				totalAnalyses: 10,
				byAction: { BUY: 5, SELL: 3, NO_TRADE: 2 },
				bySymbol: { 'BINANCE:BTCUSDT': 10 },
				byTimeframe: { '1h': 10 },
				byExchange: { BINANCE: 10 },
				window: { limit: 200 },
			};

			symbolAnalysisStorageService.summarizeAnalyses.mockResolvedValue(mockSummary);

			const res = await request(app)
				.get('/api/symbol-analyses/summary?limit=200&symbol=BTCUSDT')
				.set('x-api-key', 'test-key')
				.expect(200);

			expect(res.body).toEqual({
				success: true,
				summary: mockSummary,
			});

			expect(symbolAnalysisStorageService.summarizeAnalyses).toHaveBeenCalledWith({
				limit: 200,
				symbol: 'BTCUSDT',
				exchange: undefined,
				timeframe: undefined,
				from: undefined,
				to: undefined,
			});
		});
	});
});
