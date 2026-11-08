'use strict';

/**
 * SelfTestService - bounded self-diagnostic suite for on-call operators.
 *
 * Runs named, pure-function checks that return a uniform
 * `{ id, status, message, durationMs, evidence? }` record.
 *
 * Each check has its own 5-second deadline; the whole suite has a 30-second
 * budget. Failed checks never throw — the failure is captured as
 * `status: 'fail'` with a sanitized error category.
 *
 * Feature: 801 - Self-test diagnostic endpoint.
 */

const packageJson = require('../../../package.json');
const { getDeploymentCommit } = require('../../lib/deploymentEnvironment');
const { resolveRemoteOverride } = require('../remoteConfig/resolveRemoteOverride');
const { redactString } = require('../../lib/logging');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');

const DEFAULT_PER_CHECK_TIMEOUT_MS = 5000;
const DEFAULT_SUITE_TIMEOUT_MS = 30000;
const RESULT_TTL_MS = 60_000;
const FIRESTORE_STORAGE_GATES = Object.freeze([
	'ENABLE_FIRESTORE_ALERT_STORAGE',
	'ENABLE_FIRESTORE_JOB_STORAGE',
	'ENABLE_FIRESTORE_SCANNER_PRESETS',
	'ENABLE_FIRESTORE_IDEMPOTENCY',
	'ENABLE_SIGNAL_OUTCOME_TRACKING',
	'ENABLE_FIRESTORE_NEWS_ANALYSIS',
	'ENABLE_FIRESTORE_ALERT_FEEDBACK',
	'ENABLE_FIRESTORE_CHAT_PREFERENCES',
	'ENABLE_FIRESTORE_ALERT_SUBSCRIBERS',
	'ENABLE_BINANCE_ORDER_AUDIT',
	'ENABLE_SYMBOL_ANALYSIS_STORAGE',
	'ENABLE_TRADE_LEDGER',
	'ENABLE_AUTO_TRADE',
	'ENABLE_NOTIFICATION_REDRIVE',
	'ENABLE_USER_PRICE_ALERTS',
	'ENABLE_ALERT_SCHEDULER',
	'ENABLE_NEWS_MONITOR_SCHEDULER',
	'ENABLE_TOKEN_COST_BUDGET',
]);
const SENSITIVE_KEYS = new Set([
	'authorization',
	'x-api-key',
	'api-key',
	'cookie',
	'password',
	'token',
	'secret',
	'dsn',
	'apikey',
	'access_token',
	'refresh_token',
	'client_secret',
	'webhook_secret',
	'callback_secret',
]);

function nowIso() {
	return new Date().toISOString();
}

function sanitizeUrlForEvidence(rawUrl) {
	if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
	if (/^https?:\/\//i.test(rawUrl)) {
		try {
			const parsed = new URL(rawUrl);
			const baseWithoutQuery = rawUrl.split(/[?#]/)[0];
			parsed.username = '';
			parsed.password = '';
			parsed.search = '';
			parsed.hash = '';
			let result = parsed.toString();
			if (!baseWithoutQuery.endsWith('/') && result.endsWith('/')) {
				result = result.slice(0, -1);
			}
			return redactString(result);
		} catch {
			const withoutQuery = rawUrl.split(/[?#]/)[0];
			const withoutUserInfo = withoutQuery.replace(/^(https?:\/\/)[^/?#@]+(?::[^/?#@]*)?@/i, '$1');
			return redactString(withoutUserInfo);
		}
	}

	try {
		const fallback = new URL(`http://${rawUrl}`);
		const baseWithoutQuery = rawUrl.split(/[?#]/)[0];
		fallback.username = '';
		fallback.password = '';
		fallback.search = '';
		fallback.hash = '';
		let res = fallback.toString().replace(/^http:\/\//, '');
		if (!baseWithoutQuery.endsWith('/') && res.endsWith('/')) {
			res = res.slice(0, -1);
		}
		return redactString(res);
	} catch {
		const withoutQuery = rawUrl.split(/[?#]/)[0];
		const withoutUserInfo = withoutQuery.replace(/(^|\/\/)[^/?#@]+(?::[^/?#@]*)?@/i, '$1');
		return redactString(withoutUserInfo);
	}
}

function sanitizeEvidence(value) {
	if (value == null) return value;
	if (typeof value === 'string') return value.length > 256 ? `${value.slice(0, 256)}…` : value;
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value.slice(0, 25).map((entry) => sanitizeEvidence(entry));
	if (typeof value !== 'object') return value;
	const out = {};
	for (const [key, val] of Object.entries(value)) {
		const lowerKey = key.toLowerCase();
		if (SENSITIVE_KEYS.has(lowerKey)) {
			out[key] = '[REDACTED]';
			continue;
		}
		if ((lowerKey.endsWith('endpoint') || lowerKey.endsWith('url')) && typeof val === 'string') {
			const sanitized = sanitizeUrlForEvidence(val);
			out[key] = sanitized.length > 256 ? `${sanitized.slice(0, 256)}…` : sanitized;
			continue;
		}
		out[key] = sanitizeEvidence(val);
	}
	return out;
}

function withTimeout(promiseFactory, timeoutMs, onTimeout) {
	let timeoutId;
	const timer = new Promise((resolve) => {
		timeoutId = setTimeout(() => resolve(onTimeout()), timeoutMs);
	});
	return Promise.race([Promise.resolve().then(promiseFactory), timer]).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
	});
}

function makeResult(status, message, evidence) {
	return {
		status,
		message,
		durationMs: 0,
		evidence: sanitizeEvidence(evidence || null),
	};
}

async function runCheck(check, { perCheckTimeoutMs }) {
	const start = Date.now();
	try {
		const result = await withTimeout(
			() => check.run({ timeoutMs: perCheckTimeoutMs }),
			perCheckTimeoutMs,
			() => ({ status: 'fail', message: `check exceeded ${perCheckTimeoutMs}ms deadline`, evidence: null }),
		);
		const durationMs = Date.now() - start;
		const safeResult = result && typeof result === 'object'
			? result
			: { status: 'pass', message: 'check returned no result' };
		const status = ['pass', 'warn', 'fail', 'skipped'].includes(safeResult.status) ? safeResult.status : 'pass';
		return {
			id: check.id,
			status,
			message: typeof safeResult.message === 'string' ? safeResult.message : 'ok',
			durationMs,
			evidence: sanitizeEvidence(safeResult.evidence || null),
		};
	} catch (error) {
		return {
			id: check.id,
			status: 'fail',
			message: `check threw: ${describeError(error)}`,
			durationMs: Date.now() - start,
			evidence: null,
		};
	}
}

function describeError(error) {
	if (!error) return 'unknown error';
	if (typeof error === 'string') return error.slice(0, 200);
	if (error.name) return error.name;
	if (error.message) return String(error.message).slice(0, 200);
	return 'error';
}

function toBoolean(value) {
	return value === 'true';
}

function isRuntimeGateEnabled(key) {
	const remote = resolveRemoteOverride(key);
	if (typeof remote === 'boolean') {
		return remote;
	}
	return toBoolean(process.env[key])
		|| (key === 'ENABLE_FIRESTORE_IDEMPOTENCY'
			&& toBoolean(process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE));
}

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function buildChecks({ botOrGetter, getBinanceOrderService }) {
	const checks = [];

	checks.push({
		id: 'telegram.bot_info',
		run: () => {
			const bot = typeof botOrGetter === 'function' ? botOrGetter() : botOrGetter;
			if (!bot) {
				return { status: 'skipped', message: 'Telegram bot is disabled' };
			}
			const info = bot.botInfo;
			if (!info || !info.username) {
				return { status: 'warn', message: 'bot launched but botInfo is not populated yet', evidence: null };
			}
			return makeResult('pass', `Bot @${info.username} is up`, { id: info.id });
		},
	});

	checks.push({
		id: 'telegram.env',
		run: () => {
			const token = hasValue(process.env.BOT_TOKEN);
			const chatId = hasValue(process.env.TELEGRAM_CHAT_ID);
			if (!token) return makeResult('fail', 'BOT_TOKEN is not set', null);
			if (!chatId) return makeResult('warn', 'TELEGRAM_CHAT_ID is not set', null);
			return makeResult('pass', 'BOT_TOKEN and TELEGRAM_CHAT_ID are set');
		},
	});

	checks.push({
		id: 'auth.api_key',
		run: () => {
			const apiKey = hasValue(process.env.WEBHOOK_API_KEY);
			const firebaseAuth = toBoolean(process.env.ENABLE_FIREBASE_ADMIN_AUTH);
			if (!apiKey && !firebaseAuth) {
				return makeResult('fail', 'Neither WEBHOOK_API_KEY nor ENABLE_FIREBASE_ADMIN_AUTH is configured', null);
			}
			if (apiKey && firebaseAuth) {
				return makeResult('warn', 'Both API key and Firebase admin auth are enabled; legacy API key takes precedence for header auth', null);
			}
			return makeResult('pass', firebaseAuth ? 'Firebase admin auth is the active trust domain' : 'WEBHOOK_API_KEY is set');
		},
	});

	checks.push({
		id: 'gemini.grounding',
		run: () => {
			if (!toBoolean(process.env.ENABLE_GEMINI_GROUNDING)) {
				return { status: 'skipped', message: 'ENABLE_GEMINI_GROUNDING is not enabled' };
			}
			if (!hasValue(process.env.GEMINI_API_KEY)) {
				return makeResult('fail', 'GEMINI_API_KEY is required when grounding is enabled', null);
			}
			return makeResult('pass', 'Gemini grounding is configured (no live call to avoid quota)');
		},
	});

	checks.push({
		id: 'tradingview_mcp.endpoint',
		run: () => {
			if (!hasValue(process.env.TRADINGVIEW_MCP_URL)) {
				return { status: 'skipped', message: 'TRADINGVIEW_MCP_URL is not configured' };
			}
			return makeResult('pass', 'TRADINGVIEW_MCP_URL is configured', { endpoint: process.env.TRADINGVIEW_MCP_URL });
		},
	});

	checks.push({
		id: 'firestore.collections',
		run: () => {
			const firestoreEnabled = FIRESTORE_STORAGE_GATES.some(isRuntimeGateEnabled);
			if (!firestoreEnabled) {
				return { status: 'skipped', message: 'No Firestore feature is enabled' };
			}
			if (!isFirestoreConfigured()) {
				return makeResult('fail', 'Firestore enabled but credentials are missing', null);
			}
			return makeResult('pass', 'Firestore credentials are configured');
		},
	});

	checks.push({
		id: 'binance.trading',
		run: () => {
			if (!toBoolean(process.env.ENABLE_BINANCE_TRADING)) {
				return { status: 'skipped', message: 'ENABLE_BINANCE_TRADING is not enabled' };
			}
			if (!hasValue(process.env.BINANCE_API_KEY) || !hasValue(process.env.BINANCE_API_SECRET)) {
				return makeResult('fail', 'BINANCE_API_KEY and BINANCE_API_SECRET are required', null);
			}
			const service = typeof getBinanceOrderService === 'function' ? getBinanceOrderService() : null;
			if (service && typeof service.getStatus === 'function') {
				const status = service.getStatus();
				if (status) {
					if (typeof status.environment === 'object' && status.environment !== null && !status.environment.ok) {
						return makeResult('fail', `Binance trading is misconfigured: ${status.environment.reason || 'unknown'}`, null);
					}
					if (status.status === 'misconfigured' || status.configured === false) {
						return makeResult('fail', `Binance trading is misconfigured: ${status.reason || 'unknown'}`, null);
					}
					if (status.ready === false && status.status !== 'paused') {
						return makeResult('fail', `Binance trading is not ready: ${status.status || 'unknown'}`, null);
					}
					if (status.status === 'paused') {
						return makeResult('warn', `Binance trading is paused: ${status.pausedReason || 'runtime pause'}`, null);
					}
				}
			}
			return makeResult('pass', 'Binance trading credentials are configured');
		},
	});

	checks.push({
		id: 'channels.enabled',
		run: () => {
			const channels = [];
			if (toBoolean(process.env.ENABLE_TELEGRAM_BOT)) channels.push('telegram');
			if (toBoolean(process.env.ENABLE_WHATSAPP_ALERTS)) channels.push('whatsapp');
			if (toBoolean(process.env.ENABLE_DISCORD_ALERTS)) channels.push('discord');
			if (channels.length === 0) {
				return makeResult('warn', 'No outbound notification channels are enabled', null);
			}
			return makeResult('pass', `${channels.length} channel(s) enabled`, { channels });
		},
	});

	checks.push({
		id: 'rate_limiter.config',
		run: () => {
			const rawMax = process.env.RATE_LIMIT_MAX;
			const rawWindow = process.env.RATE_LIMIT_WINDOW_MS;
			const max = rawMax !== undefined && rawMax !== '' ? Number(rawMax) : 100;
			const window = rawWindow !== undefined && rawWindow !== '' ? Number(rawWindow) : 900000;
			if (!Number.isFinite(max) || max <= 0) return makeResult('fail', 'RATE_LIMIT_MAX is invalid', null);
			if (!Number.isFinite(window) || window <= 0) return makeResult('fail', 'RATE_LIMIT_WINDOW_MS is invalid', null);
			return makeResult('pass', 'Rate limiter is configured', { max, windowMs: window });
		},
	});

	checks.push({
		id: 'service.metadata',
		run: () => {
			return makeResult('pass', 'Service metadata is available', {
				name: 'cabros-bot',
				version: packageJson.version || '0.0.0',
				commit: getDeploymentCommit(),
				uptimeSec: Math.round(process.uptime()),
				nodeVersion: process.version,
			});
		},
	});

	return checks;
}

function summarize(checks) {
	const counts = { pass: 0, warn: 0, fail: 0, skipped: 0 };
	for (const check of checks) {
		counts[check.status] = (counts[check.status] || 0) + 1;
	}
	let status = 'pass';
	if (counts.fail > 0) status = 'fail';
	else if (counts.warn > 0) status = 'warn';
	return { status, summary: counts };
}

function buildResult({ checks, startedAt, finishedAt }) {
	const { status, summary } = summarize(checks);
	const meta = checks.find((c) => c.id === 'service.metadata');
	const service = meta && meta.evidence ? meta.evidence : null;
	return {
		status,
		summary,
		checks,
		service,
		startedAt,
		finishedAt,
		durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
	};
}

function createSelfTestService({ botOrGetter, getBinanceOrderService } = {}) {
	let lastResult = null;
	let lastRunAt = null;

	async function run({ only } = {}) {
		const startedAt = nowIso();
		const allChecks = buildChecks({ botOrGetter, getBinanceOrderService });
		const allowedIds = typeof only === 'string' && only.trim()
			? only.split(',').map((s) => s.trim()).filter(Boolean)
			: null;
		const selected = allowedIds
			? allChecks.filter((check) => allowedIds.includes(check.id))
			: allChecks;
		const unknownIds = allowedIds
			? allowedIds.filter((id) => !allChecks.some((check) => check.id === id))
			: [];

		if (selected.length === 0) {
			const finishedAt = nowIso();
			const empty = unknownIds.length > 0
				? [{ id: 'unknown', status: 'fail', message: `unknown checks: ${unknownIds.join(', ')}`, durationMs: 0 }]
				: [];
			const result = buildResult({ checks: empty, startedAt, finishedAt });
			lastResult = result;
			lastRunAt = finishedAt;
			return result;
		}

		const ran = await Promise.all(selected.map((check) => runCheck(check, { perCheckTimeoutMs: DEFAULT_PER_CHECK_TIMEOUT_MS })));
		if (unknownIds.length > 0) {
			ran.push({ id: 'unknown', status: 'fail', message: `unknown checks: ${unknownIds.join(', ')}`, durationMs: 0 });
		}
		const finishedAt = nowIso();
		const result = buildResult({ checks: ran, startedAt, finishedAt });
		lastResult = result;
		lastRunAt = finishedAt;
		return result;
	}

	function getLastResult() {
		if (!lastResult) return null;
		const ageMs = Date.now() - new Date(lastRunAt).getTime();
		if (ageMs > RESULT_TTL_MS) return { ...lastResult, expired: true };
		return lastResult;
	}

	function getStatus() {
		return {
			lastRunAt,
			lastStatus: lastResult ? lastResult.status : null,
			ttlSec: Math.round(RESULT_TTL_MS / 1000),
			ageMs: lastRunAt ? Date.now() - new Date(lastRunAt).getTime() : null,
		};
	}

	function updateDependencies({ botOrGetter: newBot, getBinanceOrderService: newBinance } = {}) {
		if (newBot !== undefined) botOrGetter = newBot;
		if (newBinance !== undefined) getBinanceOrderService = newBinance;
	}

	return { run, getLastResult, getStatus, updateDependencies };
}

module.exports = {
	createSelfTestService,
	DEFAULT_PER_CHECK_TIMEOUT_MS,
	DEFAULT_SUITE_TIMEOUT_MS,
	RESULT_TTL_MS,
	FIRESTORE_STORAGE_GATES,
};
