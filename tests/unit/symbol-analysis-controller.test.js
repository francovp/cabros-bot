'use strict';

const symbolAnalysesController = require('../../src/controllers/symbolAnalyses/symbolAnalyses');
const symbolAnalysisStorageService = require('../../src/services/storage/SymbolAnalysisStorageService');

describe('SymbolAnalysesController', () => {
	let req;
	let res;

	beforeEach(() => {
		jest.clearAllMocks();
		req = {
			query: {},
			method: 'GET',
		};
		res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};
	});

	describe('listSymbolAnalyses', () => {
		it('returns 403 when feature is disabled', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(false);

			await symbolAnalysesController.listSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				code: 'FEATURE_DISABLED',
			}));
		});

		it('returns 400 for invalid limit', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(true);
			req.query.limit = 'invalid';

			await symbolAnalysesController.listSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				code: 'INVALID_REQUEST',
			}));
		});

		it('returns 400 for out of bounds limit', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(true);
			req.query.limit = '200';

			await symbolAnalysesController.listSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
		});

		it('returns 400 for invalid from timestamp', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(true);
			req.query.from = 'not-a-date';

			await symbolAnalysesController.listSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
		});

		it('returns 200 with list of analyses when valid', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(true);
			jest.spyOn(symbolAnalysisStorageService, 'listAnalyses').mockResolvedValue({
				success: true,
				analyses: [{ id: 'req-1', symbol: 'BINANCE:BTCUSDT' }],
				count: 1,
				limit: 50,
				nextCursor: null,
			});

			await symbolAnalysesController.listSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith({
				success: true,
				analyses: [{ id: 'req-1', symbol: 'BINANCE:BTCUSDT' }],
				count: 1,
				limit: 50,
				nextCursor: null,
			});
		});

		it('returns 503 when Firestore is unavailable', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(true);
			const error = new Error('Firestore is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			jest.spyOn(symbolAnalysisStorageService, 'listAnalyses').mockRejectedValue(error);

			await symbolAnalysesController.listSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(503);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				code: 'STORAGE_UNAVAILABLE',
			}));
		});
	});

	describe('summarizeSymbolAnalyses', () => {
		it('returns 403 when feature is disabled', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(false);

			await symbolAnalysesController.summarizeSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				code: 'FEATURE_DISABLED',
			}));
		});

		it('returns 200 with aggregated summary when valid', async () => {
			jest.spyOn(symbolAnalysisStorageService, 'isEnabled').mockReturnValue(true);
			const mockSummary = {
				success: true,
				totalAnalyses: 5,
				byAction: { BUY: 3, SELL: 1, NO_TRADE: 1 },
				bySymbol: {},
				byTimeframe: {},
				byExchange: {},
				window: { limit: 500 },
			};
			jest.spyOn(symbolAnalysisStorageService, 'summarizeAnalyses').mockResolvedValue(mockSummary);

			await symbolAnalysesController.summarizeSymbolAnalyses(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith({
				success: true,
				summary: mockSummary,
			});
		});
	});
});
