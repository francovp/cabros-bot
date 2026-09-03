'use strict';

const httpMocks = require('node-mocks-http');
const {
	listOutcomes,
	summarizeOutcomes,
	getOutcomeById,
	exportOutcomes,
	parseLimit,
	parseStatus,
	parseWindow,
	parseOptionalTimestamp,
	parseExportLimit,
	parseExportFormat,
	parseOptionalSetupType,
	escapeCsvValue,
	buildOutcomeCsv,
} = require('../../src/controllers/outcomes/outcomes');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const sentryService = require('../../src/services/monitoring/SentryService');

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	listOutcomes: jest.fn(),
	summarizeOutcomes: jest.fn(),
	getOutcomeById: jest.fn(),
	exportOutcomes: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	INVALID_CURSOR_MESSAGE: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
}));

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
}));

describe('Outcomes Controller Unit Tests', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('helpers', () => {
		describe('parseLimit', () => {
			it('returns 50 by default', () => {
				expect(parseLimit(undefined)).toBe(50);
			});

			it('parses valid integer limits within [1, 100]', () => {
				expect(parseLimit('10')).toBe(10);
				expect(parseLimit('1')).toBe(1);
				expect(parseLimit('100')).toBe(100);
			});

			it('returns null for invalid limits', () => {
				expect(parseLimit('0')).toBeNull();
				expect(parseLimit('-5')).toBeNull();
				expect(parseLimit('101')).toBeNull();
				expect(parseLimit('invalid')).toBeNull();
			});
		});

		describe('parseStatus', () => {
			it('returns undefined when omitted', () => {
				expect(parseStatus(undefined)).toBeUndefined();
			});

			it('parses valid statuses case-insensitively', () => {
				expect(parseStatus('pending')).toBe('pending');
				expect(parseStatus('Pending')).toBe('pending');
				expect(parseStatus('evaluated')).toBe('evaluated');
				expect(parseStatus('EVALUATED')).toBe('evaluated');
				expect(parseStatus('unavailable')).toBe('unavailable');
			});

			it('returns null for invalid statuses', () => {
				expect(parseStatus('completed')).toBeNull();
				expect(parseStatus('failed')).toBeNull();
				expect(parseStatus(123)).toBeNull();
			});
		});

		describe('parseWindow', () => {
			it('returns undefined when omitted', () => {
				expect(parseWindow(undefined)).toBeUndefined();
			});

			it('parses and standardizes valid windows', () => {
				expect(parseWindow('1h')).toBe('1h');
				expect(parseWindow('4H')).toBe('4h');
				expect(parseWindow('1d')).toBe('1D');
				expect(parseWindow('1D')).toBe('1D');
				expect(parseWindow('1w')).toBe('1W');
				expect(parseWindow('1W')).toBe('1W');
			});

			it('returns null for invalid windows', () => {
				expect(parseWindow('2h')).toBeNull();
				expect(parseWindow('1m')).toBeNull();
				expect(parseWindow(123)).toBeNull();
			});
		});

		describe('parseOptionalTimestamp', () => {
			it('returns undefined when omitted', () => {
				expect(parseOptionalTimestamp(undefined, 'from')).toEqual({ value: undefined });
			});

			it('returns ISO string for valid date', () => {
				expect(parseOptionalTimestamp('2026-08-23T12:00:00.000Z', 'from')).toEqual({
					value: '2026-08-23T12:00:00.000Z',
				});
			});

			it('returns error object for invalid date string', () => {
				expect(parseOptionalTimestamp('invalid-date', 'from')).toEqual({
					error: {
						error: 'Invalid from timestamp. Use an ISO-8601 timestamp.',
						code: 'INVALID_REQUEST',
					},
				});
			});
		});
	});

	describe('listOutcomes', () => {
		it('returns 403 when feature is disabled', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(false);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes' });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(403);
			expect(res._getJSONData()).toEqual({
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		});

		it('returns 400 for invalid limit', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes', query: { limit: '0' } });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid limit. Use an integer between 1 and 100.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 for invalid before cursor', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes', query: { before: 'not-valid-cursor' } });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 for invalid status', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes', query: { status: 'invalid_status' } });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid status filter. Use pending, evaluated, or unavailable.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 for invalid window', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes', query: { window: '2h' } });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 for invalid from timestamp', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes', query: { from: 'not-a-date' } });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid from timestamp. Use an ISO-8601 timestamp.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 for invalid to timestamp', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes', query: { to: 'not-a-date' } });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid to timestamp. Use an ISO-8601 timestamp.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when from is greater than to', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes',
				query: {
					from: '2026-08-23T15:00:00.000Z',
					to: '2026-08-23T10:00:00.000Z',
				},
			});
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 200 with outcomes list and pagination on success', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const mockOutcomes = [
				{
					id: 'doc-1',
					receivedAt: '2026-08-23T12:00:00.000Z',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 65000,
					outcomes: {
						'1h': { status: 'evaluated', return: 1.5 },
					},
				},
			];
			signalOutcomeService.listOutcomes.mockResolvedValue({
				outcomes: mockOutcomes,
				hasMore: false,
				nextBefore: null,
			});

			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes',
				query: {
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					status: 'evaluated',
					window: '1h',
					limit: '20',
				},
			});
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(200);
			expect(signalOutcomeService.listOutcomes).toHaveBeenCalledWith({
				before: undefined,
				limit: 20,
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				status: 'evaluated',
				window: '1h',
				from: undefined,
				to: undefined,
			});
			expect(res._getJSONData()).toEqual({
				success: true,
				outcomes: mockOutcomes,
				pagination: {
					hasMore: false,
					limit: 20,
					nextBefore: null,
				},
			});
		});

		it('returns 503 when storage is unavailable', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const error = new Error('Firestore is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			signalOutcomeService.listOutcomes.mockRejectedValue(error);

			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes' });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(503);
			expect(res._getJSONData()).toEqual({
				error: 'Firestore is unavailable',
				code: 'STORAGE_UNAVAILABLE',
			});
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});

		it('returns 500 on unexpected errors', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.listOutcomes.mockRejectedValue(new Error('Unexpected crash'));

			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes' });
			const res = httpMocks.createResponse();

			await listOutcomes(req, res);

			expect(res.statusCode).toBe(500);
			expect(res._getJSONData()).toEqual({
				error: 'Internal server error',
				code: 'INTERNAL_ERROR',
			});
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});
	});

	describe('summarizeOutcomes', () => {
		it('returns 403 when feature is disabled', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(false);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary' });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(403);
			expect(res._getJSONData()).toEqual({
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		});

		it('returns 400 when limit is invalid', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary', query: { limit: '0' } });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid limit. Use an integer between 1 and 100.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when status is invalid', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary', query: { status: 'invalid-status' } });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid status filter. Use pending, evaluated, or unavailable.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when window is invalid', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary', query: { window: '2h' } });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when from is not a valid date', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary', query: { from: 'not-a-date' } });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid from timestamp. Use an ISO-8601 timestamp.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when to is not a valid date', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary', query: { to: 'not-a-date' } });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid to timestamp. Use an ISO-8601 timestamp.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when from is greater than to', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/summary',
				query: {
					from: '2026-08-23T15:00:00.000Z',
					to: '2026-08-23T10:00:00.000Z',
				},
			});
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 200 with aggregate summary on success', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const mockSummary = {
				available: true,
				totalSignalsReceived: 10,
				totalSignalsEligible: 8,
				totalSignalsEvaluated: 8,
				totalSignalsPending: 0,
				totalSignalsUnavailable: 2,
				coveragePercent: 80,
				isCoverageComplete: false,
				targetHitRatePercent: 62.5,
				stopHitRatePercent: 25.0,
				expectancyR: 0.45,
				populationNote: 'Metrics represent 8 evaluated signals out of 10 total received signals (80% coverage).',
				exchangeBreakdown: { BINANCE: { received: 10, eligible: 8, evaluated: 8, pending: 0, unavailable: 2 } },
				providerBreakdown: { binance: { received: 10, eligible: 8, evaluated: 8, pending: 0, unavailable: 2 } },
				entryPriceSourceBreakdown: { 'tradingview-mcp': 8, none: 2 },
				eligibilityBreakdown: { supported_provider: 8, missing_entry_price: 2 },
				windows: {
					'1h': {
						totalSignals: 8,
						hitRatePercent: 75,
						targetEligibleWindows: 8,
						stopEligibleWindows: 8,
						targetHitRatePercent: 62.5,
						stopHitRatePercent: 25.0,
						expectancyR: 0.45,
						averageReturnPercent: 1.25,
						averageMfePercent: 2.1,
						averageMaePercent: -0.5,
						maxAdverseExcursionPercent: -1.2,
					},
				},
				drawdownProxy: {
					averageMaxAdverseExcursionPercent: -0.5,
					absoluteMaxAdverseExcursionPercent: -1.2,
				},
				falsePositiveCandidatesCount: 0,
				falsePositiveCandidates: [],
				latencyCostMetadata: {
					averageProcessingTimeMs: 120,
					tokenUsage: { inputTokens: 500, outputTokens: 200, totalCost: 0.00015 },
				},
			};
			signalOutcomeService.summarizeOutcomes.mockResolvedValue(mockSummary);

			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/summary',
				query: {
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					status: 'evaluated',
					window: '1h',
					limit: '20',
					from: '2026-08-20T00:00:00.000Z',
					to: '2026-08-25T00:00:00.000Z',
				},
			});
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(200);
			expect(signalOutcomeService.summarizeOutcomes).toHaveBeenCalledWith({
				limit: 20,
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				status: 'evaluated',
				window: '1h',
				from: '2026-08-20T00:00:00.000Z',
				to: '2026-08-25T00:00:00.000Z',
			});
			expect(res._getJSONData()).toEqual({
				success: true,
				summary: mockSummary,
			});
		});

		it('returns 200 with typed empty summary when dataset is empty', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
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

			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary' });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(200);
			expect(res._getJSONData()).toEqual({
				success: true,
				summary: emptySummary,
			});
		});

		it('returns 503 when storage is unavailable', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const error = new Error('Firestore is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			signalOutcomeService.summarizeOutcomes.mockRejectedValue(error);

			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary' });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(503);
			expect(res._getJSONData()).toEqual({
				error: 'Firestore is unavailable',
				code: 'STORAGE_UNAVAILABLE',
			});
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});

		it('returns 500 on unexpected errors', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.summarizeOutcomes.mockRejectedValue(new Error('Unexpected database error'));

			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/summary' });
			const res = httpMocks.createResponse();

			await summarizeOutcomes(req, res);

			expect(res.statusCode).toBe(500);
			expect(res._getJSONData()).toEqual({
				error: 'Internal server error',
				code: 'INTERNAL_ERROR',
			});
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});
	});

	describe('helpers for export endpoints', () => {
		describe('parseExportLimit', () => {
			it('returns 100 by default', () => {
				expect(parseExportLimit(undefined)).toBe(100);
			});

			it('parses valid integer limits within [1, 1000]', () => {
				expect(parseExportLimit('1')).toBe(1);
				expect(parseExportLimit('500')).toBe(500);
				expect(parseExportLimit('1000')).toBe(1000);
			});

			it('returns null for invalid limits', () => {
				expect(parseExportLimit('0')).toBeNull();
				expect(parseExportLimit('1001')).toBeNull();
				expect(parseExportLimit('abc')).toBeNull();
			});
		});

		describe('parseExportFormat', () => {
			it('returns jsonl by default', () => {
				expect(parseExportFormat(undefined)).toBe('jsonl');
			});

			it('returns the format case-insensitively', () => {
				expect(parseExportFormat('jsonl')).toBe('jsonl');
				expect(parseExportFormat('JSONL')).toBe('jsonl');
				expect(parseExportFormat('csv')).toBe('csv');
				expect(parseExportFormat('CSV')).toBe('csv');
			});

			it('returns null for invalid formats', () => {
				expect(parseExportFormat('xlsx')).toBeNull();
				expect(parseExportFormat('yaml')).toBeNull();
				expect(parseExportFormat(123)).toBeNull();
			});
		});

		describe('parseOptionalSetupType', () => {
			it('returns undefined for non-strings', () => {
				expect(parseOptionalSetupType(undefined)).toBeUndefined();
				expect(parseOptionalSetupType(123)).toBeUndefined();
				expect(parseOptionalSetupType(null)).toBeUndefined();
			});

			it('returns the trimmed value for non-empty strings', () => {
				expect(parseOptionalSetupType('breakout')).toBe('breakout');
				expect(parseOptionalSetupType('  momentum  ')).toBe('momentum');
			});

			it('returns undefined for empty strings', () => {
				expect(parseOptionalSetupType('')).toBeUndefined();
				expect(parseOptionalSetupType('   ')).toBeUndefined();
			});
		});

		describe('escapeCsvValue', () => {
			it('returns empty string for null and undefined', () => {
				expect(escapeCsvValue(null)).toBe('');
				expect(escapeCsvValue(undefined)).toBe('');
			});

			it('serializes objects as JSON', () => {
				expect(escapeCsvValue({ a: 1 })).toBe('"{""a"":1}"');
			});

			it('neutralizes formula-leading strings without breaking numbers', () => {
				expect(escapeCsvValue('=plain')).toBe(`'=plain`);
				expect(escapeCsvValue('+boom')).toBe(`'+boom`);
				expect(escapeCsvValue('-1')).toBe('-1');
				expect(escapeCsvValue('@host')).toBe(`'@host`);
				expect(escapeCsvValue('\t=attack')).toBe(`'\t=attack`);
				expect(escapeCsvValue('\r=attack')).toBe(`"'\r=attack"`);
				expect(escapeCsvValue('=SUM(1,1)')).toBe(`"'=SUM(1,1)"`);
				expect(escapeCsvValue('=@SUM(1,1), "quoted"\r\n+next')).toBe(`"'=@SUM(1,1), ""quoted""\r\n+next"`);
			});

			it('quotes values containing commas, quotes, or newlines', () => {
				expect(escapeCsvValue('a,b')).toBe('"a,b"');
				expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
				expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
			});
		});

		describe('buildOutcomeCsv', () => {
			it('returns the header row for an empty list', () => {
				expect(buildOutcomeCsv([])).toBe('id,receivedAt,source,symbol,exchange,side,price,setupType,score,outcomes');
			});

			it('renders one CSV row per outcome', () => {
				const csv = buildOutcomeCsv([
					{
						id: 'outcome-1',
						receivedAt: '2026-08-23T12:00:00.000Z',
						source: 'webhook',
						symbol: 'BTCUSDT',
						exchange: 'BINANCE',
						side: 'BUY',
						price: 65000,
						setupType: 'breakout',
						score: 0.9,
						outcomes: { '1h': { status: 'evaluated' } },
					},
				]);
				const lines = csv.split('\n');
				expect(lines[0]).toBe('id,receivedAt,source,symbol,exchange,side,price,setupType,score,outcomes');
				expect(lines[1]).toBe('outcome-1,2026-08-23T12:00:00.000Z,webhook,BTCUSDT,BINANCE,BUY,65000,breakout,0.9,"{""1h"":{""status"":""evaluated""}}"');
			});
		});
	});

	describe('getOutcomeById', () => {
		it('returns 403 when feature is disabled', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(false);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/outcome-1', params: { outcomeId: 'outcome-1' } });
			const res = httpMocks.createResponse();

			await getOutcomeById(req, res);

			expect(res.statusCode).toBe(403);
			expect(res._getJSONData().code).toBe('FEATURE_DISABLED');
		});

		it('returns 400 when outcomeId is missing', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/', params: {} });
			const res = httpMocks.createResponse();

			await getOutcomeById(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Missing outcomeId parameter',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 404 when service returns null', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.getOutcomeById.mockResolvedValue(null);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/missing', params: { outcomeId: 'missing' } });
			const res = httpMocks.createResponse();

			await getOutcomeById(req, res);

			expect(res.statusCode).toBe(404);
			expect(res._getJSONData()).toEqual({
				error: 'Outcome not found',
				code: 'NOT_FOUND',
			});
			expect(signalOutcomeService.getOutcomeById).toHaveBeenCalledWith('missing');
		});

		it('returns 503 when storage is unavailable', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const error = new Error('Firestore is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			signalOutcomeService.getOutcomeById.mockRejectedValue(error);
			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/outcome-1', params: { outcomeId: 'outcome-1' } });
			const res = httpMocks.createResponse();

			await getOutcomeById(req, res);

			expect(res.statusCode).toBe(503);
			expect(res._getJSONData().code).toBe('STORAGE_UNAVAILABLE');
		});

		it('returns the outcome on success', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.getOutcomeById.mockResolvedValue({
				id: 'outcome-1',
				receivedAt: '2026-08-23T12:00:00.000Z',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				side: 'BUY',
				price: 65000,
				outcomes: { '1h': { status: 'evaluated' } },
			});

			const req = httpMocks.createRequest({ method: 'GET', url: '/api/outcomes/outcome-1', params: { outcomeId: 'outcome-1' } });
			const res = httpMocks.createResponse();

			await getOutcomeById(req, res);

			expect(res.statusCode).toBe(200);
			expect(res._getJSONData()).toEqual({
				success: true,
				outcome: {
					id: 'outcome-1',
					receivedAt: '2026-08-23T12:00:00.000Z',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					price: 65000,
					outcomes: { '1h': { status: 'evaluated' } },
				},
			});
		});
	});

	describe('exportOutcomes', () => {
		it('returns 403 when feature is disabled', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(false);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(403);
			expect(res._getJSONData().code).toBe('FEATURE_DISABLED');
		});

		it('returns 400 when format is invalid', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { format: 'xml', from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid export format. Use jsonl or csv.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when limit is invalid', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { limit: '0', from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Invalid limit. Use an integer between 1 and 1000.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when from/to bounds are missing', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { format: 'jsonl' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData()).toEqual({
				error: 'Export requests require bounded from and to ISO-8601 timestamps.',
				code: 'INVALID_REQUEST',
			});
		});

		it('returns 400 when window exceeds 31 days', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData().code).toBe('INVALID_REQUEST');
		});

		it('returns 200 with jsonl when format is jsonl', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.exportOutcomes.mockResolvedValue({
				window: { from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z', limit: 100, maxDays: 31 },
				outcomes: [
					{ id: 'outcome-1', receivedAt: '2026-08-23T12:00:00.000Z', symbol: 'BTCUSDT', side: 'BUY' },
				],
			});
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { format: 'jsonl', from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(200);
			expect(res.getHeader('Content-Disposition')).toContain('outcomes-2026-08-23-2026-08-24.jsonl');
			expect(res.getHeader('Content-Type')).toContain('application/x-ndjson');
			expect(res._getData().trim().split('\n')).toEqual([
				JSON.stringify({ id: 'outcome-1', receivedAt: '2026-08-23T12:00:00.000Z', symbol: 'BTCUSDT', side: 'BUY' }),
			]);
		});

		it('returns 200 with csv when format is csv', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.exportOutcomes.mockResolvedValue({
				window: { from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z', limit: 100, maxDays: 31 },
				outcomes: [
					{ id: 'outcome-1', receivedAt: '2026-08-23T12:00:00.000Z', symbol: 'BTCUSDT', side: 'BUY' },
				],
			});
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { format: 'csv', from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(200);
			expect(res.getHeader('Content-Disposition')).toContain('outcomes-2026-08-23-2026-08-24.csv');
			expect(res.getHeader('Content-Type')).toContain('text/csv');
			expect(res._getData()).toContain('id,receivedAt,source,symbol,exchange,side,price,setupType,score,outcomes');
			expect(res._getData()).toContain('outcome-1,2026-08-23T12:00:00.000Z,,BTCUSDT,,BUY,');
		});

		it('returns 503 when storage is unavailable', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const error = new Error('Firestore is unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			signalOutcomeService.exportOutcomes.mockRejectedValue(error);
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/outcomes/export',
				query: { from: '2026-08-23T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
			});
			const res = httpMocks.createResponse();

			await exportOutcomes(req, res);

			expect(res.statusCode).toBe(503);
			expect(res._getJSONData().code).toBe('STORAGE_UNAVAILABLE');
		});
	});
});
