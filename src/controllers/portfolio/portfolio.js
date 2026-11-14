'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const portfolioService = require('../../services/portfolio/PortfolioAnalyticsService');
const alertStorageService = require('../../services/storage/AlertStorageService');

async function getPortfolioSnapshot(req, res) {
	return handleAsync(req, res, '/api/portfolio/snapshot', async () => {
		if (!portfolioService.isEnabled()) {
			return res.status(403).json({
				error: 'Portfolio analytics is disabled. Set ENABLE_PORTFOLIO_ANALYTICS=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const result = await portfolioService.buildPortfolioSnapshot({});
		return res.status(200).json({
			success: true,
			snapshot: result,
		});
	});
}

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
		console.error('[PortfolioController] Request failed:', error.message);
		const statusCode = error.code === portfolioService.STORAGE_UNAVAILABLE_CODE
			? 503
			: (error.code === 'FEATURE_DISABLED' ? 403 : 500);
		sentryService.captureRuntimeError({
			channel: 'portfolio-controller',
			error,
			http: {
				endpoint,
				method: req.method,
				statusCode,
			},
		});

		if (statusCode === 503) {
			return res.status(503).json({
				error: error.message,
				code: portfolioService.STORAGE_UNAVAILABLE_CODE,
			});
		}

		if (statusCode === 403) {
			return res.status(403).json({
				error: error.message,
				code: 'FEATURE_DISABLED',
			});
		}

		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	});
}

// Reference the storage service so the dependency is observable for status surfaces.
function getPortfolioDependencyState() {
	const storageReady = alertStorageService && typeof alertStorageService.isEnabled === 'function' && alertStorageService.isEnabled();
	return {
		enabled: portfolioService.isEnabled(),
		storage: storageReady ? 'ready' : 'unavailable',
	};
}

module.exports = {
	getPortfolioSnapshot,
	getPortfolioDependencyState,
};
