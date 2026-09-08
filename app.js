const express = require('express');
const { setupTrustProxy } = require('./src/lib/trustProxy');

const app = express();
const { createCorsMiddleware } = require('./src/lib/cors');
const helmet = require('helmet');
const { getOpenApiDocsRouter } = require('./src/openapi/docs');
const bootstrapReadiness = require('./src/lib/bootstrapReadiness');

// Configure trusted proxies (e.g. Render reverse proxy or TRUST_PROXY setting)
setupTrustProxy(app);

// Tell express to use body-parser's urlencoded parsing
app.use(express.urlencoded({ extended: false }));
// Tell express to use body-parser's JSON and text parsing
app.use(express.text({ type: 'text/plain' }));
app.use(express.json());

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

// Global request-deadline middleware: enforces a per-request server-side
// budget so a single hung downstream call cannot pin a connection open.
// Mounted after the OpenAPI router so /openapi.json and /docs stay exempt.
app.use(require('./src/lib/requestDeadline'));

// Public, read-only API contract and interactive documentation.
app.use(getOpenApiDocsRouter());

module.exports = app;
