const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');
const { validateApiKey } = require('../lib/auth');

function getRoutes() {
	const router = express.Router();
	router.post('/webhook/alert', validateApiKey, postAlert());

	const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
	const newsMonitor = getNewsMonitor();
	router.post('/news-monitor', validateApiKey, newsMonitor.handleRequest.bind(newsMonitor));
	router.get('/news-monitor', validateApiKey, newsMonitor.handleRequest.bind(newsMonitor));

	return router;
}

module.exports = { getRoutes };
