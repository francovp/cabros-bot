'use strict';

const path = require('path');
const express = require('express');
const swaggerUiDist = require('swagger-ui-dist');
const contract = require('./openapi.json');

const docsHtmlPath = path.join(__dirname, 'index.html');
const initializerPath = path.join(__dirname, 'swagger-initializer.js');
const adminDir = path.join(__dirname, '../admin');

function getOpenApiDocsRouter() {
	const router = express.Router();

	router.get('/openapi.json', (req, res) => {
		res.set('Cache-Control', 'no-cache');
		return res.json(contract);
	});

	router.get('/docs', (req, res) => {
		res.set('Cache-Control', 'no-cache');
		return res.sendFile(docsHtmlPath);
	});

	router.get('/docs/swagger-initializer.js', (req, res) => res.sendFile(initializerPath));
	router.use('/docs', express.static(swaggerUiDist.getAbsoluteFSPath(), {
		index: false,
		immutable: true,
		maxAge: '1d',
	}));

	router.get('/admin', (req, res) => {
		res.set('Cache-Control', 'no-cache');
		return res.sendFile(path.join(adminDir, 'index.html'));
	});

	router.use('/admin', express.static(adminDir, {
		index: false,
		immutable: true,
		maxAge: '1d',
	}));

	return router;
}

module.exports = { getOpenApiDocsRouter };
