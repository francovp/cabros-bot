const express = require('express');
const { setupTrustProxy } = require('./src/lib/trustProxy');
const { setupCorsAllowlist } = require('./src/lib/corsAllowlist');

const app = express();
const helmet = require('helmet');
const { getOpenApiDocsRouter } = require('./src/openapi/docs');

// Configure trusted proxies (e.g. Render reverse proxy or TRUST_PROXY setting)
setupTrustProxy(app);

// Tell express to use body-parser's urlencoded parsing
app.use(express.urlencoded({ extended: false }));
// Tell express to use body-parser's JSON and text parsing
app.use(express.text({ type: 'text/plain' }));
app.use(express.json());

// Origin-restricted CORS allowlist (replaces the prior `cors()` wildcard grant).
// Server-to-server, curl, and same-origin requests without an Origin header
// pass through unchanged; browser requests are only granted when the Origin
// matches the explicit allowlist (see CORS_ALLOWED_ORIGINS).
setupCorsAllowlist(app);

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

// Rate Limiter (must be after healthcheck to avoid limiting health checks)
app.use(require('./src/lib/rateLimiter'));

// Public, read-only API contract and interactive documentation.
app.use(getOpenApiDocsRouter());

module.exports = app;
