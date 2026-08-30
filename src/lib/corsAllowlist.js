// src/lib/corsAllowlist.js

const DEFAULT_CORS_ALLOWED_ORIGINS = Object.freeze([
	'https://cabros-bot.web.app',
	'https://cabros-bot.firebaseapp.com',
	'https://cabros-bot-production.up.railway.app',
]);

const ALLOWED_ORIGIN_SCHEMES = Object.freeze(['http:', 'https:']);
const WILDCARD_ORIGIN = '*';

function isExactHttpOrigin(trimmed) {
	try {
		const url = new URL(trimmed);
		return ALLOWED_ORIGIN_SCHEMES.includes(url.protocol);
	} catch (_err) {
		return false;
	}
}

/**
 * Parses CORS_ALLOWED_ORIGINS into a fresh Set of exact origin strings.
 *
 * Accepts:
 * - `undefined`/empty → the documented default allowlist.
 * - `*` (sole token) → wildcard (documented opt-in for local testing).
 * - Comma-separated origins → REPLACES the defaults with this exact list.
 * - Anything that is not an http(s) URL or the wildcard → rejected.
 *
 * When the operator sets `CORS_ALLOWED_ORIGINS`, it is treated as the
 * authoritative allowlist — defaults are NOT silently merged — so a
 * deployment that explicitly opts out of a default origin cannot be
 * surprised by a leftover entry.
 *
 * @param {string|undefined} rawEnv Value of process.env.CORS_ALLOWED_ORIGINS
 * @returns {Set<string>} Unique origins suitable for an exact-match allowlist
 */
function parseCorsAllowedOrigins(rawEnv) {
	if (typeof rawEnv !== 'string') {
		return new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
	}

	const trimmedEnv = rawEnv.trim();
	if (trimmedEnv === '') {
		return new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
	}

	const parts = trimmedEnv
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length === 0) {
		return new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
	}

	const allWildcard = parts.every((part) => part === WILDCARD_ORIGIN);
	if (allWildcard) {
		return new Set([WILDCARD_ORIGIN]);
	}

	if (parts.includes(WILDCARD_ORIGIN)) {
		// Mixed wildcard + explicit origins is ambiguous; refuse silently.
		return new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
	}

	const origins = new Set();
	for (const part of parts) {
		if (isExactHttpOrigin(part)) {
			origins.add(part);
		}
	}

	if (origins.size === 0) {
		return new Set(DEFAULT_CORS_ALLOWED_ORIGINS);
	}

	return origins;
}

/**
 * Builds an Express middleware that reflects `Access-Control-Allow-Origin`
 * only when the incoming `Origin` header matches one of the allowed origins.
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
 * @returns {import('express').RequestHandler}
 */
function buildCorsMiddleware(allowedOrigins) {
	const allowList = allowedOrigins instanceof Set
		? allowedOrigins
		: parseCorsAllowedOrigins(undefined);

	return (req, res, next) => {
		const requestOrigin = req.headers && req.headers.origin;

		if (!requestOrigin) {
			return next();
		}

		res.setHeader('Vary', 'Origin');

		if (allowList.has(WILDCARD_ORIGIN)) {
			res.setHeader('Access-Control-Allow-Origin', WILDCARD_ORIGIN);
		} else if (allowList.has(requestOrigin)) {
			res.setHeader('Access-Control-Allow-Origin', requestOrigin);
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
	parseCorsAllowedOrigins,
	buildCorsMiddleware,
	setupCorsAllowlist,
};