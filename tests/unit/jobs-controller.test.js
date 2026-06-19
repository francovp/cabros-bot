'use strict';

const httpMocks = require('node-mocks-http');
const {
	postCreateJob,
	getJobStatus,
	postCancelJob,
	postRetryJob,
	postRetryFailedJob,
} = require('../../src/controllers/webhooks/handlers/jobs/jobs');
const { jobService } = require('../../src/services/jobs/JobService');
const sentryService = require('../../src/services/monitoring/SentryService');

jest.mock('../../src/services/jobs/JobService', () => ({
	jobService: {
		createJob: jest.fn(),
		getJob: jest.fn(),
		cancelJob: jest.fn(),
		retryJob: jest.fn(),
		retryFailedJob: jest.fn(),
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
		it('returns 400 if type is missing', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/tradingview-analysis',
				body: {},
			});
			const res = httpMocks.createResponse();

			await postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(400);
			const data = res._getJSONData();
			expect(data.error).toBe('Missing type parameter');
			expect(data.code).toBe('INVALID_REQUEST');
		});

		it('returns 201 and job metadata on successful creation', async () => {
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

			await postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(201);
			expect(res._getJSONData()).toEqual(mockResult);
			expect(jobService.createJob).toHaveBeenCalledWith('expanded-analysis', req.body, null);
		});

		it('returns 404/400 if jobService.createJob throws a validation or feature error', async () => {
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

			await postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(404);
			const data = res._getJSONData();
			expect(data.error).toBe('Market scanner is not enabled');
			expect(data.code).toBe('FEATURE_DISABLED');
		});

		it('returns 500 and records error to Sentry on unexpected throw', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/tradingview-analysis',
				body: { type: 'expanded-analysis' },
			});
			const res = httpMocks.createResponse();

			jobService.createJob.mockImplementationOnce(() => {
				throw new Error('Unexpected DB error');
			});

			await postCreateJob(null)(req, res);

			expect(res.statusCode).toBe(500);
			const data = res._getJSONData();
			expect(data.error).toBe('Internal server error');
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});
	});

	describe('getJobStatus', () => {
		it('returns 400 if jobId is missing', async () => {
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/jobs/',
				params: {},
			});
			const res = httpMocks.createResponse();

			await getJobStatus(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData().error).toBe('Missing jobId parameter');
		});

		it('returns 404 if job is not found', async () => {
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/jobs/missing-job-id',
				params: { jobId: 'missing-job-id' },
			});
			const res = httpMocks.createResponse();

			jobService.getJob.mockReturnValueOnce(null);

			await getJobStatus(req, res);

			expect(res.statusCode).toBe(404);
			expect(res._getJSONData()).toEqual({
				success: false,
				error: 'Job not found',
			});
		});

		it('returns 200 and job details if job exists', async () => {
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

			await getJobStatus(req, res);

			expect(res.statusCode).toBe(200);
			expect(res._getJSONData()).toEqual({
				success: true,
				...mockJob,
			});
		});

		it('returns 500 and records error to Sentry on unexpected throw', async () => {
			const req = httpMocks.createRequest({
				method: 'GET',
				url: '/api/jobs/existing-job-id',
				params: { jobId: 'existing-job-id' },
			});
			const res = httpMocks.createResponse();

			jobService.getJob.mockImplementationOnce(() => {
				throw new Error('Disk crash');
			});

			await getJobStatus(req, res);

			expect(res.statusCode).toBe(500);
			expect(sentryService.captureRuntimeError).toHaveBeenCalled();
		});
	});

	describe('postCancelJob', () => {
		it('returns 400 if jobId is missing', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs//cancel',
				params: {},
			});
			const res = httpMocks.createResponse();

			await postCancelJob(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData().error).toBe('Missing jobId parameter');
		});

		it('returns 404 if job is not found', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/missing-job-id/cancel',
				params: { jobId: 'missing-job-id' },
			});
			const res = httpMocks.createResponse();

			jobService.cancelJob.mockResolvedValueOnce(null);

			await postCancelJob(req, res);

			expect(res.statusCode).toBe(404);
			expect(res._getJSONData().error).toBe('Job not found');
		});

		it('returns 409 if job is terminal', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/terminal-job-id/cancel',
				params: { jobId: 'terminal-job-id' },
			});
			const res = httpMocks.createResponse();

			const mockResult = {
				success: false,
				code: 'TERMINAL_JOB',
				message: 'Job is already in a terminal state.',
				status: 'completed',
			};
			jobService.cancelJob.mockResolvedValueOnce(mockResult);

			await postCancelJob(req, res);

			expect(res.statusCode).toBe(409);
			expect(res._getJSONData().code).toBe('TERMINAL_JOB');
		});

		it('returns 200 on successful cancellation', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/running-job-id/cancel',
				params: { jobId: 'running-job-id' },
			});
			const res = httpMocks.createResponse();

			const mockResult = {
				success: true,
				jobId: 'running-job-id',
				status: 'cancelled',
			};
			jobService.cancelJob.mockResolvedValueOnce(mockResult);

			await postCancelJob(req, res);

			expect(res.statusCode).toBe(200);
			expect(res._getJSONData()).toEqual(mockResult);
		});
	});

	describe('postRetryJob', () => {
		it('returns 201 and new job details on success', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/failed-job-id/retry',
				params: { jobId: 'failed-job-id' },
			});
			const res = httpMocks.createResponse();

			const mockResult = {
				success: true,
				oldJobId: 'failed-job-id',
				newJobId: 'new-job-id',
				status: 'processing',
			};
			jobService.retryJob.mockResolvedValueOnce(mockResult);

			await postRetryJob(null)(req, res);

			expect(res.statusCode).toBe(201);
			expect(res._getJSONData()).toEqual(mockResult);
		});
	});

	describe('postRetryFailedJob', () => {
		it('returns 201 on success', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/mixed-job-id/retry-failed',
				params: { jobId: 'mixed-job-id' },
			});
			const res = httpMocks.createResponse();

			const mockResult = {
				success: true,
				oldJobId: 'mixed-job-id',
				newJobId: 'new-job-id',
				status: 'processing',
			};
			jobService.retryFailedJob.mockResolvedValueOnce(mockResult);

			await postRetryFailedJob(null)(req, res);

			expect(res.statusCode).toBe(201);
			expect(res._getJSONData()).toEqual(mockResult);
		});

		it('returns 400 if no failed items to retry', async () => {
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/jobs/all-success-job-id/retry-failed',
				params: { jobId: 'all-success-job-id' },
			});
			const res = httpMocks.createResponse();

			const mockResult = {
				success: false,
				code: 'NO_FAILED_ITEMS',
				message: 'No failed items to retry.',
			};
			jobService.retryFailedJob.mockResolvedValueOnce(mockResult);

			await postRetryFailedJob(null)(req, res);

			expect(res.statusCode).toBe(400);
			expect(res._getJSONData().code).toBe('NO_FAILED_ITEMS');
		});
	});
});
