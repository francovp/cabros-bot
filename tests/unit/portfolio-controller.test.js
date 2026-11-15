'use strict';

const httpMocks = require('node-mocks-http');
const {
	getPortfolioSnapshot,
	getPortfolioDependencyState,
} = require('../../src/controllers/portfolio/portfolio');
const portfolioService = require('../../src/services/portfolio/PortfolioAnalyticsService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const sentryService = require('../../src/services/monitoring/SentryService');

jest.mock('../../src/services/portfolio/PortfolioAnalyticsService', () => ({
	isEnabled: jest.fn(),
	buildPortfolioSnapshot: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
}));

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
}));

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
}));

describe('Portfolio Controller Unit Tests', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('getPortfolioSnapshot', () => {
		it('returns 403 when portfolio analytics is disabled', async () => {
			portfolioService.isEnabled.mockReturnValue(false);
			const req = httpMocks.createRequest({ method: 'GET' });
			const res = httpMocks.createResponse();
			await getPortfolioSnapshot(req, res);

			expect(res.statusCode).toBe(403);
			expect(res._isEndCalled()).toBe(true);
			const body = res._getJSONData();
			expect(body.code).toBe('FEATURE_DISABLED');
		});

		it('returns 200 with the snapshot when enabled and storage is ready', async () => {
			portfolioService.isEnabled.mockReturnValue(true);
			const fakeSnapshot = {
				mode: 'implied_paper',
				totals: { totalAlerts: 5, openCount: 2, netSide: 'long', notional: 5000, unrealizedPnl: 250, concentrationIndex: 0.4 },
				symbols: [],
				topSymbols: [],
				riskFlags: [],
				generatedAt: '2026-09-02T00:00:00Z',
			};
			portfolioService.buildPortfolioSnapshot.mockResolvedValue(fakeSnapshot);

			const req = httpMocks.createRequest({ method: 'GET' });
			const res = httpMocks.createResponse();
			await getPortfolioSnapshot(req, res);

			expect(res.statusCode).toBe(200);
			const body = res._getJSONData();
			expect(body.success).toBe(true);
			expect(body.snapshot).toEqual(fakeSnapshot);
		});

		it('returns 503 when the service raises STORAGE_UNAVAILABLE', async () => {
			portfolioService.isEnabled.mockReturnValue(true);
			const err = new Error('Alert storage is not enabled');
			err.code = 'STORAGE_UNAVAILABLE';
			portfolioService.buildPortfolioSnapshot.mockRejectedValue(err);

			const req = httpMocks.createRequest({ method: 'GET' });
			const res = httpMocks.createResponse();
			await getPortfolioSnapshot(req, res);

			expect(res.statusCode).toBe(503);
			const body = res._getJSONData();
			expect(body.code).toBe('STORAGE_UNAVAILABLE');
			expect(sentryService.captureRuntimeError).toHaveBeenCalledTimes(1);
		});

		it('returns 500 for unexpected errors and reports to Sentry', async () => {
			portfolioService.isEnabled.mockReturnValue(true);
			portfolioService.buildPortfolioSnapshot.mockRejectedValue(new Error('boom'));

			const req = httpMocks.createRequest({ method: 'GET' });
			const res = httpMocks.createResponse();
			await getPortfolioSnapshot(req, res);

			expect(res.statusCode).toBe(500);
			expect(sentryService.captureRuntimeError).toHaveBeenCalledTimes(1);
		});
	});

	describe('getPortfolioDependencyState', () => {
		it('reports ready when portfolio is enabled and storage is available', () => {
			portfolioService.isEnabled.mockReturnValue(true);
			alertStorageService.isEnabled.mockReturnValue(true);
			const state = getPortfolioDependencyState();
			expect(state.enabled).toBe(true);
			expect(state.storage).toBe('ready');
		});

		it('reports unavailable when storage is missing', () => {
			portfolioService.isEnabled.mockReturnValue(true);
			alertStorageService.isEnabled.mockReturnValue(false);
			const state = getPortfolioDependencyState();
			expect(state.enabled).toBe(true);
			expect(state.storage).toBe('unavailable');
		});

		it('reports disabled when the gate is off', () => {
			portfolioService.isEnabled.mockReturnValue(false);
			alertStorageService.isEnabled.mockReturnValue(true);
			const state = getPortfolioDependencyState();
			expect(state.enabled).toBe(false);
		});
	});
});
