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
const {
	listChatSubscriptions,
	createChatSubscription,
	deleteChatSubscription,
	getChatSubscriptionStatus,
} = require('../controllers/webhooks/handlers/chatSubscriptions/chatSubscriptions');
const { postVolumeConfirmation } = require('../controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation');
const { postSymbolAnalysis } = require('../controllers/webhooks/handlers/symbolAnalysis/symbolAnalysis');
const {
	postCreateJob,
	getJobList,
	getJobStatus,
	postCancelJob,
	postRetryJob,
	postRetryFailedJob,
} = require('../controllers/webhooks/handlers/jobs/jobs');
const { listAlerts, getAlertById, replayAlert, summarizeAlerts, exportAlerts, listReplays } = require('../controllers/alerts/alerts');
const { listOutcomes, summarizeOutcomes } = require('../controllers/outcomes/outcomes');
const { validateApiKey } = require('../lib/auth');
const { getApiStatus } = require('../controllers/status');
const { postBinanceOrder, getBinanceOrders, deleteBinanceOrder } = require('../controllers/trading/binanceOrders');
const { idempotencyMiddleware } = require('../lib/idempotency');
const {
	ADMIN_OPERATOR,
	ADMIN_VIEWER,
	requireAdminRole,
	requireConfiguredAdminAccess,
	validateAdminAccess,
} = require('../lib/adminAuth');

function getRoutes(botOrGetter) {
	const router = express.Router();
	const adminRead = [validateAdminAccess, requireAdminRole(ADMIN_VIEWER)];
	const adminWrite = [validateAdminAccess, requireAdminRole(ADMIN_OPERATOR)];
	const binanceOrderRead = [requireConfiguredAdminAccess, requireAdminRole(ADMIN_VIEWER)];
	const binanceOrderWrite = [requireConfiguredAdminAccess, requireAdminRole(ADMIN_OPERATOR)];
	router.post('/webhook/alert', validateApiKey, idempotencyMiddleware, postAlert(botOrGetter));
	router.post('/webhook/message', validateApiKey, idempotencyMiddleware, postMessage(botOrGetter));
	router.post('/webhook/expanded-analysis-alert', validateApiKey, idempotencyMiddleware, postExpandedAnalysisAlert(botOrGetter));
	router.post('/webhook/market-scanner-alert', validateApiKey, idempotencyMiddleware, postMarketScannerAlert(botOrGetter));
	router.post('/webhook/volume-confirmation', validateApiKey, postVolumeConfirmation());
	router.post('/webhook/symbol-analysis', validateApiKey, postSymbolAnalysis());
	router.get('/alerts', ...adminRead, listAlerts);
	router.get('/alerts/replays', ...adminRead, listReplays);
	router.get('/alerts/summary', ...adminRead, summarizeAlerts);
	router.get('/alerts/export', ...adminRead, exportAlerts);
	router.post('/alerts/:alertId/replay', ...adminWrite, idempotencyMiddleware, replayAlert(botOrGetter));
	router.get('/alerts/:alertId', ...adminRead, getAlertById);
	router.get('/outcomes', ...adminRead, listOutcomes);
	router.get('/outcomes/summary', ...adminRead, summarizeOutcomes);
	router.post('/scanner-presets', ...adminWrite, postPreset);
	router.get('/scanner-presets', ...adminRead, listPresets);
	router.get('/scanner-presets/:id', ...adminRead, getPreset);
	router.put('/scanner-presets/:id', ...adminWrite, updatePreset);
	router.delete('/scanner-presets/:id', ...adminWrite, deletePreset);
	router.post('/scanner-presets/:id/run', ...adminWrite, idempotencyMiddleware, postRunPreset(botOrGetter));
	router.get('/chat-subscriptions', ...adminRead, listChatSubscriptions);
	router.post('/chat-subscriptions', ...adminWrite, idempotencyMiddleware, createChatSubscription);
	router.delete('/chat-subscriptions/:subscriptionId', ...adminWrite, deleteChatSubscription);
	router.delete('/chat-subscriptions', ...adminWrite, deleteChatSubscription);
	router.get('/chat-subscriptions/status', ...adminRead, getChatSubscriptionStatus);

	// Async job endpoints
	router.post('/jobs/tradingview-analysis', ...adminWrite, idempotencyMiddleware, postCreateJob(botOrGetter));
	router.get('/jobs', ...adminRead, getJobList);
	router.get('/jobs/:jobId', ...adminRead, getJobStatus);
	router.post('/jobs/:jobId/cancel', ...adminWrite, postCancelJob);
	router.post('/jobs/:jobId/retry', ...adminWrite, idempotencyMiddleware, postRetryJob(botOrGetter));
	router.post('/jobs/:jobId/retry-failed', ...adminWrite, idempotencyMiddleware, postRetryFailedJob(botOrGetter));
	router.get('/trading/binance/orders', ...binanceOrderRead, getBinanceOrders);
	router.post('/trading/binance/orders', ...binanceOrderWrite, idempotencyMiddleware, postBinanceOrder);
	router.delete('/trading/binance/orders', ...binanceOrderWrite, deleteBinanceOrder);

	const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
	const newsMonitor = getNewsMonitor();
	router.post('/news-monitor', validateApiKey, newsMonitor.handleRequest.bind(newsMonitor));
	router.get('/news-monitor', validateApiKey, newsMonitor.handleRequest.bind(newsMonitor));

	router.get('/status', ...adminRead, getApiStatus);
	router.get('/capabilities', ...adminRead, getApiStatus);

	return router;
}

module.exports = { getRoutes };
