const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');

function getRoutes() {
	const router = express.Router();
	router.post('/webhook/alert', postAlert());
	console.log('[Routes] Alert webhook endpoint registered at /api/webhook/alert');

	const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
	const newsMonitor = getNewsMonitor();
	router.post('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));
	router.get('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));
	console.log('[Routes] News Monitor endpoint registered at /api/news-monitor');

	return router;
}

module.exports = { getRoutes };
