const express = require('express');
const { setupTrustProxy } = require('./src/lib/trustProxy');

const app = express();
const { createCorsMiddleware } = require('./src/lib/cors');
const helmet = require('helmet');
const { getOpenApiDocsRouter } = require('./src/openapi/docs');
const bootstrapReadiness = require('./src/lib/bootstrapReadiness');
const { buildWebhookBodySize } = require('./src/lib/webhookBodySize');

// Configure trusted proxies (e.g. Render reverse proxy or TRUST_PROXY setting)
setupTrustProxy(app);

// Webhook body size limits (configurable via WEBHOOK_MAX_BODY_SIZE; default 256kb).
// Centralized so both JSON and text/plain parsers share the same effective limit and
// the structured 413 error handler is wired in one place.
const webhookBodySize = buildWebhookBodySize();
const webhookBodyPaths = ['/api/webhook', '/api/news-monitor'];

// Tell express to use body-parser's urlencoded parsing
app.use(express.urlencoded({ extended: false }));
// Apply the configurable limit only to webhook-style request bodies. Other API
// routes retain Express' existing parser behavior and limit.
app.use(webhookBodyPaths, express.text({ type: 'text/plain', limit: webhookBodySize.textLimit }));
app.use(webhookBodyPaths, express.json({ limit: webhookBodySize.jsonLimit }));
app.use(webhookBodyPaths, webhookBodySize.middleware);
// Preserve the existing default parsers for non-webhook routes.
app.use(express.text({ type: 'text/plain' }));
app.use(express.json());

// Configurar Cabeseras y CORS
app.use(createCorsMiddleware());

// Use helmet for improved security
const contentSecurityPolicy = helmet.contentSecurityPolicy.getDefaultDirectives();
contentSecurityPolicy['script-src'] = ['\'self\'', 'https://www.gstatic.com'];
contentSecurityPolicy['connect-src'] = [
	'\'self\'',
	'https://identitytoolkit.googleapis.com',
	'https://securetoken.googleapis.com',
	'https://www.googleapis.com',
	'https://*.web.app',
	'https://*.firebaseapp.com',
	'https://cabros-bot-production.up.railway.app',
];
app.use(helmet({ contentSecurityPolicy: { directives: contentSecurityPolicy } }));

const { getDeepHealthcheckHandler } = require('./src/controllers/healthcheck');
app.use('/healthcheck', getDeepHealthcheckHandler());
app.get('/ready', (req, res) => {
	const status = bootstrapReadiness.getStatus();
	return res.status(status.ready ? 200 : 503).json(status);
});

// Rate Limiter (must be after healthcheck to avoid limiting health checks)
app.use(require('./src/lib/rateLimiter'));

// Public, read-only API contract and interactive documentation.
app.use(getOpenApiDocsRouter());

module.exports = app;
