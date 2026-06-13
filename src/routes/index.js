const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');
const { postExpandedAnalysisAlert } = require('../controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert');
const { postMarketScannerAlert } = require('../controllers/webhooks/handlers/marketScanner/marketScanner');
const { postVolumeConfirmation } = require('../controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation');
const { postCreateJob, getJobStatus } = require('../controllers/webhooks/handlers/jobs/jobs');
const { listAlerts, getAlertById } = require('../controllers/alerts/alerts');
const { postPreset, listPresets, getPreset, deletePreset, updatePreset, postRunPreset } = require('../controllers/webhooks/handlers/scannerPresets/scannerPresets');
const { validateApiKey } = require('../lib/auth');
const { getApiStatus } = require('../controllers/status');
const { idempotencyMiddleware } = require('../lib/idempotency');

function getRoutes(botOrGetter) {
	const router = express.Router();
	router.post('/webhook/alert', validateApiKey, idempotencyMiddleware, postAlert(botOrGetter));
	router.post('/webhook/expanded-analysis-alert', validateApiKey, idempotencyMiddleware, postExpandedAnalysisAlert(botOrGetter));
	router.post('/webhook/market-scanner-alert', validateApiKey, idempotencyMiddleware, postMarketScannerAlert(botOrGetter));
	router.post('/webhook/volume-confirmation', validateApiKey, postVolumeConfirmation());
	router.get('/alerts', validateApiKey, listAlerts);
	router.get('/alerts/:alertId', validateApiKey, getAlertById);

	// Async job endpoints
	router.post('/jobs/tradingview-analysis', validateApiKey, postCreateJob(botOrGetter));
	router.get('/jobs/:jobId', validateApiKey, getJobStatus);

	// Scanner presets CRUD
	router.post('/scanner-presets', validateApiKey, postPreset);
	router.get('/scanner-presets', validateApiKey, listPresets);
	router.get('/scanner-presets/:id', validateApiKey, getPreset);
	router.put('/scanner-presets/:id', validateApiKey, updatePreset);
	router.delete('/scanner-presets/:id', validateApiKey, deletePreset);
	router.post('/scanner-presets/:id/run', validateApiKey, postRunPreset(botOrGetter));

	const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
	const newsMonitor = getNewsMonitor();
	router.post('/news-monitor', validateApiKey, newsMonitor.handleRequest.bind(newsMonitor));
	router.get('/news-monitor', validateApiKey, newsMonitor.handleRequest.bind(newsMonitor));

	router.get('/status', validateApiKey, getApiStatus);
	router.get('/capabilities', validateApiKey, getApiStatus);

	return router;
}

module.exports = { getRoutes };
