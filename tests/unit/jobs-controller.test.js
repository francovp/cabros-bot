'use strict';

const httpMocks = require('node-mocks-http');
const { postCreateJob, getJobStatus } = require('../../src/controllers/webhooks/handlers/jobs/jobs');
const { jobService } = require('../../src/services/jobs/JobService');
const sentryService = require('../../src/services/monitoring/SentryService');

jest.mock('../../src/services/jobs/JobService', () => ({
	jobService: {
		createJob: jest.fn(),
		getJob: jest.fn(),
	},
}));

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
}));

describe('Jobs Controller Unit Tests', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('postCreateJob', () => {
		it('returns 400 if type is missing', () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/tradingview-analysis',
				body: {},
			});
			const res = httpMocks.createResponse();

			postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(400);
			const data = res._getJSONData();
			expect(data.error).toBe('Missing type parameter');
			expect(data.code).toBe('INVALID_REQUEST');
		});

		it('returns 201 and job metadata on successful creation', () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/tradingview-analysis',
				body: { type: 'expanded-analysis', symbols: ['BINANCE:BTCUSDT'] },
			});
			const res = httpMocks.createResponse();

			const mockResult = {
				success: true,
				jobId: 'test-job-id',
				status: 'processing',
				createdAt: new Date().toISOString(),
			};
			jobService.createJob.mockReturnValueOnce(mockResult);

			postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(201);
			expect(res._getJSONData()).toEqual(mockResult);
			expect(jobService.createJob).toHaveBeenCalledWith('expanded-analysis', req.body, null);
		});

		it('returns 404/400 if jobService.createJob throws a validation or feature error', () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/tradingview-analysis',
				body: { type: 'market-scanner' },
			});
			const res = httpMocks.createResponse();

			const error = new Error('Market scanner is not enabled');
			error.code = 'FEATURE_DISABLED';
			error.statusCode = 404;
			jobService.createJob.mockImplementationOnce(() => {
				throw error;
			});

			postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(404);
			const data = res._getJSONData();
			expect(data.error).toBe('Market scanner is not enabled');
			expect(data.code).toBe('FEATURE_DISABLED');
		});

		it('returns 500 and records error to Sentry on unexpected throw', () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/tradingview-analysis',
				body: { type: 'expanded-analysis' },
			});
			const res = httpMocks.createResponse();

			jobService.createJob.mockImplementationOnce(() => {
				throw new Error('Unexpected DB error');
			});

			postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(500);
			const data = res._getJSONData();
			expect(data.error).toBe('Internal server error');
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});
	});

	describe('getJobStatus', () => {
		it('returns 400 if jobId is missing', () => {
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/jobs/',
				params: {},
			});
			const res = httpMocks.createResponse();

			getJobStatus(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData().error).toBe('Missing jobId parameter');
		});

		it('returns 404 if job is not found', () => {
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/jobs/missing-job-id',
				params: { jobId: 'missing-job-id' },
			});
			const res = httpMocks.createResponse();

			jobService.getJob.mockReturnValueOnce(null);

			getJobStatus(req, res);

			expect(res.statusCode).toBe(404);
			expect(res._getJSONData()).toEqual({
				success: false,
				error: 'Job not found',
			});
		});

		it('returns 200 and job details if job exists', () => {
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/jobs/existing-job-id',
				params: { jobId: 'existing-job-id' },
			});
			const res = httpMocks.createResponse();

			const mockJob = {
				jobId: 'existing-job-id',
				type: 'expanded-analysis',
				status: 'completed',
				progress: { total: 1, current: 1, status: 'done' },
				alertText: 'Mock Alert',
			};
			jobService.getJob.mockReturnValueOnce(mockJob);

			getJobStatus(req, res);

			expect(res.statusCode).toBe(200);
			expect(res._getJSONData()).toEqual({
				success: true,
				...mockJob,
			});
		});

		it('returns 500 and records error to Sentry on unexpected throw', () => {
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/jobs/existing-job-id',
				params: { jobId: 'existing-job-id' },
			});
			const res = httpMocks.createResponse();

			jobService.getJob.mockImplementationOnce(() => {
				throw new Error('Disk crash');
			});

			getJobStatus(req, res);

			expect(res.statusCode).toBe(500);
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});
	});
});
