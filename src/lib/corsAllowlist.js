// src/lib/corsAllowlist.js

const DEFAULT_CORS_ALLOWED_ORIGINS = Object.freeze([
	'https://cabros-bot.web.app',
	'https://cabros-bot.firebaseapp.com',
	'https://cabros-bot-production.up.railway.app',
]);

const ALLOWED_ORIGIN_SCHEMES = Object.freeze(['http:', 'https:']);
const WILDCARD_ORIGIN = '*';

/**
 * Normalizes an origin string into a canonical origin (scheme + lowercase hostname + optional non-default port).
 * Returns null if the URL is invalid or uses a disallowed scheme.
 *
 * @param {string} raw
 * @returns {string|null} Canonical origin string or null
 */
function normalizeHttpOrigin(raw) {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (!ALLOWED_ORIGIN_SCHEMES.includes(url.protocol)) {
			return null;
		}
		return url.origin;
	} catch (_err) {
		return null;
	}
}

/**
 * Validates whether an origin matches the Firebase Hosting ephemeral preview
 * channel pattern for this project (e.g. https://cabros-bot--pr900-xyz.web.app).
 *
 * @param {string} origin Normalized origin string
 * @param {string} [projectId=process.env.FIREBASE_PROJECT_ID || 'cabros-bot']
 * @returns {boolean}
 */
function isFirebasePreviewOrigin(origin, projectId = process.env.FIREBASE_PROJECT_ID || 'cabros-bot') {
	if (typeof origin !== 'string' || !origin.startsWith('https://')) {
		return false;
	}
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== 'https:' || parsed.port) {
			return false;
		}
		const hostname = parsed.hostname.toLowerCase();
		const escapedProject = (projectId || 'cabros-bot').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(`^${escapedProject}--[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(web\\.app|firebaseapp\\.com)$`);
		return pattern.test(hostname);
	} catch (_err) {
		return false;
	}
}

/**
 * Parses CORS_ALLOWED_ORIGINS into a fresh Set of normalized exact origin strings.
 *
 * Accepts:
 * - `undefined`/empty → the documented default allowlist (marked as default).
 * - `*` (sole token) → wildcard (documented opt-in for local testing).
 * - Comma-separated origins → REPLACES the defaults with this normalized list.
 * - Anything that is not an http(s) URL or the wildcard → rejected.
 *
 * When the operator sets `CORS_ALLOWED_ORIGINS`, it is treated as the
 * authoritative allowlist — defaults are NOT silently merged — so a
 * deployment that explicitly opts out of a default origin cannot be
 * surprised by a leftover entry.
 *
 * @param {string|undefined} rawEnv Value of process.env.CORS_ALLOWED_ORIGINS
 * @returns {Set<string>} Unique normalized origins suitable for an exact-match allowlist
 */
function parseCorsAllowedOrigins(rawEnv) {
	if (typeof rawEnv !== 'string') {
		const defaults = new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
		defaults.isDefault = true;
		return defaults;
	}

	const trimmedEnv = rawEnv.trim();
	if (trimmedEnv === '') {
		const defaults = new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
		defaults.isDefault = true;
		return defaults;
	}

	const parts = trimmedEnv
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length === 0) {
		const defaults = new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
		defaults.isDefault = true;
		return defaults;
	}

	const allWildcard = parts.every((part) => part === WILDCARD_ORIGIN);
	if (allWildcard) {
		const wildcardSet = new Set([WILDCARD_ORIGIN]);
		wildcardSet.isDefault = false;
		return wildcardSet;
	}

	if (parts.includes(WILDCARD_ORIGIN)) {
		// Mixed wildcard + explicit origins is ambiguous; refuse silently and fallback to defaults.
		const defaults = new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
		defaults.isDefault = true;
		return defaults;
	}

	const origins = new Set();
	for (const part of parts) {
		const normalized = normalizeHttpOrigin(part);
		if (normalized) {
			origins.add(normalized);
		}
	}

	if (origins.size === 0) {
		const defaults = new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
		defaults.isDefault = true;
		return defaults;
	}

	origins.isDefault = false;
	return origins;
}

/**
 * Checks if a given request origin is allowed by the allowlist or preview matching.
 *
 * @param {string} requestOrigin
 * @param {Set<string>} allowList
 * @param {object} [options={}]
 * @returns {boolean}
 */
function isAllowedOrigin(requestOrigin, allowList, options = {}) {
	if (!requestOrigin) return false;
	if (allowList.has(WILDCARD_ORIGIN)) return true;

	const normalized = normalizeHttpOrigin(requestOrigin);
	if (!normalized) return false;

	if (allowList.has(normalized)) return true;

	const allowPreviews = options.allowFirebasePreviews ?? allowList.isDefault ?? false;
	if (allowPreviews) {
		const projectId = options.firebaseProjectId || process.env.FIREBASE_PROJECT_ID || 'cabros-bot';
		if (isFirebasePreviewOrigin(normalized, projectId)) {
			return true;
		}
	}

	return false;
}

/**
 * Builds an Express middleware that reflects `Access-Control-Allow-Origin`
 * only when the incoming `Origin` header matches one of the allowed origins
 * or documented project preview channels.
 *
 * Behavior:
 * - Requests without an `Origin` header (curl, server-to-server, same-origin)
 *   pass through unchanged — preserves every non-browser consumer.
 * - Allowed origins get the matching header and a `Vary: Origin` response.
 * - Disallowed browser origins get no `Access-Control-Allow-Origin` header
 *   (the browser blocks the response).
 * - Credentials remain disabled — the console uses header-based keys/tokens.
 *
 * @param {Set<string>} allowedOrigins Pre-parsed allowlist (see parseCorsAllowedOrigins)
 * @param {object} [options={}]
 * @returns {import('express').RequestHandler}
 */
function buildCorsMiddleware(allowedOrigins, options = {}) {
	const allowList = allowedOrigins instanceof Set
		? allowedOrigins
		: parseCorsAllowedOrigins(undefined);

	return (req, res, next) => {
		const requestOrigin = req.headers && req.headers.origin;

		if (!requestOrigin) {
			return next();
		}

		res.setHeader('Vary', 'Origin');

		if (isAllowedOrigin(requestOrigin, allowList, options)) {
			if (allowList.has(WILDCARD_ORIGIN)) {
				res.setHeader('Access-Control-Allow-Origin', WILDCARD_ORIGIN);
			} else {
				res.setHeader('Access-Control-Allow-Origin', requestOrigin);
			}
		} else {
			return next();
		}

		if (req.method === 'OPTIONS') {
			const requestedMethod = req.headers['access-control-request-method'];
			if (requestedMethod) {
				res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
			}
			const requestedHeaders = req.headers['access-control-request-headers'];
			if (requestedHeaders) {
				res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
			}
			res.setHeader('Access-Control-Max-Age', '600');
			res.status(204).end();
			return undefined;
		}

		return next();
	};
}

/**
 * Convenience helper that wires the allowlist middleware using the current
 * process environment. Mirrors the pattern in src/lib/trustProxy.js.
 *
 * @param {import('express').Express} app Express application instance
 * @param {object} [env=process.env] Environment variables map
 */
function setupCorsAllowlist(app, env = process.env) {
	const origins = parseCorsAllowedOrigins(env && env.CORS_ALLOWED_ORIGINS);
	app.use(buildCorsMiddleware(origins));
}

module.exports = {
	DEFAULT_CORS_ALLOWED_ORIGINS,
	normalizeHttpOrigin,
	isFirebasePreviewOrigin,
	isAllowedOrigin,
	parseCorsAllowedOrigins,
	buildCorsMiddleware,
	setupCorsAllowlist,
};