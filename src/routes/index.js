const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');

function getRoutes() {
	const router = express.Router();
	router.post('/webhook/alert', postAlert());

	const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
	const newsMonitor = getNewsMonitor();
	router.post('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));
	router.get('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));

	return router;
}

module.exports = { getRoutes };
