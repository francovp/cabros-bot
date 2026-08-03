'use strict';

const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const alertStorageService = require('../storage/AlertStorageService');

const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LOAD_TIMEOUT_MS = 10 * 1000;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_LOAD_TIMEOUT_MS = 30 * 1000;
const MAX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const PARAMETER_SCHEMA = Object.freeze({
	NEWS_ALERT_THRESHOLD: { type: 'number', defaultValue: 0.7, min: 0, max: 1 },
	NEWS_TIMEOUT_MS: { type: 'number', defaultValue: 60000, integer: true, min: 1000, max: 120000 },
	NEWS_GEMINI_CONCURRENCY: { type: 'number', defaultValue: Infinity, integer: true, min: 1, max: 50 },
	NEWS_GEMINI_QUOTA_MAX_RETRIES: { type: 'number', defaultValue: 2, integer: true, min: 1, max: 5 },
	NEWS_GEMINI_QUOTA_RETRY_BASE_MS: { type: 'number', defaultValue: 1000, integer: true, min: 1, max: 60000 },
	TRADINGVIEW_MCP_TIMEOUT_MS: { type: 'number', defaultValue: 12000, integer: true, min: 1000, max: 120000 },
	TRADINGVIEW_MCP_MAX_RETRIES: { type: 'number', defaultValue: 3, integer: true, min: 1, max: 5 },
	TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS: { type: 'number', defaultValue: 12000, integer: true, min: 1000, max: 120000 },
	ENABLE_MESSAGE_FOOTER_METADATA: { type: 'boolean', defaultValue: true },
});

let remoteOverrides = {};
let remoteLoadedAt = null;
let templateVersion = null;
let lastSuccessfulLoad = null;
let lastErrorCategory = null;
let refreshTimer = null;
let loadingPromise = null;

function isEnabled() {
	return process.env.ENABLE_FIREBASE_REMOTE_CONFIG === 'true';
}

function parseBoundedNumber(value, schema, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	const parsed = typeof value === 'number' ? value : Number(String(value).trim());
	if (!Number.isFinite(parsed) || (schema.integer && !Number.isSafeInteger(parsed))) {
		return fallback;
	}
	if (parsed < schema.min || parsed > schema.max) {
		return fallback;
	}
	return parsed;
}

function parseBoolean(value, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	if (value === true || value === false) {
		return value;
	}
	if (value === 'true' || value === 'false') {
		return value === 'true';
	}
	return fallback;
}

function parseValue(value, schema, fallback) {
	return schema.type === 'boolean'
		? parseBoolean(value, fallback)
		: parseBoundedNumber(value, schema, fallback);
}

function getEnvironmentConfig() {
	const parseLegacyPositiveInteger = (value, fallback) => {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	};

	return {
		NEWS_ALERT_THRESHOLD: Number.parseFloat(process.env.NEWS_ALERT_THRESHOLD || 0.7),
		NEWS_TIMEOUT_MS: Number.parseInt(process.env.NEWS_TIMEOUT_MS || 60000, 10),
		NEWS_GEMINI_CONCURRENCY: parseLegacyPositiveInteger(process.env.NEWS_GEMINI_CONCURRENCY, Infinity),
		NEWS_GEMINI_QUOTA_MAX_RETRIES: parseLegacyPositiveInteger(process.env.NEWS_GEMINI_QUOTA_MAX_RETRIES, 2),
		NEWS_GEMINI_QUOTA_RETRY_BASE_MS: parseLegacyPositiveInteger(process.env.NEWS_GEMINI_QUOTA_RETRY_BASE_MS, 1000),
		TRADINGVIEW_MCP_TIMEOUT_MS: Number.parseInt(process.env.TRADINGVIEW_MCP_TIMEOUT_MS || 12000, 10),
		TRADINGVIEW_MCP_MAX_RETRIES: Number.parseInt(process.env.TRADINGVIEW_MCP_MAX_RETRIES || 3, 10),
		TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS: Number.parseInt(process.env.TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS || 12000, 10),
		ENABLE_MESSAGE_FOOTER_METADATA: process.env.ENABLE_MESSAGE_FOOTER_METADATA !== 'false',
	};
}

function buildDefaultConfig() {
	return Object.entries(PARAMETER_SCHEMA).reduce((config, [key, schema]) => {
		const value = process.env[key] === undefined
			? schema.defaultValue
			: parseValue(process.env[key], schema, schema.defaultValue);
		if (value !== Infinity) {
			config[key] = String(value);
		}
		return config;
	}, {});
}

function getLoaderOption(name, fallback, max) {
	const raw = process.env[name];
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		return fallback;
	}
	return Math.min(parsed, max);
}

function getRefreshIntervalMs() {
	return getLoaderOption('FIREBASE_REMOTE_CONFIG_REFRESH_INTERVAL_MS', DEFAULT_REFRESH_INTERVAL_MS, MAX_REFRESH_INTERVAL_MS);
}

function getLoadTimeoutMs() {
	return getLoaderOption('FIREBASE_REMOTE_CONFIG_LOAD_TIMEOUT_MS', DEFAULT_LOAD_TIMEOUT_MS, MAX_LOAD_TIMEOUT_MS);
}

function getMaxAgeMs() {
	return getLoaderOption('FIREBASE_REMOTE_CONFIG_MAX_AGE_MS', DEFAULT_MAX_AGE_MS, MAX_MAX_AGE_MS);
}

function hasFreshRemoteConfig() {
	return remoteLoadedAt !== null && Date.now() - remoteLoadedAt <= getMaxAgeMs();
}

function getRuntimeConfig() {
	const config = getEnvironmentConfig();
	if (isEnabled() && hasFreshRemoteConfig()) {
		Object.assign(config, remoteOverrides);
	}
	return config;
}

function getSource() {
	if (!isEnabled()) {
		return 'disabled';
	}
	if (hasFreshRemoteConfig() && Object.keys(remoteOverrides).length > 0) {
		return 'remote';
	}
	return Object.keys(process.env).some(key => Object.prototype.hasOwnProperty.call(PARAMETER_SCHEMA, key))
		? 'environment'
		: 'default';
}

function getStatus() {
	const enabled = isEnabled();
	const configured = isFirestoreConfigured();
	const stale = remoteLoadedAt !== null && !hasFreshRemoteConfig();
	return {
		enabled,
		configured,
		ready: enabled && configured,
		status: !enabled ? 'disabled' : configured ? 'ready' : 'misconfigured',
		source: getSource(),
		templateVersion,
		lastSuccessfulLoad,
		lastErrorCategory: stale ? 'stale' : lastErrorCategory,
		refreshIntervalMs: getRefreshIntervalMs(),
		maxAgeMs: getMaxAgeMs(),
	};
}

function getRemoteValue(config, key, schema) {
	if (!config || typeof config.getValue !== 'function') {
		return { present: false };
	}

	try {
		const value = config.getValue(key);
		if (!value || typeof value.getSource !== 'function' || value.getSource() !== 'remote') {
			return { present: false };
		}
		if (typeof value.asString !== 'function') {
			return { present: false };
		}
		const parsed = parseValue(value.asString(), schema, undefined);
		return parsed === undefined ? { present: true, valid: false } : { present: true, value: parsed };
	} catch (error) {
		return { present: true, valid: false };
	}
}

function getTemplateVersion(template) {
	try {
		const data = template.toJSON();
		const version = data && data.version;
		return version && version.versionNumber != null ? String(version.versionNumber) : null;
	} catch (error) {
		return null;
	}
}

function withTimeout(promise, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const error = new Error('Remote Config load timed out');
			error.code = 'REMOTE_CONFIG_TIMEOUT';
			reject(error);
		}, timeoutMs);

		Promise.resolve(promise).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function getErrorCategory(error) {
	if (error && error.code === 'REMOTE_CONFIG_TIMEOUT') {
		return 'timeout';
	}
	if (error && error.code === 'REMOTE_CONFIG_NOT_CONFIGURED') {
		return 'credentials';
	}
	if (error && error.code === 'REMOTE_CONFIG_UNSUPPORTED') {
		return 'unsupported_sdk';
	}
	return 'load_failed';
}

async function loadNow(options = {}) {
	if (!isEnabled()) {
		return false;
	}
	if (loadingPromise) {
		return loadingPromise;
	}

	loadingPromise = (async () => {
		try {
			if (!alertStorageService.getFirestore()) {
				const error = new Error('Firebase Admin is not configured');
				error.code = 'REMOTE_CONFIG_NOT_CONFIGURED';
				throw error;
			}
			if (!admin.remoteConfig) {
				const error = new Error('Firebase Admin Remote Config is unavailable');
				error.code = 'REMOTE_CONFIG_UNSUPPORTED';
				throw error;
			}

			const remoteConfig = admin.remoteConfig();
			if (!remoteConfig || typeof remoteConfig.initServerTemplate !== 'function') {
				const error = new Error('Firebase Admin server template support is unavailable');
				error.code = 'REMOTE_CONFIG_UNSUPPORTED';
				throw error;
			}

			const template = remoteConfig.initServerTemplate({ defaultConfig: buildDefaultConfig() });
			await withTimeout(template.load(), options.timeoutMs || getLoadTimeoutMs());
			const evaluated = template.evaluate();
			const nextOverrides = {};
			let invalidValue = false;
			Object.entries(PARAMETER_SCHEMA).forEach(([key, schema]) => {
				const remoteValue = getRemoteValue(evaluated, key, schema);
				if (remoteValue.present && remoteValue.valid === false) {
					invalidValue = true;
				} else if (remoteValue.present) {
					nextOverrides[key] = remoteValue.value;
				}
			});

			remoteOverrides = nextOverrides;
			remoteLoadedAt = Date.now();
			templateVersion = getTemplateVersion(template);
			lastSuccessfulLoad = new Date(remoteLoadedAt).toISOString();
			lastErrorCategory = invalidValue ? 'invalid_value' : null;
			if (invalidValue) {
				console.warn('[RemoteConfigService] Ignored invalid allow-listed value');
			}
			return true;
		} catch (error) {
			remoteOverrides = {};
			remoteLoadedAt = null;
			lastErrorCategory = getErrorCategory(error);
			console.warn('[RemoteConfigService] Remote Config load failed:', lastErrorCategory);
			return false;
		} finally {
			loadingPromise = null;
		}
	})();

	return loadingPromise;
}

async function start() {
	if (!isEnabled() || refreshTimer) {
		return false;
	}

	await loadNow();
	refreshTimer = setInterval(() => {
		void loadNow();
	}, getRefreshIntervalMs());
	if (typeof refreshTimer.unref === 'function') {
		refreshTimer.unref();
	}
	return true;
}

function stop() {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
}

function resetForTesting() {
	stop();
	remoteOverrides = {};
	remoteLoadedAt = null;
	templateVersion = null;
	lastSuccessfulLoad = null;
	lastErrorCategory = null;
	loadingPromise = null;
}

module.exports = {
	PARAMETER_SCHEMA,
	getRuntimeConfig,
	getStatus,
	loadNow,
	start,
	stop,
	_resetForTesting: resetForTesting,
	_setRemoteOverridesForTesting(overrides, loadedAt = Date.now()) {
		remoteOverrides = { ...overrides };
		remoteLoadedAt = loadedAt;
	},
};
