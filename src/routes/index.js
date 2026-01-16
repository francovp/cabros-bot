const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');
const { validateApiKey } = require('../middleware/auth');

function getRoutes() {
	const router = express.Router();

	// Apply authentication to all webhook routes
	router.use('/webhook/alert', validateApiKey);
	router.use('/news-monitor', validateApiKey);

	router.post('/webhook/alert', postAlert());

	const { getNewsMonitor } = require('../controllers/webhooks/handlers/newsMonitor/newsMonitor');
	const newsMonitor = getNewsMonitor();
	router.post('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));
	router.get('/news-monitor', newsMonitor.handleRequest.bind(newsMonitor));

	return router;
}

module.exports = { getRoutes };
