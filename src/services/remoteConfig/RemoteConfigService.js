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
	NEWS_TIMEOUT_MS: { type: 'number', defaultValue: 30000, integer: true, min: 1000, max: 120000 },
	NEWS_GEMINI_CONCURRENCY: { type: 'number', defaultValue: Infinity, integer: true, min: 1, max: 50 },
	NEWS_GEMINI_QUOTA_MAX_RETRIES: { type: 'number', defaultValue: 2, integer: true, min: 1, max: 5 },
	NEWS_GEMINI_QUOTA_RETRY_BASE_MS: { type: 'number', defaultValue: 1000, integer: true, min: 1, max: 60000 },
	TRADINGVIEW_MCP_TIMEOUT_MS: { type: 'number', defaultValue: 12000, integer: true, min: 1000, max: 120000 },
	TRADINGVIEW_MCP_MAX_RETRIES: { type: 'number', defaultValue: 3, integer: true, min: 1, max: 5 },
	TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS: { type: 'number', defaultValue: 12000, integer: true, min: 1000, max: 120000 },
	TRADINGVIEW_MCP_BREAKER_FAILURE_THRESHOLD: { type: 'number', defaultValue: 5, integer: true, min: 1, max: 100 },
	TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS: { type: 'number', defaultValue: 600000, integer: true, min: 1000, max: 86400000 },
	TRADINGVIEW_MCP_PAGE_COOLDOWN_MS: { type: 'number', defaultValue: 3600000, integer: true, min: 1000, max: 86400000 },
	ENABLE_MESSAGE_FOOTER_METADATA: { type: 'boolean', defaultValue: true },
	GROUNDING_MAX_SOURCES: { type: 'number', defaultValue: 3, integer: true, min: 1, max: 20 },
	GROUNDING_TIMEOUT_MS: { type: 'number', defaultValue: 30000, integer: true, min: 1, max: 120000 },
	GROUNDING_MAX_LENGTH: { type: 'number', defaultValue: 2000, integer: true, min: 1, max: 10000 },
	ALERT_GROUNDING_COALESCE_MS: { type: 'number', defaultValue: 0, integer: true, min: 0, max: 60000 },
	NEWS_CACHE_TTL_HOURS: { type: 'number', defaultValue: 6, min: 0, max: 720 },
	BINANCE_FETCH_TIMEOUT_MS: { type: 'number', defaultValue: 5000, integer: true, min: 1, max: 60000 },
	TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: {
		type: 'string',
		defaultValue: '1h',
		allowedValues: ['5m', '15m', '1h', '4h', '1D', '1W', '1M'],
	},
	EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS: { type: 'number', defaultValue: 60000, integer: true, min: 1, max: 120000 },
	EXPANDED_ANALYSIS_ALERT_CONCURRENCY: { type: 'number', defaultValue: 3, integer: true, min: 1, max: 10 },
	DISCORD_MAX_RETRIES: { type: 'number', defaultValue: 2, integer: true, min: 0, max: 10 },
	DISCORD_FALLBACK_RETRY_DELAY_MS: { type: 'number', defaultValue: 500, integer: true, min: 1, max: 30000 },
	DISCORD_MAX_RETRY_DELAY_MS: { type: 'number', defaultValue: 5000, integer: true, min: 1, max: 60000 },
	DISCORD_MAX_TOTAL_RETRY_WAIT_MS: { type: 'number', defaultValue: 10000, integer: true, min: 1, max: 120000 },
	WEBHOOK_IDEMPOTENCY_TTL_MS: { type: 'number', defaultValue: 300000, integer: true, min: 1, max: 86400000 },
	JOB_CALLBACK_RETRY_DELAY_MS: { type: 'number', defaultValue: 1000, integer: true, min: 1, max: 60000 },
	JOB_POLL_INTERVAL_MS: { type: 'number', defaultValue: 15000, integer: true, min: 1000, max: 300000 },
	SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT: { type: 'number', defaultValue: 50, integer: true, min: 1, max: 500 },
	SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS: { type: 'number', defaultValue: 30000, integer: true, min: 1, max: 300000 },
	SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS: { type: 'number', defaultValue: 3, integer: true, min: 1, max: 20 },
	SIGNAL_OUTCOME_MAX_RETRY_AGE_MS: { type: 'number', defaultValue: 604800000, integer: true, min: 60000, max: 2592000000 },
	SIGNAL_OUTCOME_RETENTION_DAYS: { type: 'number', defaultValue: 365, integer: true, min: 1, max: 3650 },
	EQUITY_MARKET_DATA_RPM: { type: 'number', defaultValue: 8, integer: true, min: 0, max: 1200 },
	NOTIFICATION_REDRIVE_INTERVAL_MS: { type: 'number', defaultValue: 60000, integer: true, min: 1000, max: 3600000 },
	NOTIFICATION_REDRIVE_BATCH_LIMIT: { type: 'number', defaultValue: 50, integer: true, min: 1, max: 500 },
	NOTIFICATION_REDRIVE_MAX_ATTEMPTS: { type: 'number', defaultValue: 5, integer: true, min: 1, max: 20 },
	NOTIFICATION_REDRIVE_MAX_AGE_MS: { type: 'number', defaultValue: 3600000, integer: true, min: 60000, max: 86400000 },
	SCANNER_PRESET_SCHEDULER_INTERVAL_MS: { type: 'number', defaultValue: 60000, integer: true, min: 1000, max: 3600000 },
	SCANNER_PRESET_SCHEDULER_BATCH_LIMIT: { type: 'number', defaultValue: 50, integer: true, min: 1, max: 500 },
	NEWS_MONITOR_SCHEDULER_INTERVAL_MS: { type: 'number', defaultValue: 300000, integer: true, min: 10000, max: 3600000 },
	NEWS_MONITOR_SCHEDULER_BATCH_LIMIT: { type: 'number', defaultValue: 50, integer: true, min: 1, max: 500 },
	ENABLE_GEMINI_GROUNDING: { type: 'boolean', defaultValue: false },
	ENABLE_TRADINGVIEW_MCP_ENRICHMENT: { type: 'boolean', defaultValue: false },
	ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION: { type: 'boolean', defaultValue: false },
	ENABLE_MARKET_SCANNER: { type: 'boolean', defaultValue: false },
	ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP: { type: 'boolean', defaultValue: false },
	ZERO_CHANNEL_ALERT_COOLDOWN_MS: { type: 'number', defaultValue: 300000, integer: true, min: 1000, max: 86400000 },
	ENABLE_API_ONLY_MODE: { type: 'boolean', defaultValue: false },
	ENABLE_ALERT_HTF_RENDER: { type: 'boolean', defaultValue: true },
	ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION: { type: 'boolean', defaultValue: false },
	ALERT_SIGNAL_COOLDOWN_BARS: { type: 'number', defaultValue: 1, integer: true, min: 1, max: 10 },
	JOB_BACKLOG_ALERT_THRESHOLD_MS: { type: 'number', defaultValue: 900000, integer: true, min: 1000, max: 86400000 },
	JOB_BACKLOG_PAGE_COOLDOWN_MS: { type: 'number', defaultValue: 900000, integer: true, min: 1000, max: 86400000 },
	JOB_BACKLOG_PROBE_INTERVAL_MS: { type: 'number', defaultValue: 60000, integer: true, min: 1000, max: 3600000 },
});

let remoteOverrides = {};
let remoteLoadedAt = null;
let templateVersion = null;
let lastSuccessfulLoad = null;
let lastErrorCategory = null;
let refreshTimer = null;
let loadingPromise = null;
let consecutiveFailures = 0;

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

function parseEnvironmentNumber(value, schema, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	const parsed = typeof value === 'number' ? value : Number(String(value).trim());
	if (!Number.isFinite(parsed) || (schema.integer && !Number.isSafeInteger(parsed)) || parsed < schema.min) {
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

function parseString(value, schema, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const str = String(value).trim();
	if (Array.isArray(schema.allowedValues) && !schema.allowedValues.includes(str)) {
		return fallback;
	}
	return str;
}

function parseValue(value, schema, fallback) {
	if (schema.type === 'boolean') {
		return parseBoolean(value, fallback);
	}
	if (schema.type === 'string' || schema.allowedValues) {
		return parseString(value, schema, fallback);
	}
	return parseBoundedNumber(value, schema, fallback);
}

function getEnvironmentConfig() {
	const parseLegacyPositiveInteger = (value, fallback) => {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	};

	const config = {};
	for (const [key, schema] of Object.entries(PARAMETER_SCHEMA)) {
		if (key === 'NEWS_ALERT_THRESHOLD') {
			config[key] = Number.parseFloat(process.env.NEWS_ALERT_THRESHOLD || 0.7);
		} else if (key === 'NEWS_TIMEOUT_MS') {
			config[key] = parseLegacyPositiveInteger(process.env.NEWS_TIMEOUT_MS, 30000);
		} else if (key === 'NEWS_GEMINI_CONCURRENCY') {
			config[key] = parseLegacyPositiveInteger(process.env.NEWS_GEMINI_CONCURRENCY, Infinity);
		} else if (key === 'NEWS_GEMINI_QUOTA_MAX_RETRIES') {
			config[key] = parseLegacyPositiveInteger(process.env.NEWS_GEMINI_QUOTA_MAX_RETRIES, 2);
		} else if (key === 'NEWS_GEMINI_QUOTA_RETRY_BASE_MS') {
			config[key] = parseLegacyPositiveInteger(process.env.NEWS_GEMINI_QUOTA_RETRY_BASE_MS, 1000);
		} else if (key === 'WEBHOOK_IDEMPOTENCY_TTL_MS') {
			config[key] = parseEnvironmentNumber(process.env[key], schema, schema.defaultValue);
		} else if (key === 'EQUITY_MARKET_DATA_RPM') {
			const envVal = process.env.EQUITY_MARKET_DATA_RPM ?? process.env.TWELVE_DATA_RPM;
			config[key] = process.env.NODE_ENV === 'test' && envVal === undefined
				? 0
				: parseValue(envVal, schema, schema.defaultValue);
		} else {
			config[key] = parseValue(process.env[key], schema, schema.defaultValue);
		}
	}
	return config;
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
	const effectiveErrorCategory = stale ? 'stale' : lastErrorCategory;
	const isReady = enabled && configured && lastSuccessfulLoad !== null && hasFreshRemoteConfig() && !stale;

	let status;
	if (!enabled) {
		status = 'disabled';
	} else if (!configured) {
		status = 'misconfigured';
	} else if (isReady) {
		status = 'ready';
	} else if (lastSuccessfulLoad === null && effectiveErrorCategory === null) {
		status = 'unknown';
	} else {
		status = 'degraded';
	}

	return {
		enabled,
		configured,
		ready: isReady,
		status,
		source: getSource(),
		templateVersion,
		lastSuccessfulLoad,
		lastErrorCategory: effectiveErrorCategory,
		consecutiveFailures,
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
			consecutiveFailures = 0;
			if (invalidValue) {
				console.warn('[RemoteConfigService] Ignored invalid allow-listed value');
			}
			return true;
		} catch (error) {
			remoteOverrides = {};
			remoteLoadedAt = null;
			lastErrorCategory = getErrorCategory(error);
			consecutiveFailures += 1;
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
	consecutiveFailures = 0;
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
		templateVersion = 'test';
		lastSuccessfulLoad = new Date(loadedAt).toISOString();
		lastErrorCategory = null;
		consecutiveFailures = 0;
	},
};
