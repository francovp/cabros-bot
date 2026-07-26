const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');
const { postMessage } = require('../controllers/webhooks/handlers/message/message');
const { postExpandedAnalysisAlert } = require('../controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert');
const { postMarketScannerAlert } = require('../controllers/webhooks/handlers/marketScanner/marketScanner');
const {
	postPreset,
	listPresets,
	getPreset,
	deletePreset,
	updatePreset,
	postRunPreset,
} = require('../controllers/webhooks/handlers/scannerPresets/scannerPresets');
const { postVolumeConfirmation } = require('../controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation');
const {
	postCreateJob,
	getJobList,
	getJobStatus,
	postCancelJob,
	postRetryJob,
	postRetryFailedJob,
} = require('../controllers/webhooks/handlers/jobs/jobs');
const { listAlerts, getAlertById, replayAlert, summarizeAlerts, exportAlerts } = require('../controllers/alerts/alerts');
const { validateApiKey } = require('../lib/auth');
const { getApiStatus } = require('../controllers/status');
const { idempotencyMiddleware } = require('../lib/idempotency');

function getRoutes(botOrGetter) {
	const router = express.Router();

	// Centralized API key authentication middleware for all routes
	router.use(validateApiKey);

	router.post('/webhook/alert', idempotencyMiddleware, postAlert(botOrGetter));
	router.post('/webhook/message', postMessage(botOrGetter));
	router.post('/webhook/expanded-analysis-alert', idempotencyMiddleware, postExpandedAnalysisAlert(botOrGetter));
	router.post('/webhook/market-scanner-alert', idempotencyMiddleware, postMarketScannerAlert(botOrGetter));
	router.post('/webhook/volume-confirmation', postVolumeConfirmation());
	router.get('/alerts', listAlerts);
	router.get('/alerts/summary', summarizeAlerts);
	router.get('/alerts/export', exportAlerts);
	router.post('/alerts/:alertId/replay', idempotencyMiddleware, replayAlert(botOrGetter));
	router.get('/alerts/:alertId', getAlertById);
	router.post('/scanner-presets', postPreset);
	router.get('/scanner-presets', listPresets);
	router.get('/scanner-presets/:id', getPreset);
	router.put('/scanner-presets/:id', updatePreset);
	router.delete('/scanner-presets/:id', deletePreset);
	router.post('/scanner-presets/:id/run', postRunPreset(botOrGetter));

	// Async job endpoints
	router.post('/jobs/tradingview-analysis', postCreateJob(botOrGetter));
	router.get('/jobs', getJobList);
	router.get('/jobs/:jobId', getJobStatus);
	router.post('/jobs/:jobId/cancel', postCancelJob);
	router.post('/jobs/:jobId/retry', postRetryJob(botOrGetter));
	router.post('/jobs/:jobId/retry-failed', postRetryFailedJob(botOrGetter));

	const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
	const newsMonitor = getNewsMonitor();
	router.post('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));
	router.get('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));

	router.get('/status', getApiStatus);
	router.get('/capabilities', getApiStatus);

	return router;
}

module.exports = { getRoutes };
