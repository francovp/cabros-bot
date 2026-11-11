'use strict';

const { createReadinessService } = require('../lib/readiness');

let cachedService = null;
let cachedOverrides = undefined;

// Keyed on the overrides object's identity rather than a hand-maintained
// projection of it. The previous string key had to be edited whenever an
// override was added and silently omitted `isFirestoreConfigured` /
// `getFirestoreClient`, which could return a service built for stale
// dependencies. `attachReadinessOverrides` installs exactly one object per
// process, so identity is the correct key.
function getReadinessService(overrides) {
	if (cachedService && cachedOverrides === overrides) {
		return cachedService;
	}
	cachedService = createReadinessService(overrides || {});
	cachedOverrides = overrides;
	return cachedService;
}

function resetReadinessService() {
	cachedService = null;
	cachedOverrides = undefined;
}

async function collectReadiness(overrides) {
	const service = getReadinessService(overrides);
	return service.collectReadiness();
}

/**
 * `failClosed: true`  -> degraded dependencies produce 503 (traffic-gating).
 * `failClosed: false` -> degraded dependencies still return 200 and only the
 *   body reports `ready: false`. A flaky third-party provider must never pull
 *   a healthy replica out of load-balancer rotation, so the report surface is
 *   advisory while the gate surface keeps 503 semantics.
 *
 * When `bootstrap` is supplied (the `/ready?depth=dependencies` surface), the
 * dependency verdict is ANDed with the startup gate and the bootstrap payload
 * is echoed. The dependency probe must never launder a failed or still-pending
 * bootstrap into a 200: that is the exact traffic-cutover failure the gate
 * exists to prevent.
 */
async function handleDependencyReadiness(req, res, options) {
	const startedAt = Date.now();
	const failClosed = Boolean(options && options.failClosed);
	const bootstrap = options && options.bootstrap ? options.bootstrap() : null;
	const overrides = (req && req.app && req.app.locals && req.app.locals.readinessOverrides) || undefined;
	const respond = (statusCode, body) => res.status(statusCode).json(body);
	const withBootstrap = (body) => (bootstrap
		? Object.assign({}, body, {
			status: bootstrap.status,
			components: bootstrap.components,
			bootstrapReady: bootstrap.ready === true,
			// A bootstrap failure is the more specific root cause: keep it when
			// both failed so the probe failure does not mask it (#1296).
			errorCode: bootstrap.errorCode || body.errorCode || null,
		})
		: body);

	try {
		const report = await collectReadiness(overrides);
		const bootstrapReady = bootstrap ? bootstrap.ready === true : true;
		const ready = report.ready && bootstrapReady;
		respond(failClosed && !ready ? 503 : 200, withBootstrap({
			ready,
			failClosed,
			checkedAt: new Date(startedAt).toISOString(),
			latencyMs: Date.now() - startedAt,
			dependencies: projectDependenciesForPublic(report.dependencies),
		}));
	} catch (error) {
		console.error('[readiness] collect failed:', error && error.message ? error.message : error);
		respond(failClosed ? 503 : 200, withBootstrap({
			ready: false,
			failClosed,
			checkedAt: new Date(startedAt).toISOString(),
			latencyMs: Date.now() - startedAt,
			errorCode: 'READINESS_PROBE_FAILED',
		}));
	}
}

// Public `/ready` and `/healthcheck?depth=readiness` are unauthenticated:
// dependency error strings become stable machine codes; raw provider text
// (which can embed URLs, tokens, or Telegram descriptions) stays in logs (#1296).
const PUBLIC_ERROR_TOKEN_KEYWORDS = new Set([
	'timeout', 'http', 'not', 'missing', 'invalid', 'unavailable', 'unconfigured',
	'disabled', 'failed', 'unsupported', 'uninitialized', 'precondition', 'denied',
	'exhausted', 'circuit', 'auth', 'config', 'configured', 'key', 'model',
	'endpoint', 'firestore', 'gemini', 'binance', 'tradingview', 'telegram',
	'azure', 'openrouter', 'cloudflare', 'brave', 'search', 'gateway', 'provider',
	'quota', 'connection', 'ready', 'degraded', 'skipped', 'unsuccessful',
]);

function toPublicErrorCode(errorValue) {
	const text = typeof errorValue === 'string' ? errorValue.trim() : '';
	if (!text) {
		return null;
	}
	if (/getUpdates|terminated by other/i.test(text)) {
		return 'TELEGRAM_POLLING_CONFLICT';
	}
	// Timeout markers are emitted by the probe itself and contain no provider
	// text; pass them through verbatim.
	if (/^timeout_after_\d+ms$/i.test(text)) {
		return text;
	}
	// Only dependency-scoped tokens pass through verbatim. A bare word that is
	// not a known token (e.g. 'boom') is provider text and must not leak.
	if (/^[a-z0-9_]+$/i.test(text)
		&& text.toLowerCase().split('_').some((segment) => PUBLIC_ERROR_TOKEN_KEYWORDS.has(segment))) {
		return text;
	}
	return 'DEPENDENCY_PROBE_FAILED';
}

function projectDependenciesForPublic(dependencies) {
	const sanitized = {};
	for (const [name, dependency] of Object.entries(dependencies || {})) {
		if (!dependency || typeof dependency !== 'object') {
			sanitized[name] = dependency;
			continue;
		}
		const projected = { ...dependency };
		if (projected.error !== undefined) {
			delete projected.error;
		}
		const errorCode = toPublicErrorCode(dependency.error);
		if (errorCode) {
			projected.errorCode = errorCode;
		}
		sanitized[name] = projected;
	}
	return sanitized;
}

function attachReadinessOverrides(app, overrides) {
	if (!app || !app.locals) {
		return;
	}
	app.locals.readinessOverrides = overrides;
	resetReadinessService();
}

module.exports = {
	collectReadiness,
	handleDependencyReadiness,
	attachReadinessOverrides,
	getReadinessService,
	resetReadinessService,
	toPublicErrorCode,
	projectDependenciesForPublic,
};
