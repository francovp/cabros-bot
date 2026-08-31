'use strict';

/**
 * Lightweight readiness probes for /healthcheck?depth=readiness and /ready.
 *
 * Each probe is bounded by a per-dependency timeout, fails open (returns
 * a structured per-dep status), and never throws. Probes are only scheduled
 * when the corresponding feature flag is enabled - disabled dependencies are
 * reported as `{ ready: false, enabled: false, skipped: true }` so callers can
 * distinguish "feature off" from "feature on but degraded".
 *
 * No new environment variables are required. When a feature is not enabled,
 * the probe is skipped entirely (no outbound call is made).
 */

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const MIN_PROBE_TIMEOUT_MS = 1000;
const MAX_PROBE_TIMEOUT_MS = 5000;

function clampTimeoutMs(value) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_PROBE_TIMEOUT_MS;
	}
	if (parsed < MIN_PROBE_TIMEOUT_MS) {
		return MIN_PROBE_TIMEOUT_MS;
	}
	if (parsed > MAX_PROBE_TIMEOUT_MS) {
		return MAX_PROBE_TIMEOUT_MS;
	}
	return parsed;
}

function resolveTimeoutMs(envValue, fallback) {
	if (fallback === undefined) {
		fallback = DEFAULT_PROBE_TIMEOUT_MS;
	}
	if (envValue === undefined || envValue === null || envValue === '') {
		return fallback;
	}
	return clampTimeoutMs(envValue);
}

function isEnabled(value) {
	return value === 'true';
}

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function timed(fn, timeoutMs) {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			resolve({
				ready: false,
				latencyMs: Date.now() - startedAt,
				error: 'timeout_after_' + timeoutMs + 'ms',
			});
		}, timeoutMs);

		Promise.resolve()
			.then(() => fn())
			.then((value) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve({
					ready: true,
					latencyMs: Date.now() - startedAt,
					...(value && typeof value === 'object' ? value : {}),
				});
			})
			.catch((error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve({
					ready: false,
					latencyMs: Date.now() - startedAt,
					error: error && error.message ? error.message : String(error),
				});
			});
	});
}

function skippedResult(reason) {
	return {
		ready: false,
		enabled: false,
		skipped: true,
		reason,
	};
}

function buildFirestoreProbe(deps) {
	const isConfigured = deps.isConfigured;
	const getClient = deps.getClient;
	const timeoutMs = deps.timeoutMs;
	return async function probeFirestore() {
		if (!isEnabled(process.env.ENABLE_FIRESTORE_ALERT_STORAGE)
			&& !isEnabled(process.env.ENABLE_FIRESTORE_IDEMPOTENCY)
			&& !isEnabled(process.env.ENABLE_FIRESTORE_SCANNER_PRESETS)
			&& !isEnabled(process.env.ENABLE_FIRESTORE_JOB_STORAGE)) {
			return skippedResult('firestore_storage_disabled');
		}
		if (!isConfigured()) {
			return skippedResult('firestore_not_configured');
		}
		const client = typeof getClient === 'function' ? getClient() : null;
		if (!client) {
			return { ready: false, error: 'firestore_uninitialized' };
		}
		return timed(async () => {
			await client.listCollections();
			return { backend: 'firestore' };
		}, timeoutMs);
	};
}

function buildGeminiProbe(opts) {
	const timeoutMs = opts.timeoutMs;
	return async function probeGemini() {
		if (!isEnabled(process.env.ENABLE_GEMINI_GROUNDING)
			&& !isEnabled(process.env.ENABLE_NEWS_MONITOR)) {
			return skippedResult('gemini_disabled');
		}
		const apiKey = process.env.GEMINI_API_KEY;
		if (!hasValue(apiKey)) {
			return { ready: false, error: 'gemini_api_key_missing' };
		}
		return timed(async () => {
			const model = process.env.GEMINI_MODEL_NAME_FALLBACK
				|| process.env.GEMINI_MODEL_NAME
				|| 'gemini-2.5-flash';
			const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
				+ encodeURIComponent(model) + '?key=' + encodeURIComponent(apiKey);
			const response = await fetch(url, { method: 'GET' });
			if (!response.ok && response.status !== 404) {
				throw new Error('gemini_http_' + response.status);
			}
			return { backend: 'gemini' };
		}, timeoutMs);
	};
}

function buildTradingViewMcpProbe(opts) {
	const getReadiness = opts.getReadiness;
	const timeoutMs = opts.timeoutMs;
	return async function probeTradingViewMcp() {
		if (!isEnabled(process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT)
			&& !isEnabled(process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION)
			&& !isEnabled(process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT)
			&& !isEnabled(process.env.ENABLE_MARKET_SCANNER)) {
			return skippedResult('tradingview_disabled');
		}
		if (typeof getReadiness === 'function') {
			try {
				const readiness = getReadiness();
				if (readiness && readiness.status === 'degraded') {
					return { ready: false, error: readiness.lastError || 'tradingview_degraded' };
				}
				return { ready: true, backend: 'tradingview_mcp' };
			} catch (error) {
				return { ready: false, error: error && error.message ? error.message : String(error) };
			}
		}
		const url = process.env.TRADINGVIEW_MCP_URL;
		if (!hasValue(url)) {
			return { ready: false, error: 'tradingview_url_missing' };
		}
		return timed(async () => {
			const response = await fetch(url, {
				method: 'GET',
				headers: { accept: 'application/json, text/event-stream' },
			});
			if (!response.ok && response.status !== 405) {
				throw new Error('tradingview_http_' + response.status);
			}
			return { backend: 'tradingview_mcp' };
		}, timeoutMs);
	};
}

function buildBinanceProbe(opts) {
	const timeoutMs = opts.timeoutMs;
	return async function probeBinance() {
		if (!isEnabled(process.env.ENABLE_BINANCE_TRADING)
			&& !isEnabled(process.env.ENABLE_BINANCE_PRICE_CHECK)
			&& !isEnabled(process.env.ENABLE_SIGNAL_OUTCOME_TRACKING)) {
			return skippedResult('binance_disabled');
		}
		const baseUrl = process.env.BINANCE_DATA_BASE_URL || 'https://api.binance.com';
		if (!hasValue(baseUrl)) {
			return { ready: false, error: 'binance_url_missing' };
		}
		return timed(async () => {
			const response = await fetch(baseUrl.replace(/\/$/, '') + '/api/v3/ping');
			if (!response.ok) {
				throw new Error('binance_http_' + response.status);
			}
			return { backend: 'binance' };
		}, timeoutMs);
	};
}

function buildTelegramProbe(opts) {
	const isBotEnabled = opts.isBotEnabled;
	const getBot = opts.getBot;
	const timeoutMs = opts.timeoutMs;
	return async function probeTelegram() {
		if (!isEnabled(process.env.ENABLE_TELEGRAM_BOT)) {
			return skippedResult('telegram_disabled');
		}
		if (typeof isBotEnabled === 'function' && !isBotEnabled()) {
			return { ready: false, error: 'telegram_not_started' };
		}
		const bot = typeof getBot === 'function' ? getBot() : null;
		if (!bot || !bot.telegram || typeof bot.telegram.getMe !== 'function') {
			return { ready: false, error: 'telegram_bot_unavailable' };
		}
		return timed(async () => {
			await bot.telegram.getMe();
			return { backend: 'telegram' };
		}, timeoutMs);
	};
}

function createReadinessService(overrides) {
	overrides = overrides || {};
	const timeoutMs = resolveTimeoutMs(overrides.timeoutMs);
	const isFirestoreConfigured = overrides.isFirestoreConfigured
		|| (() => {
			try {
				return require('../services/storage/firestoreConfig').isFirestoreConfigured();
			} catch (error) {
				return false;
			}
		});
	const getFirestoreClient = overrides.getFirestoreClient
		|| (() => {
			try {
				const storage = require('../services/storage/AlertStorageService');
				return storage.getFirestore();
			} catch (error) {
				return null;
			}
		});

	const probes = {
		firestore: buildFirestoreProbe({
			isConfigured: isFirestoreConfigured,
			getClient: getFirestoreClient,
			timeoutMs,
		}),
		gemini: buildGeminiProbe({ timeoutMs }),
		tradingViewMcp: buildTradingViewMcpProbe({
			getReadiness: overrides.getTradingViewReadiness,
			timeoutMs,
		}),
		binance: buildBinanceProbe({ timeoutMs }),
		telegram: buildTelegramProbe({
			isBotEnabled: overrides.isBotEnabled,
			getBot: overrides.getBot,
			timeoutMs,
		}),
	};

	async function runProbe(name, fn) {
		try {
			return await fn();
		} catch (error) {
			return {
				ready: false,
				enabled: true,
				latencyMs: 0,
				error: error && error.message ? error.message : String(error),
			};
		}
	}

	async function collectReadiness() {
		const startedAt = Date.now();
		const entries = await Promise.all(
			Object.entries(probes).map(async (entry) => [entry[0], await runProbe(entry[0], entry[1])]),
		);
		const dependencies = Object.fromEntries(entries);
		const considered = Object.values(dependencies).filter((dep) => dep && dep.skipped !== true);
		const ready = considered.length > 0 && considered.every((dep) => dep.ready === true);
		return {
			ready,
			latencyMs: Date.now() - startedAt,
			dependencies,
		};
	}

	return {
		collectReadiness,
		probes,
		timeoutMs,
	};
}

module.exports = {
	createReadinessService,
	resolveTimeoutMs,
	clampTimeoutMs,
	DEFAULT_PROBE_TIMEOUT_MS,
	MIN_PROBE_TIMEOUT_MS,
	MAX_PROBE_TIMEOUT_MS,
	timed,
	skippedResult,
};
