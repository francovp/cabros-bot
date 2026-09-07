'use strict';

const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../services/storage/firestoreConfig');
const {
	isAdminApiKeyScoped,
	isValidAdminApiKey,
	isValidBinanceTradingApiKey,
} = require('./auth');

const ADMIN_VIEWER = 'admin.viewer';
const ADMIN_OPERATOR = 'admin.operator';

function isFirebaseAdminAuthEnabled() {
	return process.env.ENABLE_FIREBASE_ADMIN_AUTH === 'true';
}

function getFirebaseAuth() {
	try {
		if (!admin.apps.length) {
			if (!isFirestoreConfigured()) return null;
			const options = {};
			if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
				options.credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
			}
			if (process.env.FIREBASE_PROJECT_ID) options.projectId = process.env.FIREBASE_PROJECT_ID;
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
		// Legacy path: when Firebase admin auth is disabled, accept the admin
		// key (or its webhook-key fallback) on admin routes. Webhook routes
		// still require the webhook key via the dedicated `validateApiKey`
		// middleware. When the operator has configured ADMIN_API_KEY, the
		// webhook key is no longer accepted on admin routes.
		return validateAdminApiKeyInternal(req, res, () => {
			req.adminRole = ADMIN_OPERATOR;
			next();
		});
	}

	const suppliedApiKey = req.headers['x-api-key'] || req.query['api-key'];
	if (suppliedApiKey !== undefined && isValidAdminApiKey(req)) {
		req.adminRole = ADMIN_OPERATOR;
		return next();
	}

	const authorization = req.headers.authorization;
	const match = typeof authorization === 'string' && authorization.match(/^Bearer\s+(\S+)$/i);
	if (match) {
		const firebaseAuth = getFirebaseAuth();
		if (!firebaseAuth) {
			return res.status(503).json({ error: 'Admin authentication is unavailable', code: 'ADMIN_AUTH_UNAVAILABLE' });
		}
		try {
			const claims = await firebaseAuth.verifyIdToken(match[1], true);
			req.adminRole = getAdminRole(claims);
			if (req.adminRole) return next();
			return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_ROLE_REQUIRED' });
		} catch (error) {
			return res.status(401).json({ error: 'Unauthorized', code: 'ADMIN_AUTH_INVALID' });
		}
	}

	if (suppliedApiKey !== undefined) {
		return res.status(403).json({ error: 'Forbidden: Invalid API key' });
	}

	return res.status(401).json({ error: 'Unauthorized', code: 'ADMIN_AUTH_REQUIRED' });
}

function requireConfiguredAdminAccess(req, res, next) {
	const firebaseEnabled = isFirebaseAdminAuthEnabled();
	const hasAdminKey = Boolean(String(process.env.ADMIN_API_KEY || '').trim())
		|| Boolean(String(process.env.WEBHOOK_API_KEY || '').trim());
	if (!firebaseEnabled && !hasAdminKey) {
		return res.status(503).json({
			error: 'Admin authentication is not configured',
			code: 'ADMIN_AUTH_UNAVAILABLE',
		});
	}
	return validateAdminAccess(req, res, next);
}

function requireAdminRole(requiredRole) {
	return (req, res, next) => {
		if (req.adminRole === ADMIN_OPERATOR || req.adminRole === requiredRole) return next();
		return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_ROLE_REQUIRED', requiredRole });
	};
}

/**
 * Express middleware: validate that the request carries the admin/operator
 * API key. The key is sourced from `ADMIN_API_KEY` when configured; when
 * unset, the legacy `WEBHOOK_API_KEY` is accepted so existing deployments
 * keep working until the operator opts in. Used in places that need an
 * admin-key check without the full Firebase bearer path (e.g. the legacy
 * `ENABLE_FIREBASE_ADMIN_AUTH=false` flow).
 */
function validateAdminApiKeyInternal(req, res, next) {
	if (isValidAdminApiKey(req)) return next();
	const supplied = req.headers['x-api-key'] || req.query['api-key'];
	if (supplied === undefined || supplied === '') {
		return res.status(401).json({ error: 'Unauthorized: Missing API key' });
	}
	return res.status(403).json({ error: 'Forbidden: Invalid API key' });
}

/**
 * Express middleware: validate that the request carries the Binance trading
 * API key (`BINANCE_TRADING_API_KEY`) independent of the admin/webhook keys.
 * Falls back to admin/operator authentication when the trading key is not
 * configured. Operators that configure both get full scope separation.
 */
function validateBinanceTradingAccess(req, res, next) {
	if (isValidBinanceTradingApiKey(req)) {
		req.adminRole = ADMIN_OPERATOR;
		return next();
	}
	if (String(process.env.BINANCE_TRADING_API_KEY || '').trim()) {
		// Trading key is configured and the supplied key did not match.
		// Reject this attempt rather than fall back to the admin key, so a
		// leaked webhook/admin key cannot execute trades.
		const supplied = req.headers['x-api-key'] || req.query['api-key'];
		if (supplied === undefined || supplied === '') {
			return res.status(401).json({ error: 'Unauthorized: Missing API key' });
		}
		return res.status(403).json({ error: 'Forbidden: Invalid API key' });
	}
	// No dedicated trading key configured: defer to admin auth (Firebase or
	// admin API key). This preserves the current "admin operator can trade"
	// contract for operators that have not yet provisioned BINANCE_TRADING_API_KEY.
	return validateAdminAccess(req, res, next);
}

function requireConfiguredBinanceTradingAccess(req, res, next) {
	const hasTradingKey = Boolean(String(process.env.BINANCE_TRADING_API_KEY || '').trim());
	if (hasTradingKey) {
		// Trading key is configured: it is the only acceptable credential on
		// the trading surface. Reject the request if the key is missing or
		// does not match. The 503 gate is unnecessary here because the
		// trading key itself is the configuration contract.
		return validateBinanceTradingAccess(req, res, next);
	}
	// No trading key: defer to the admin auth gate. The admin gate owns the
	// 503 ADMIN_AUTH_UNAVAILABLE response and its own configuration check,
	// so the trading route inherits the legacy behavior without duplicating
	// the gate.
	return requireConfiguredAdminAccess(req, res, next);
}

module.exports = {
	ADMIN_OPERATOR,
	ADMIN_VIEWER,
	getAdminAuthConfig,
	getAdminRole,
	getFirebaseWebConfig,
	isAdminApiKeyScoped,
	isFirebaseAdminAuthEnabled,
	requireAdminRole,
	requireConfiguredAdminAccess,
	requireConfiguredBinanceTradingAccess,
	validateAdminAccess,
	validateBinanceTradingAccess,
};
