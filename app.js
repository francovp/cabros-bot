const express = require('express');
const { setupTrustProxy } = require('./src/lib/trustProxy');

const app = express();
const { createCorsMiddleware } = require('./src/lib/cors');
const helmet = require('helmet');
const { getOpenApiDocsRouter } = require('./src/openapi/docs');
const bootstrapReadiness = require('./src/lib/bootstrapReadiness');

// Configure trusted proxies (e.g. Render reverse proxy or TRUST_PROXY setting)
setupTrustProxy(app);

// Explicit body-size limits for all body parsers. Without an explicit `limit`
// option, express.json()/text()/urlencoded() rely on undocumented defaults
// (100kb) that can be changed accidentally. Capping at 100kb matches the
// existing default and rejects oversized payloads with 413 before they
// consume application memory.
const BODY_PARSER_LIMIT = '100kb';
// Tell express to use body-parser's urlencoded parsing
app.use(express.urlencoded({ extended: false, limit: BODY_PARSER_LIMIT }));
// Tell express to use body-parser's JSON and text parsing
app.use(express.text({ type: 'text/plain', limit: BODY_PARSER_LIMIT }));
app.use(express.json({ limit: BODY_PARSER_LIMIT }));

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

module.exports = app;
