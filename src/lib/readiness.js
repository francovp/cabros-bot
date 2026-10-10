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
 *
 * Security: `/healthcheck` and `/ready` are unauthenticated and exempt from the
 * rate limiter, so every surfaced `error` string passes through
 * `redactString` before it reaches the response. Provider URLs routinely carry
 * credentials (the Gemini key is a query parameter, `TRADINGVIEW_MCP_URL` is
 * operator-supplied and may embed a token), and `fetch` embeds the failing URL
 * in its own error message.
 */

const { redactString } = require('./logging');

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const MIN_PROBE_TIMEOUT_MS = 1000;
const MAX_PROBE_TIMEOUT_MS = 5000;

/** Sanitize any error value before it is exposed on a public probe surface. */
function sanitizeError(error) {
	const message = error && error.message ? error.message : String(error);
	return redactString(message);
}

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

const DEFAULT_CACHE_TTL_MS = 5000;

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
					error: sanitizeError(error),
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

function isFirestoreEnabled() {
	return isEnabled(process.env.ENABLE_FIRESTORE_ALERT_STORAGE)
		|| isEnabled(process.env.ENABLE_FIRESTORE_IDEMPOTENCY)
		|| isEnabled(process.env.ENABLE_FIRESTORE_SCANNER_PRESETS)
		|| isEnabled(process.env.ENABLE_FIRESTORE_JOB_STORAGE);
}

function buildFirestoreProbe(deps) {
	const isConfigured = deps.isConfigured;
	const getClient = deps.getClient;
	const probeAlertReads = deps.probeAlertReads;
	const timeoutMs = deps.timeoutMs;
	return async function probeFirestore() {
		if (!isFirestoreEnabled()) {
			return skippedResult('firestore_storage_disabled');
		}
		if (!isConfigured()) {
			// The feature is switched on but its credentials are missing or
			// unreadable. That is a real failure the operator must see, not a
			// deliberately disabled feature — reporting it as `skipped` would
			// exclude it from the verdict and return 200 from the gate.
			return { ready: false, enabled: true, error: 'firestore_not_configured' };
		}
		const client = typeof getClient === 'function' ? getClient() : null;
		if (!client) {
			return { ready: false, error: 'firestore_uninitialized' };
		}
		return timed(async () => {
			await client.listCollections();
			// `listCollections()` is a metadata call: it never executes a
			// collection query, so it reported a healthy Firestore while every
			// ordered `alerts` read was rejected for a missing composite index
			// (#1285). Probe the read path itself so the gate can see it.
			if (typeof probeAlertReads === 'function') {
				await probeAlertReads();
			}
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
				+ encodeURIComponent(model);
			// The key travels in a header, never the query string: `fetch` embeds
			// the failing URL in its own error message and this surface is public.
			const response = await fetch(url, {
				method: 'GET',
				headers: { 'x-goog-api-key': apiKey },
			});
			// A 404 means the model name is wrong or the API version moved, which
			// breaks every grounding call — so it is a failure, not a pass.
			if (!response.ok) {
				throw new Error('gemini_http_' + response.status
					+ (response.status === 404 ? ' (check GEMINI_MODEL_NAME_FALLBACK)' : ''));
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
				// Only an explicitly healthy state counts as ready. `unknown`
				// (never contacted), `disabled` and any future status must not
				// pass a fail-closed gate, otherwise an unverified provider is
				// indistinguishable from a working one.
				if (!readiness || typeof readiness !== 'object') {
					return { ready: false, error: 'tradingview_status_unavailable' };
				}
				const status = readiness.status;
				if (status === 'ready' || status === 'ok') {
					return { ready: true, backend: 'tradingview_mcp' };
				}
				if (status === 'disabled') {
					return { ready: false, enabled: false, skipped: true, reason: 'tradingview_disabled' };
				}
				return {
					ready: false,
					error: 'tradingview_' + String(status || 'unknown'),
				};
			} catch (error) {
				return { ready: false, error: sanitizeError(error) };
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
			// The bot is constructed later in boot, so an early probe legitimately
			// finds no instance. That is a transient startup state, not a
			// dependency failure — reporting it as `skipped` keeps it out of the
			// verdict instead of holding the fail-closed gate at 503 forever.
			return { ready: false, enabled: true, skipped: true, reason: 'telegram_not_initialized' };
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

	const probeAlertReads = overrides.probeAlertReads
		|| (() => {
			try {
				const storage = require('../services/storage/AlertStorageService');
				return storage.probeOrderedAlertRead;
			} catch (error) {
				return null;
			}
		});

	const probes = {
		firestore: buildFirestoreProbe({
			isConfigured: isFirestoreConfigured,
			getClient: getFirestoreClient,
			probeAlertReads,
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

	async function runProbe(fn) {
		try {
			return await fn();
		} catch (error) {
			return {
				ready: false,
				enabled: true,
				latencyMs: 0,
				error: sanitizeError(error),
			};
		}
	}

	async function runAllProbes() {
		const entries = await Promise.all(
			Object.entries(probes).map(async (entry) => [entry[0], await runProbe(entry[1])]),
		);
		const dependencies = Object.fromEntries(entries);
		const considered = Object.values(dependencies).filter((dep) => dep && dep.skipped !== true);
		const ready = considered.length > 0 && considered.every((dep) => dep.ready === true);
		return { ready, dependencies };
	}

	// A load balancer or uptime monitor polling every few seconds would
	// otherwise fan out to Gemini, Binance and TradingView on every hit — five
	// outbound requests, one of them carrying a real API key, per poll per
	// replica. Coalesce into a short TTL and single-flight concurrent callers.
	let cachedReport = null;
	let cachedAt = 0;
	let inFlight = null;

	async function collectReadiness() {
		const now = Date.now();
		if (cachedReport && now - cachedAt < DEFAULT_CACHE_TTL_MS) {
			return cachedReport;
		}
		if (inFlight) {
			return inFlight;
		}
		inFlight = runAllProbes()
			.then((report) => {
				cachedReport = report;
				cachedAt = Date.now();
				return report;
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	}

	return { collectReadiness };
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
