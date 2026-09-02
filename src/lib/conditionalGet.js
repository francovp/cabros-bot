'use strict';

const crypto = require('crypto');

const MAX_ETAG_BODY_BYTES = 100 * 1024;

const CONDITIONAL_GET_FLAG = Symbol.for('cabros-bot.conditionalGet.applied');

const stats = {
	enabled: false,
	etagHits: 0,
	etagMisses: 0,
	bodyBytesSaved: 0,
	shortCircuitedResponses: 0,
	shortCircuitErrors: 0,
	lastResetAt: null,
};

const disabledEtagApps = new WeakSet();

function resetForTesting() {
	stats.enabled = false;
	stats.etagHits = 0;
	stats.etagMisses = 0;
	stats.bodyBytesSaved = 0;
	stats.shortCircuitedResponses = 0;
	stats.shortCircuitErrors = 0;
	stats.lastResetAt = null;
}

function isEnabled() {
	if (process.env.NODE_ENV === 'test') {
		return process.env.ENABLE_HTTP_CONDITIONAL_GET !== 'false';
	}
	try {
		const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');
		const runtimeConfig = remoteConfigService.getRuntimeConfig();
		if (typeof runtimeConfig.ENABLE_HTTP_CONDITIONAL_GET === 'boolean') {
			return runtimeConfig.ENABLE_HTTP_CONDITIONAL_GET;
		}
	} catch (error) {
		// Remote config not available; fall back to env.
	}
	return process.env.ENABLE_HTTP_CONDITIONAL_GET !== 'false';
}

function computeEtag(body) {
	const hash = crypto.createHash('sha1').update(body).digest('base64');
	return `W/"${hash}"`;
}

function etagFor({ updatedAt, count, version }) {
	if (updatedAt === null || updatedAt === undefined) {
		return null;
	}
	const normalized = typeof updatedAt === 'string' || typeof updatedAt === 'number'
		? String(updatedAt)
		: (updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt));
	const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	const safeVersion = Number.isFinite(version) ? Math.max(0, Math.floor(version)) : 0;
	const raw = `${normalized}|${safeCount}|${safeVersion}`;
	const hash = crypto.createHash('sha1').update(raw).digest('base64');
	return `W/"${hash}"`;
}

function buildCacheControl({ maxAge = 0, mustRevalidate = true } = {}) {
	const parts = ['private', `max-age=${Math.max(0, Math.floor(maxAge))}`];
	if (mustRevalidate) {
		parts.push('must-revalidate');
	}
	return parts.join(', ');
}

function parseIfNoneMatch(header) {
	if (!header) return [];
	return String(header)
		.split(',')
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function ifNoneMatchMatches(headerValue, etag) {
	if (!headerValue || !etag) return false;
	const candidates = parseIfNoneMatch(headerValue);
	if (candidates.includes('*')) return true;
	return candidates.some((candidate) => candidate === etag || candidate === `W/${etag}` || candidate === etag.replace(/^W\//, ''));
}

function snapshotStats() {
	return {
		enabled: isEnabled(),
		etagHits: stats.etagHits,
		etagMisses: stats.etagMisses,
		bodyBytesSaved: stats.bodyBytesSaved,
		shortCircuitedResponses: stats.shortCircuitedResponses,
		shortCircuitErrors: stats.shortCircuitErrors,
		lastResetAt: stats.lastResetAt,
	};
}

function disableAppEtag(res) {
	const app = res.app;
	if (!app || typeof app.set !== 'function') return;
	if (disabledEtagApps.has(app)) return;
	try {
		if (app.get('etag') !== false) {
			app.set('etag', false);
		}
		disabledEtagApps.add(app);
	} catch (error) {
		// Best effort: leaving Express's default weak ETag in place is acceptable
		// when the application cannot mutate the ETag setting (e.g. a router-only
		// test harness without an owning app).
	}
}

function withConditionalGet(handler, options = {}) {
	const maxAge = Number.isFinite(options.maxAge) ? options.maxAge : 0;
	const cacheControl = options.cacheControl || buildCacheControl({ maxAge });

	function shortCircuitTo304(res, etag, serialized) {
		stats.etagHits += 1;
		stats.bodyBytesSaved += Buffer.byteLength(serialized, 'utf8');
		stats.shortCircuitedResponses += 1;
		res.setHeader('ETag', etag);
		res.setHeader('Cache-Control', cacheControl);
		res.setHeader('X-Conditional-Get', 'hit');
		return res.status(304).end();
	}

	function applyEtag(req, res, body) {
		if (body === undefined || body === null) {
			return false;
		}
		const serialized = typeof body === 'string' ? body : JSON.stringify(body);
		if (typeof serialized !== 'string' || serialized.length === 0) {
			stats.etagMisses += 1;
			return false;
		}
		if (serialized.length > MAX_ETAG_BODY_BYTES) {
			stats.etagMisses += 1;
			return false;
		}
		// Respect a handler-set ETag (e.g. scanner-presets version-based
		// optimistic concurrency) by skipping our deterministic SHA-1 weak
		// validator for this response. The Cache-Control header is still
		// applied so conditional GET clients get a coherent cache directive.
		const presetEtag = res.getHeader && res.getHeader('ETag');
		if (presetEtag && typeof presetEtag === 'string' && presetEtag.length > 0) {
			res.setHeader('Cache-Control', cacheControl);
			stats.etagMisses += 1;
			res.setHeader('X-Conditional-Get', 'pass-through');
			return false;
		}
		const etag = computeEtag(serialized);
		res.setHeader('ETag', etag);
		res.setHeader('Cache-Control', cacheControl);
		if (ifNoneMatchMatches(req.headers['if-none-match'], etag)) {
			shortCircuitTo304(res, etag, serialized);
			return true;
		}
		stats.etagMisses += 1;
		res.setHeader('X-Conditional-Get', 'miss');
		return false;
	}

	return async function conditionalGetMiddleware(req, res, next) {
		// Disable Express's default weak-validator ETag generation on the owning
		// app so the conditional GET semantics are owned entirely by this
		// middleware. Without this, Express appends its own `W/"<body-size>-..."`
		// ETag, which would conflict with the SHA-1 weak ETag we emit (and
		// leak through when the gate is disabled).
		disableAppEtag(res);
		if (req.method !== 'GET') {
			return handler(req, res, next);
		}
		if (!isEnabled()) {
			return handler(req, res, next);
		}

		const originalJson = res.json.bind(res);
		const originalSend = res.send.bind(res);

		let statusCode = 200;
		const originalStatus = res.status.bind(res);
		res.status = function patchedStatus(code) {
			statusCode = code;
			return originalStatus(code);
		};

		// Track whether applyEtag already ran for this response. Express's
		// res.json() internally calls res.send() — without this guard, our
		// patched res.send would see the ETag we just set and treat it as a
		// "preset" ETag from the handler, suppressing a second evaluation.
		// Stash the flag on the response object itself so each new request
		// gets a fresh middleware invocation state.
		res[CONDITIONAL_GET_FLAG] = false;

		res.json = function patchedJson(body) {
			if (statusCode >= 200 && statusCode < 300 && !res[CONDITIONAL_GET_FLAG]) {
				try {
					const shortCircuited = applyEtag(req, res, body);
					res[CONDITIONAL_GET_FLAG] = true;
					if (shortCircuited) {
						return res;
					}
				} catch (error) {
					stats.shortCircuitErrors += 1;
					if (process.env.NODE_ENV !== 'test') {
						console.warn('[conditionalGet] ETag computation failed', error.message);
					}
				}
			}
			return originalJson(body);
		};

		res.send = function patchedSend(body) {
			if (statusCode >= 200 && statusCode < 300 && !res[CONDITIONAL_GET_FLAG]) {
				try {
					const shortCircuited = applyEtag(req, res, body);
					res[CONDITIONAL_GET_FLAG] = true;
					if (shortCircuited) {
						return res;
					}
				} catch (error) {
					stats.shortCircuitErrors += 1;
					if (process.env.NODE_ENV !== 'test') {
						console.warn('[conditionalGet] ETag computation failed', error.message);
					}
				}
			}
			return originalSend(body);
		};

		stats.enabled = true;
		if (stats.lastResetAt === null) {
			stats.lastResetAt = new Date().toISOString();
		}

		try {
			return await handler(req, res, next);
		} catch (error) {
			return next(error);
		}
	};
}

module.exports = {
	withConditionalGet,
	etagFor,
	computeEtag,
	buildCacheControl,
	parseIfNoneMatch,
	ifNoneMatchMatches,
	snapshotStats,
	resetForTesting,
	isEnabled,
	MAX_ETAG_BODY_BYTES,
};
