const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');

function getRoutes(bot) {
	const router = express.Router();
	router.post('/webhook/alert', postAlert(bot));

	// Register news-monitor endpoint if feature is enabled
	if (process.env.ENABLE_NEWS_MONITOR === 'true') {
		const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
		const newsMonitor = getNewsMonitor();
		router.post('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));
		router.get('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));
		console.log('[Routes] News Monitor endpoint registered at /api/news-monitor');
	}

	return router;
}

module.exports = { getRoutes };
