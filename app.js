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

// Tell express to use body-parser's urlencoded parsing
app.use(express.urlencoded({ extended: false }));
// Tell express to use body-parser's JSON and text parsing with explicit size limits
app.use(express.text({ type: 'text/plain', limit: webhookBodySize.textLimit }));
app.use(express.json({ limit: webhookBodySize.jsonLimit }));

// Configurar Cabeseras y CORS
app.use(createCorsMiddleware());

// Use helmet for improved security
const contentSecurityPolicy = helmet.contentSecurityPolicy.getDefaultDirectives();
contentSecurityPolicy['script-src'] = ["'self'", 'https://www.gstatic.com'];
contentSecurityPolicy['connect-src'] = [
	"'self'",
	'https://identitytoolkit.googleapis.com',
	'https://securetoken.googleapis.com',
	'https://www.googleapis.com',
	'https://*.web.app',
	'https://*.firebaseapp.com',
	'https://cabros-bot-production.up.railway.app',
];
app.use(helmet({ contentSecurityPolicy: { directives: contentSecurityPolicy } }));

app.use('/healthcheck', require('express-healthcheck')());
app.get('/ready', (req, res) => {
	const status = bootstrapReadiness.getStatus();
	return res.status(status.ready ? 200 : 503).json(status);
});

// Rate Limiter (must be after healthcheck to avoid limiting health checks)
app.use(require('./src/lib/rateLimiter'));

// Public, read-only API contract and interactive documentation.
app.use(getOpenApiDocsRouter());

// Convert body-parser `entity.too.large` errors into a structured 413 response.
// Registered after the body parsers (above) so it can intercept oversized payloads
// raised during JSON/text parsing before any controller runs.
app.use(webhookBodySize.middleware);

module.exports = app;
