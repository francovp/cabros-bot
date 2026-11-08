'use strict';

const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../services/storage/firestoreConfig');
const { loadFirebaseAdminCredentials } = require('../services/storage/firebaseAdminCredentials');
const {
	isAdminApiKeyScoped,
	isValidAdminApiKey,
	isValidBinanceTradingApiKey,
	_isQueryApiKeyPresent,
	_isQueryAuthSunsetReached,
	rejectQueryApiKeyAfterSunset,
	validateApiKey,
	warnQueryApiKeyDeprecationOnce,
} = require('./auth');
const requestDeadline = require('./requestDeadline');
const { sendErrorFrom } = require('./errorEnvelope');

const ADMIN_VIEWER = 'admin.viewer';
const ADMIN_OPERATOR = 'admin.operator';

/**
 * Observed admin-token-verification health (issue #1134).
 *
 * `ready` is NOT derived from credential shape. Doing so would repeat the
 * defect this repository already paid for three times (`firebaseRemoteConfig.ready`
 * #598, `equityMarketData.ready` #1116, Firestore `readHealth` #1285): shape is
 * not readiness. The only admissible evidence here is a `verifyIdToken()` call
 * that actually resolved, so `ready` stays false until a real sign-in has been
 * observed in this process.
 *
 * Only infrastructure outcomes are recorded: a resolved `verifyIdToken()`, or
 * the Firebase Admin SDK being unreachable (`ADMIN_AUTH_UNAVAILABLE`).
 *
 * A REJECTED token is never recorded. `verifyIdToken()` rejects an expired
 * token, a revoked token, a wrong-project token and a random `Bearer <garbage>`
 * string with the same indistinguishable rejection, so folding it into the
 * health signal would let any unauthenticated caller flip this dependency to
 * `degraded` with one request — a monitoring surface becomes a one-request DoS.
 * A rejected token is a client outcome, not a provider one.
 *
 * Counters are process-local and reset on restart, so `unverified` is the
 * normal state right after every deploy.
 */
const adminAuthReadiness = {
	verified: false,
	verificationSuccessCount: 0,
	verifierUnavailableCount: 0,
	consecutiveFailures: 0,
	lastSuccessAt: null,
	lastUnavailableAt: null,
};

const ADMIN_AUTH_OUTCOME = Object.freeze({
	SUCCESS: 'success',
	UNAVAILABLE: 'unavailable',
});

function recordAdminAuthReadiness(outcome) {
	// Telemetry must never reject an admin request.
	try {
		const now = new Date().toISOString();
		if (outcome === ADMIN_AUTH_OUTCOME.SUCCESS) {
			adminAuthReadiness.verified = true;
			adminAuthReadiness.verificationSuccessCount += 1;
			adminAuthReadiness.lastSuccessAt = now;
			adminAuthReadiness.consecutiveFailures = 0;
			return;
		}
		if (outcome === ADMIN_AUTH_OUTCOME.UNAVAILABLE) {
			adminAuthReadiness.verifierUnavailableCount += 1;
			adminAuthReadiness.lastUnavailableAt = now;
			adminAuthReadiness.consecutiveFailures += 1;
		}
	} catch (error) {
		// ignored on purpose
	}
}

function resetAdminAuthReadinessForTesting() {
	adminAuthReadiness.verified = false;
	adminAuthReadiness.verificationSuccessCount = 0;
	adminAuthReadiness.verifierUnavailableCount = 0;
	adminAuthReadiness.consecutiveFailures = 0;
	adminAuthReadiness.lastSuccessAt = null;
	adminAuthReadiness.lastUnavailableAt = null;
}

function isFirebaseAdminAuthEnabled() {
	return process.env.ENABLE_FIREBASE_ADMIN_AUTH === 'true';
}

/**
 * Credential *shape* only: whether `getFirebaseAuth()` could plausibly build a
 * Firebase Admin app. False is what surfaces as `ADMIN_AUTH_UNAVAILABLE`.
 */
function isAdminAuthVerifierConfigured() {
	try {
		if (Array.isArray(admin.apps) && admin.apps.length > 0) return true;
		return isFirestoreConfigured();
	} catch (error) {
		return false;
	}
}

function hasAdminAuthBrowserConfig() {
	const config = getFirebaseWebConfig();
	return Boolean(config.apiKey && config.authDomain && config.projectId);
}

/**
 * Non-sensitive readiness projection for `GET /api/status` /
 * `GET /api/capabilities`. Booleans and counters only: the Firebase Web config
 * itself is excluded because `/admin/auth-config` already serves exactly what
 * the browser needs.
 */
function getAdminAuthStatus() {
	const enabled = isFirebaseAdminAuthEnabled();
	const verifierConfigured = enabled && isAdminAuthVerifierConfigured();

	let status;
	if (!enabled) {
		status = 'disabled';
	} else if (!verifierConfigured) {
		status = 'misconfigured';
	} else if (adminAuthReadiness.consecutiveFailures > 0) {
		status = 'degraded';
	} else if (adminAuthReadiness.verified) {
		status = 'ready';
	} else {
		status = 'unverified';
	}

	return {
		enabled,
		provider: enabled ? 'firebase' : null,
		signIn: enabled ? 'email-password' : null,
		browserConfigConfigured: enabled && hasAdminAuthBrowserConfig(),
		verifierConfigured,
		apiKeyFallbackConfigured: Boolean(String(process.env.WEBHOOK_API_KEY || '').trim()),
		ready: status === 'ready',
		status,
		verificationSuccessCount: adminAuthReadiness.verificationSuccessCount,
		verifierUnavailableCount: adminAuthReadiness.verifierUnavailableCount,
		consecutiveFailures: adminAuthReadiness.consecutiveFailures,
		lastSuccessAt: adminAuthReadiness.lastSuccessAt,
		lastUnavailableAt: adminAuthReadiness.lastUnavailableAt,
	};
}

function getFirebaseAuth() {
	try {
		if (!admin.apps.length) {
			if (!isFirestoreConfigured()) return null;
			const loaded = loadFirebaseAdminCredentials();
			const options = {};
			if (loaded && loaded.credential) {
				options.credential = loaded.credential;
			}
			if (loaded && loaded.projectId) {
				options.projectId = loaded.projectId;
			}
			admin.initializeApp(options);
		}
		return typeof admin.auth === 'function' ? admin.auth() : null;
	} catch (error) {
		return null;
	}
}

function getAdminRole(claims = {}) {
	const roles = Array.isArray(claims.roles) ? claims.roles : [];
	if (
		claims[ADMIN_OPERATOR] === true
		|| claims.adminRole === ADMIN_OPERATOR
		|| claims.role === ADMIN_OPERATOR
		|| roles.includes(ADMIN_OPERATOR)
		|| claims.admin && claims.admin.operator === true
	) return ADMIN_OPERATOR;
	if (
		claims[ADMIN_VIEWER] === true
		|| claims.adminRole === ADMIN_VIEWER
		|| claims.role === ADMIN_VIEWER
		|| roles.includes(ADMIN_VIEWER)
		|| claims.admin && claims.admin.viewer === true
	) return ADMIN_VIEWER;
	return null;
}

function getFirebaseWebConfig() {
	let inlineConfig = {};
	if (process.env.FIREBASE_WEB_CONFIG_JSON) {
		try {
			const parsed = JSON.parse(process.env.FIREBASE_WEB_CONFIG_JSON);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inlineConfig = parsed;
		} catch (error) {
			inlineConfig = {};
		}
	}

	const config = {
		apiKey: inlineConfig.apiKey || process.env.FIREBASE_WEB_API_KEY,
		authDomain: inlineConfig.authDomain || process.env.FIREBASE_AUTH_DOMAIN,
		databaseURL: inlineConfig.databaseURL || process.env.FIREBASE_DATABASE_URL,
		projectId: inlineConfig.projectId || process.env.FIREBASE_PROJECT_ID,
		appId: inlineConfig.appId || process.env.FIREBASE_APP_ID,
		storageBucket: inlineConfig.storageBucket || process.env.FIREBASE_STORAGE_BUCKET,
		messagingSenderId: inlineConfig.messagingSenderId || process.env.FIREBASE_MESSAGING_SENDER_ID,
		measurementId: inlineConfig.measurementId || process.env.FIREBASE_MEASUREMENT_ID,
	};
	return Object.fromEntries(Object.entries(config).filter(([, value]) => typeof value === 'string' && value.trim()));
}

function getAdminAuthConfig() {
	if (!isFirebaseAdminAuthEnabled()) return { enabled: false, configured: false };

	const config = getFirebaseWebConfig();
	return {
		enabled: true,
		configured: Boolean(config.apiKey && config.authDomain && config.projectId),
		provider: 'firebase',
		signIn: 'email-password',
		...(config.apiKey && config.authDomain && config.projectId ? { config } : {}),
	};
}

async function validateAdminAccess(req, res, next) {
	if (!isFirebaseAdminAuthEnabled()) {
		if (!isAdminApiKeyScoped()) {
			return validateApiKey(req, res, () => {
				req.adminRole = ADMIN_OPERATOR;
				return requestDeadline.guard(req, res, next);
			});
		}

		const suppliedApiKey = req.headers['x-api-key']
			|| (isAdminApiKeyScoped() ? undefined : req.query['api-key']);
		if (suppliedApiKey !== undefined && isValidAdminApiKey(req)) {
			req.adminRole = ADMIN_OPERATOR;
			return requestDeadline.guard(req, res, next);
		}
		if (suppliedApiKey !== undefined) {
			return sendErrorFrom(res, 403, { error: 'Forbidden: Invalid API key' });
		}
		return sendErrorFrom(res, 401, { error: 'Unauthorized: Missing API key' });
	}
	const expiredLegacyQueryKey = !isAdminApiKeyScoped()
		&& process.env.WEBHOOK_API_KEY
		&& _isQueryApiKeyPresent(req)
		&& _isQueryAuthSunsetReached();
	const hasApiKeyHeader = Boolean(req.headers['x-api-key']);
	const hasBearerHeader = typeof req.headers.authorization === 'string'
		&& /^Bearer\s+\S+$/i.test(req.headers.authorization);
	if (
		!isAdminApiKeyScoped()
		&& process.env.WEBHOOK_API_KEY
		&& expiredLegacyQueryKey
		&& !hasApiKeyHeader
		&& !hasBearerHeader
		&& rejectQueryApiKeyAfterSunset(req, res)
	) {
		return;
	}

	const suppliedApiKey = req.headers['x-api-key']
		|| (isAdminApiKeyScoped() || expiredLegacyQueryKey ? undefined : req.query['api-key']);
	if (suppliedApiKey !== undefined && isValidAdminApiKey(req)) {
		if (!isAdminApiKeyScoped() && !expiredLegacyQueryKey && _isQueryApiKeyPresent(req)) {
			warnQueryApiKeyDeprecationOnce(req);
		}
		req.adminRole = ADMIN_OPERATOR;
		return requestDeadline.guard(req, res, next);
	}

	const authorization = req.headers.authorization;
	const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(\S+)$/i);
	if (match) {
		const firebaseAuth = getFirebaseAuth();
		if (!firebaseAuth) {
			recordAdminAuthReadiness(ADMIN_AUTH_OUTCOME.UNAVAILABLE);
			return sendErrorFrom(res, 503, { error: 'Admin authentication is unavailable', code: 'ADMIN_AUTH_UNAVAILABLE' });
		}
		try {
			const claims = await firebaseAuth.verifyIdToken(match[1], true);
			recordAdminAuthReadiness(ADMIN_AUTH_OUTCOME.SUCCESS);
			req.adminRole = getAdminRole(claims);
			req.adminUser = {
				uid: claims.uid || claims.sub || null,
				email: claims.email || null,
				claims,
			};
			req.user = req.adminUser;
			if (req.adminRole) return requestDeadline.guard(req, res, next);
			return sendErrorFrom(res, 403, { error: 'Forbidden', code: 'ADMIN_ROLE_REQUIRED' });
		} catch (error) {
			return sendErrorFrom(res, 401, { error: 'Unauthorized', code: 'ADMIN_AUTH_INVALID' });
		}
	}

	if (suppliedApiKey !== undefined) {
		return sendErrorFrom(res, 403, { error: 'Forbidden: Invalid API key' });
	}

	return sendErrorFrom(res, 401, { error: 'Unauthorized', code: 'ADMIN_AUTH_REQUIRED' });
}

function requireConfiguredAdminAccess(req, res, next) {
	if (
		!isFirebaseAdminAuthEnabled()
		&& !String(process.env.ADMIN_API_KEY || '').trim()
		&& !String(process.env.WEBHOOK_API_KEY || '').trim()
	) {
		return sendErrorFrom(res, 503, {
			error: 'Admin authentication is not configured',
			code: 'ADMIN_AUTH_UNAVAILABLE',
		});
	}
	return validateAdminAccess(req, res, next);
}

function validateBinanceTradingAccess(req, res, next) {
	const tradingKey = String(process.env.BINANCE_TRADING_API_KEY || '').trim();
	if (!tradingKey) return validateAdminAccess(req, res, next);

	const suppliedApiKey = req.headers['x-api-key'];
	if (suppliedApiKey !== undefined && isValidBinanceTradingApiKey(req)) {
		req.adminRole = ADMIN_OPERATOR;
		return requestDeadline.guard(req, res, next);
	}
	if (suppliedApiKey === undefined || suppliedApiKey === '') {
		return sendErrorFrom(res, 401, { error: 'Unauthorized: Missing API key' });
	}
	return sendErrorFrom(res, 403, { error: 'Forbidden: Invalid API key' });
}

function requireConfiguredBinanceTradingAccess(req, res, next) {
	if (String(process.env.BINANCE_TRADING_API_KEY || '').trim()) {
		return validateBinanceTradingAccess(req, res, next);
	}
	return requireConfiguredAdminAccess(req, res, next);
}

function requireConfiguredSseAccess(req, res, next) {
	if (!req.headers.authorization && req.query?.token) {
		req.headers.authorization = `Bearer ${req.query.token}`;
	}
	return requireConfiguredAdminAccess(req, res, next);
}

function requireAdminRole(requiredRole) {
	return (req, res, next) => {
		if (req.adminRole === ADMIN_OPERATOR || req.adminRole === requiredRole) return next();
		return sendErrorFrom(res, 403, { error: 'Forbidden', code: 'ADMIN_ROLE_REQUIRED', requiredRole });
	};
}

module.exports = {
	ADMIN_OPERATOR,
	ADMIN_VIEWER,
	getAdminAuthConfig,
	getAdminAuthStatus,
	getAdminRole,
	getFirebaseWebConfig,
	isAdminAuthVerifierConfigured,
	isFirebaseAdminAuthEnabled,
	recordAdminAuthReadiness,
	requireAdminRole,
	requireConfiguredAdminAccess,
	requireConfiguredBinanceTradingAccess,
	requireConfiguredSseAccess,
	resetAdminAuthReadinessForTesting,
	validateAdminAccess,
	validateBinanceTradingAccess,
};
