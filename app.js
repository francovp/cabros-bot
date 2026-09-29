const express = require('express');
const { setupTrustProxy } = require('./src/lib/trustProxy');

const app = express();
const { createCorsMiddleware } = require('./src/lib/cors');
const helmet = require('helmet');
const { getOpenApiDocsRouter } = require('./src/openapi/docs');
const bootstrapReadiness = require('./src/lib/bootstrapReadiness');
const { getPublicStatus } = require('./src/controllers/publicStatus');
const { getStatus: getAdminStatus } = require('./src/controllers/status');
const requestDeadline = require('./src/lib/requestDeadline');
const { buildWebhookBodySize } = require('./src/lib/webhookBodySize');

// Configure trusted proxies (e.g. Render reverse proxy or TRUST_PROXY setting)
setupTrustProxy(app);

// Apply CORS before body parsers so parser errors, including structured 413
// responses, retain the same browser-visible headers as successful requests.
app.use(createCorsMiddleware());

// Start the request deadline before body parsing so slow uploads are bounded too.
app.use(requestDeadline);

// Webhook body size limits (configurable via WEBHOOK_MAX_BODY_SIZE; default 256kb).
// Centralized so both JSON and text/plain parsers share the same effective limit and
// the structured 413 error handler is wired in one place.
const webhookBodySize = buildWebhookBodySize();
const webhookBodyPaths = ['/api/webhook', /^\/api\/news-monitor\/?$/];

// Apply the configurable limit only to webhook-style request bodies. Other API
// routes retain Express' existing parser behavior and limit.
app.use(webhookBodyPaths, express.urlencoded({ extended: false, limit: webhookBodySize.jsonLimit }));
app.use(webhookBodyPaths, express.text({ type: 'text/plain', limit: webhookBodySize.textLimit }));
app.use(webhookBodyPaths, express.json({ limit: webhookBodySize.jsonLimit }));
app.use(webhookBodyPaths, webhookBodySize.middleware);
// Preserve the existing default parsers for non-webhook routes.
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: 'text/plain' }));
app.use(express.json());

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
app.use(requestDeadline.guard);

const { getDeepHealthcheckHandler } = require('./src/controllers/healthcheck');
const { handleDependencyReadiness } = require('./src/controllers/readiness');

function isDependencyReadinessRequested(req) {
	if (req && req.query && req.query.depth === 'readiness') {
		return true;
	}
	// /ready?depth=dependencies layers the external provider probe on top of the
	// bootstrap gate. Bare /ready keeps the master bootstrap contract untouched.
	return Boolean(req && req.path === '/ready' && req.query && req.query.depth === 'dependencies');
}

// `depth=readiness` runs external provider probes; bare requests keep the
// legacy liveness / `?deep=true` channel contract from master.
app.use('/healthcheck', (req, res, next) => {
	if (isDependencyReadinessRequested(req)) {
		return handleDependencyReadiness(req, res, { failClosed: false });
	}
	return getDeepHealthcheckHandler()(req, res, next);
});

app.get('/ready', (req, res) => {
	if (isDependencyReadinessRequested(req)) {
		return handleDependencyReadiness(req, res, { failClosed: true });
	}
	const status = bootstrapReadiness.getStatus();
	return res.status(status.ready ? 200 : 503).json(status);
});

// Public, unauthenticated, read-only status snapshot. Mounted before the
// rate limiter so monitoring traffic and embedded status widgets never hit
// the global bucket and never require operator credentials.
app.get('/api/public/status', getPublicStatus(getAdminStatus));

// Public, read-only API contract and interactive documentation (mounted before
// the rate limiter so browsing documentation and the admin console does not consume
// the protected /api budget).
app.use(getOpenApiDocsRouter());

// Rate Limiter (must be after healthcheck, public status, and public docs to avoid limiting them)
app.use(require('./src/lib/rateLimiter'));

module.exports = app;
