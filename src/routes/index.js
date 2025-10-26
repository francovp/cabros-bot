const express = require('express');
const { postAlert } = require('../controllers/webhooks/handlers/alert/alert');

function getRoutes(bot) {
	const router = express.Router();
	router.post('/webhook/alert', postAlert(bot));
	return router;
}

module.exports = { getRoutes };
