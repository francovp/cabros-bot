'use strict';

const cors = require('cors');

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
	'https://cabros-bot.web.app',
	'https://cabros-bot.firebaseapp.com',
	'https://cabros-bot-production.up.railway.app',
]);

const LOCALHOST_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const FIREBASE_PREVIEW_REGEX = /^https:\/\/cabros-bot(--[a-z0-9-]+)?\.(web\.app|firebaseapp\.com)$/i;

/**
 * Parses comma-separated origin strings into an array of trimmed origin strings.
 *
 * @param {string|undefined|null} corsAllowedOriginsEnv
 * @returns {string[]}
 */
function parseAllowedOrigins(corsAllowedOriginsEnv) {
	if (!corsAllowedOriginsEnv || typeof corsAllowedOriginsEnv !== 'string') {
		return [];
	}
	return corsAllowedOriginsEnv
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Determines whether a given request origin is allowed by the CORS policy.
 *
 * @param {string|undefined|null} origin Request origin header value
 * @param {object} [env=process.env] Environment variables object
 * @returns {boolean}
 */
function isOriginAllowed(origin, env = process.env) {
	// Allow server-to-server requests, curl, or same-origin requests without an Origin header
	if (!origin || typeof origin !== 'string') {
		return true;
	}

	const normalizedOrigin = origin.trim();
	if (!normalizedOrigin) {
		return true;
	}

	// Check fixed default allowed origins
	if (DEFAULT_ALLOWED_ORIGINS.includes(normalizedOrigin)) {
		return true;
	}

	// Check custom origins configured via CORS_ALLOWED_ORIGINS
	const customAllowedOrigins = parseAllowedOrigins(env && env.CORS_ALLOWED_ORIGINS);
	if (customAllowedOrigins.includes(normalizedOrigin)) {
		return true;
	}

	// Check localhost / loopback for local development
	if (LOCALHOST_REGEX.test(normalizedOrigin)) {
		return true;
	}

	// Check Firebase Hosting project subdomains and preview channels
	if (FIREBASE_PREVIEW_REGEX.test(normalizedOrigin)) {
		return true;
	}

	return false;
}

/**
 * Creates standard CORS middleware configuration options.
 *
 * @param {object} [env=process.env] Environment variables object
 * @returns {import('cors').CorsOptions}
 */
function createCorsOptions(env = process.env) {
	return {
		origin: (origin, callback) => {
			if (isOriginAllowed(origin, env)) {
				return callback(null, true);
			}
			return callback(null, false);
		},
		credentials: true,
		methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
		allowedHeaders: [
			'Content-Type',
			'Authorization',
			'x-api-key',
			'X-API-Key',
			'x-request-id',
			'api-key',
		],
		maxAge: 86400,
	};
}

/**
 * Creates configured Express CORS middleware.
 *
 * @param {object} [env=process.env] Environment variables object
 * @returns {import('express').RequestHandler}
 */
function createCorsMiddleware(env = process.env) {
	return cors(createCorsOptions(env));
}

module.exports = {
	DEFAULT_ALLOWED_ORIGINS,
	parseAllowedOrigins,
	isOriginAllowed,
	createCorsOptions,
	createCorsMiddleware,
};
