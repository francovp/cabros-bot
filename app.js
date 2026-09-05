const express = require('express');
const { setupTrustProxy } = require('./src/lib/trustProxy');

const app = express();
const { createCorsMiddleware } = require('./src/lib/cors');
const helmet = require('helmet');
const { getOpenApiDocsRouter } = require('./src/openapi/docs');
const bootstrapReadiness = require('./src/lib/bootstrapReadiness');
const { getPublicStatus } = require('./src/controllers/publicStatus');
const { getStatus: getAdminStatus } = require('./src/controllers/status');

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

// Public, unauthenticated, read-only status snapshot. Mounted before the
// rate limiter so monitoring traffic and embedded status widgets never hit
// the global bucket and never require operator credentials.
app.get('/api/public/status', getPublicStatus(getAdminStatus));

// Rate Limiter (must be after healthcheck to avoid limiting health checks)
app.use(require('./src/lib/rateLimiter'));

// Public, read-only API contract and interactive documentation.
app.use(getOpenApiDocsRouter());

module.exports = app;
