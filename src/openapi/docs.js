'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const swaggerUiDist = require('swagger-ui-dist');
const contract = require('./openapi.json');
const { getAdminAuthConfig } = require('../lib/adminAuth');

const docsHtmlPath = path.join(__dirname, 'index.html');
const initializerPath = path.join(__dirname, 'swagger-initializer.js');
const adminDir = path.join(__dirname, '../admin');
const repoRoot = path.join(__dirname, '..', '..');

let runbookContent = '';
try {
	runbookContent = fs.readFileSync(path.join(repoRoot, 'RUNBOOK.md'), 'utf8');
} catch {
	runbookContent = '# Cabros Bot Operator Runbook\n\nRunbook unavailable.\n';
}

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

	router.get('/admin/auth-config', (req, res) => res.json(getAdminAuthConfig()));

	router.use('/admin', express.static(adminDir, {
		index: false,
		setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
	}));

	// Public, unauthenticated operator runbook so the admin console sidebar
	// link (`/RUNBOOK.md`) resolves without API-key auth. The runbook is
	// loaded into memory at startup to serve without per-request disk I/O.
	router.get('/RUNBOOK.md', (req, res) => {
		res.set('Cache-Control', 'no-cache');
		res.type('text/markdown');
		return res.send(runbookContent);
	});

	return router;
}

module.exports = { getOpenApiDocsRouter };
