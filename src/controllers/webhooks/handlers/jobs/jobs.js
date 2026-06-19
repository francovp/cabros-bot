'use strict';

const { jobService } = require('../../../../services/jobs/JobService');
const sentryService = require('../../../../services/monitoring/SentryService');

function postCreateJob(botOrGetter) {
	return async (req, res) => {
		const { type } = req.body || {};

		if (!type) {
			return res.status(400).json({
				error: 'Missing type parameter',
				code: 'INVALID_REQUEST',
			});
		}

		try {
			const result = await jobService.createJob(type, req.body, botOrGetter);
			return res.status(201).json(result);
		} catch (error) {
			if (
				error.name === 'ExpandedAnalysisAlertRequestError' ||
				error.name === 'MarketScannerRequestError' ||
				error.statusCode
			) {
				return res.status(error.statusCode || 400).json({
					error: error.message,
					code: error.code || 'INVALID_REQUEST',
				});
			}

			console.error('[JobsController] Failed to create job:', error.message);
			sentryService.captureRuntimeError({
				channel: 'jobs-controller',
				error,
				http: {
					endpoint: '/api/jobs/tradingview-analysis',
					method: 'POST',
					statusCode: 500,
				},
			});

			return res.status(500).json({
				error: 'Internal server error',
				code: 'INTERNAL_ERROR',
			});
		}
	};
}

async function getJobStatus(req, res) {
	const { jobId } = req.params;

	if (!jobId) {
		return res.status(400).json({
			error: 'Missing jobId parameter',
			code: 'INVALID_REQUEST',
		});
	}

	try {
		const job = await jobService.getJob(jobId);

		if (!job) {
			return res.status(404).json({
				success: false,
				error: 'Job not found',
			});
		}

		return res.status(200).json({
			success: true,
			...job,
		});
	} catch (error) {
		console.error('[JobsController] Failed to get job status:', error.message);
		sentryService.captureRuntimeError({
			channel: 'jobs-controller',
			error,
			http: {
				endpoint: `/api/jobs/${jobId}`,
				method: 'GET',
				statusCode: 500,
			},
		});

		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

module.exports = {
	postCreateJob,
	getJobStatus,
};
