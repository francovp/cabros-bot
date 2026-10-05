#!/usr/bin/env node
'use strict';

/**
 * external-uptime-monitor.js
 *
 * Platform-independent production liveness monitor (GitHub issue #1107).
 *
 * Why this exists: on 2026-08-31 the hosting platform removed the production
 * deployment platform-side (Railway trial expiry) — the public URL started
 * answering `404 {"status":"error","code":404,"message":"Application not
 * found"}` — and nothing outside the platform noticed for six days. Any check
 * that lives *inside* the deployment (self-reported `/healthcheck`, the
 * in-repo smoke probe, an alert fired by the bot itself) is structurally blind
 * to that failure class, because there is nothing left running to report it.
 *
 * This monitor is therefore:
 *   - external     — it runs from GitHub Actions, not from the deployed service;
 *   - secretless   — it probes the public `/healthcheck` route, which `app.js`
 *                     mounts before `validateApiKey` and before the rate
 *                     limiter. It reads no API key and no application config, so
 *                     it can never degrade into a silent no-op because a secret
 *                     was not provisioned (the #971 failure class);
 *   - platform-neutral — it only needs an HTTP(S) base URL, so a migration from
 *                     Railway to Render (or anything else) is a repository
 *                     variable change, not a code change;
 *   - honest       — a `200` that is not the application payload is a FAILURE,
 *                     never a pass. A platform placeholder page or a proxy
 *                     interception must not read as "up".
 *
 * It is a liveness check only. Authenticated correctness (deployment freshness,
 * API-key-protected routes, dependency readiness) stays with
 * `ops/production-smoke-probe.sh`.
 *
 * Usage:
 *   node ops/external-uptime-monitor.js [--base-url=URL] [--timeout-ms=10000] \
 *       [--check-docs=true] [--healthcheck-path=/healthcheck] [--docs-path=/docs] \
 *       [--previous-conclusion=none] [--no-page]
 *
 * Exit codes (closed enum — the workflow and the docs depend on this map):
 *   0  UP                        production answered the healthcheck contract
 *   3  HEALTHCHECK_UNREACHABLE   DNS/connection failure, timeout, or non-200
 *   4  HEALTHCHECK_BODY_UNEXPECTED  200 that is not the application healthcheck
 *   5  DOCS_UNREACHABLE          public /docs did not serve the API contract
 *   6  BASE_URL_INVALID          missing, non-HTTP(S), or credential-bearing
 *   7  MONITOR_INTERNAL_ERROR    the monitor itself broke — still DOWN, never 0
 *
 * Alert routing (see docs/monitoring.md):
 *   - GitHub's own failed-workflow notification is the primary channel and needs
 *     no configuration at all.
 *   - Telegram admin paging is optional, fail-open, and only fires on a
 *     down→up state transition, never once per interval during a long outage.
 */

const fs = require('fs');

const DEFAULT_BASE_URL = 'https://cabros-bot-production.up.railway.app';
const DEFAULT_HEALTHCHECK_PATH = '/healthcheck';
const DEFAULT_DOCS_PATH = '/docs';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_PAGING_TIMEOUT_MS = 8000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';

const EXIT_CODES = {
	UP: 0,
	HEALTHCHECK_UNREACHABLE: 3,
	HEALTHCHECK_BODY_UNEXPECTED: 4,
	DOCS_UNREACHABLE: 5,
	BASE_URL_INVALID: 6,
	MONITOR_INTERNAL_ERROR: 7,
};

// Query-string markers rejected on `--base-url`. Monitoring runs from CI, so a
// credential pasted into the base URL would end up in job summaries and logs.
const CREDENTIAL_QUERY_MARKERS = [
	'api-key=',
	'x-api-key=',
	'token=',
	'access_token=',
	'sig=',
];

// GitHub run conclusions that mean "the previous monitor run did not pass".
// Anything else (success, skipped, neutral, none, unknown) is treated as
// "not currently failing", so the next failure pages as a down transition.
const FAILURE_CONCLUSIONS = new Set([
	'failure',
	'cancelled',
	'timed_out',
	'startup_failure',
	'action_required',
	'stale',
]);

const ALLOWED_PREVIOUS_CONCLUSIONS = new Set([
	...FAILURE_CONCLUSIONS,
	'success',
	'skipped',
	'neutral',
	'none',
	'unknown',
]);

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const MAX_BODY_BYTES = 64 * 1024;

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFlagValue(name, rawValue) {
	const value = typeof rawValue === 'string' ? rawValue : '';
	if (!value) {
		throw new Error(`Missing value for ${name}`);
	}
	return value;
}

function parseBoolean(value, fallback) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	if (typeof value === 'boolean') {
		return value;
	}
	const normalized = String(value).trim().toLowerCase();
	if (TRUTHY.has(normalized)) {
		return true;
	}
	if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	return fallback;
}

function parsePositiveInteger(value, fallback) {
	const parsed = Number.parseInt(String(value ?? '').trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

function normalizeConclusion(value) {
	const normalized = String(value ?? '').trim().toLowerCase();
	return ALLOWED_PREVIOUS_CONCLUSIONS.has(normalized) ? normalized : 'unknown';
}

function normalizePath(value, fallback) {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) {
		return fallback;
	}
	return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Parses CLI flags (argv) over environment defaults. Every knob has a default so
 * a missing repository variable degrades to a working default rather than to a
 * hollow monitor.
 */
function parseArgs(argv = [], env = {}) {
	const raw = {
		baseUrl: env.UPTIME_MONITOR_BASE_URL,
		timeoutMs: env.UPTIME_MONITOR_TIMEOUT_MS,
		checkDocs: env.UPTIME_MONITOR_CHECK_DOCS,
		healthcheckPath: env.UPTIME_MONITOR_HEALTHCHECK_PATH,
		docsPath: env.UPTIME_MONITOR_DOCS_PATH,
		previousConclusion: env.UPTIME_MONITOR_PREVIOUS_CONCLUSION,
		pagingDisabled: env.UPTIME_MONITOR_DISABLE_PAGE,
	};
	const flags = new Set();

	for (let index = 0; index < argv.length; index += 1) {
		const arg = String(argv[index]);
		if (!arg.startsWith('--')) {
			throw new Error(`Unsupported argument: ${arg}`);
		}
		const separator = arg.indexOf('=');
		const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
		let value = separator === -1 ? undefined : arg.slice(separator + 1);
		if (value === undefined && name !== 'no-page') {
			const next = argv[index + 1];
			if (next !== undefined && !String(next).startsWith('--')) {
				value = String(next);
				index += 1;
			}
		}
		switch (name) {
		case 'base-url':
			raw.baseUrl = normalizeFlagValue('--base-url', value);
			break;
		case 'timeout-ms':
			raw.timeoutMs = normalizeFlagValue('--timeout-ms', value);
			break;
		case 'check-docs':
			raw.checkDocs = normalizeFlagValue('--check-docs', value);
			break;
		case 'healthcheck-path':
			raw.healthcheckPath = normalizeFlagValue('--healthcheck-path', value);
			break;
		case 'docs-path':
			raw.docsPath = normalizeFlagValue('--docs-path', value);
			break;
		case 'previous-conclusion':
			raw.previousConclusion = normalizeFlagValue('--previous-conclusion', value);
			break;
		case 'no-page':
			raw.pagingDisabled = true;
			break;
		default:
			throw new Error(`Unsupported flag: --${name}`);
		}
		flags.add(name);
	}

	return resolveOptions({ ...raw, pagingDisabled: parseBoolean(raw.pagingDisabled, false) || flags.has('no-page') });
}

/**
 * Fills every default so a partial options object — or a missing repository
 * variable — can never produce an unprobed URL such as `https://hostundefined`.
 * An unprobed target must degrade to the documented default, never to a silent
 * no-op.
 */
function resolveOptions(input = {}, env = {}) {
	const raw = {
		baseUrl: input.baseUrl !== undefined ? input.baseUrl : env.UPTIME_MONITOR_BASE_URL,
		timeoutMs: input.timeoutMs !== undefined ? input.timeoutMs : env.UPTIME_MONITOR_TIMEOUT_MS,
		checkDocs: input.checkDocs !== undefined ? input.checkDocs : env.UPTIME_MONITOR_CHECK_DOCS,
		healthcheckPath: input.healthcheckPath !== undefined ? input.healthcheckPath : env.UPTIME_MONITOR_HEALTHCHECK_PATH,
		docsPath: input.docsPath !== undefined ? input.docsPath : env.UPTIME_MONITOR_DOCS_PATH,
		previousConclusion: input.previousConclusion !== undefined
			? input.previousConclusion
			: env.UPTIME_MONITOR_PREVIOUS_CONCLUSION,
		pagingDisabled: input.pagingDisabled !== undefined ? input.pagingDisabled : env.UPTIME_MONITOR_DISABLE_PAGE,
	};
	return {
		baseUrl: raw.baseUrl === undefined || String(raw.baseUrl).trim() === '' ? DEFAULT_BASE_URL : String(raw.baseUrl).trim(),
		timeoutMs: parsePositiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
		checkDocs: parseBoolean(raw.checkDocs, true),
		healthcheckPath: normalizePath(raw.healthcheckPath, DEFAULT_HEALTHCHECK_PATH),
		docsPath: normalizePath(raw.docsPath, DEFAULT_DOCS_PATH),
		previousConclusion: raw.previousConclusion === undefined || String(raw.previousConclusion).trim() === ''
			? 'none'
			: normalizeConclusion(raw.previousConclusion),
		pagingDisabled: parseBoolean(raw.pagingDisabled, false),
	};
}

/**
 * Reduces `--base-url` to a bare origin and rejects anything unsafe. Returns the
 * origin, or `{ error }` describing why the URL is unusable.
 */
function resolveBaseUrl(rawBaseUrl) {
	const candidate = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : '';
	if (!candidate) {
		return { error: 'base url is empty' };
	}
	let parsed;
	try {
		parsed = new URL(candidate);
	} catch (error) {
		return { error: 'base url is not a valid absolute URL' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { error: `unsupported protocol "${parsed.protocol}"` };
	}
	if (parsed.username || parsed.password) {
		return { error: 'base url must not embed credentials' };
	}
	const query = `${parsed.search}${parsed.hash}`.toLowerCase();
	const leaked = CREDENTIAL_QUERY_MARKERS.find((marker) => query.includes(marker));
	if (leaked) {
		return { error: `base url query string must not contain credentials (found "${markerLabel(leaked)}")` };
	}
	return { origin: `${parsed.protocol}//${parsed.host}` };
}

function markerLabel(marker) {
	if (marker === 'api-key=' || marker === 'x-api-key=') {
		return 'api-key';
	}
	return marker.replace('=', '');
}

function isAbortError(error) {
	return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

async function boundedText(response) {
	const body = await response.text();
	return typeof body === 'string' ? body.slice(0, MAX_BODY_BYTES) : '';
}

/**
 * Single bounded HTTP GET. Never throws: transport faults are returned as a
 * classified result so the caller can choose an exit code without a try/catch
 * ladder at every call site.
 */
async function fetchEndpoint(url, { timeoutMs, fetchImpl }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const startedAt = Date.now();
	try {
		const response = await fetchImpl(url, {
			method: 'GET',
			redirect: 'follow',
			signal: controller.signal,
		});
		const body = await boundedText(response);
		return {
			httpStatus: typeof response.status === 'number' ? response.status : null,
			body,
			reason: null,
			durationMs: Date.now() - startedAt,
		};
	} catch (error) {
		const timedOut = isAbortError(error) || controller.signal.aborted;
		return {
			httpStatus: null,
			body: '',
			reason: timedOut ? `timeout after ${timeoutMs}ms` : 'connection_failed',
			durationMs: Date.now() - startedAt,
		};
	} finally {
		clearTimeout(timer);
	}
}

function buildCheck(path, outcome) {
	return {
		path,
		httpStatus: outcome.httpStatus,
		ok: false,
		reason: outcome.reason || 'unknown',
	};
}

function parseJsonSafe(body) {
	try {
		return JSON.parse(body);
	} catch (error) {
		return null;
	}
}

/**
 * `/healthcheck` must answer 200 AND look like this application's liveness
 * payload (`{"uptime": <number>}`). A 200 from anything else — a platform
 * placeholder, a proxy interception page, a CDN interstitial — is a failure.
 */
function probeHealthcheck(baseUrl, options, fetchImpl) {
	return fetchEndpoint(`${baseUrl}${options.healthcheckPath}`, { timeoutMs: options.timeoutMs, fetchImpl })
		.then((outcome) => {
			const check = buildCheck(options.healthcheckPath, outcome);
			if (outcome.reason) {
				return { verdict: EXIT_CODES.HEALTHCHECK_UNREACHABLE, check };
			}
			if (outcome.httpStatus !== 200) {
				check.reason = `http_${outcome.httpStatus}`;
				return { verdict: EXIT_CODES.HEALTHCHECK_UNREACHABLE, check };
			}
			const payload = parseJsonSafe(outcome.body);
			if (!isPlainObject(payload) || typeof payload.uptime !== 'number') {
				check.reason = 'body_missing_uptime_field';
				return { verdict: EXIT_CODES.HEALTHCHECK_BODY_UNEXPECTED, check };
			}
			check.ok = true;
			check.reason = 'ok';
			return { verdict: EXIT_CODES.UP, check };
		});
}

/**
 * Secondary probe on the public `/docs` contract. It catches a routing or proxy
 * regression that still answers `/healthcheck` (a half-migrated ingress), which
 * a single-endpoint liveness check would report as healthy.
 */
function probeDocs(baseUrl, options, fetchImpl) {
	return fetchEndpoint(`${baseUrl}${options.docsPath}`, { timeoutMs: options.timeoutMs, fetchImpl })
		.then((outcome) => {
			const check = buildCheck(options.docsPath, outcome);
			if (outcome.reason) {
				return { verdict: EXIT_CODES.DOCS_UNREACHABLE, check };
			}
			if (outcome.httpStatus !== 200) {
				check.reason = `http_${outcome.httpStatus}`;
				return { verdict: EXIT_CODES.DOCS_UNREACHABLE, check };
			}
			if (!/swagger/i.test(outcome.body)) {
				check.reason = 'body_missing_swagger_marker';
				return { verdict: EXIT_CODES.DOCS_UNREACHABLE, check };
			}
			check.ok = true;
			check.reason = 'ok';
			return { verdict: EXIT_CODES.UP, check };
		});
}

function reasonNameForExitCode(exitCode) {
	const name = Object.keys(EXIT_CODES).find((key) => EXIT_CODES[key] === exitCode);
	return name || 'MONITOR_INTERNAL_ERROR';
}

function buildResult({ baseUrl, checks, verdict, startedAt, finishedAt }) {
	return {
		status: verdict === EXIT_CODES.UP ? 'up' : 'down',
		reason: reasonNameForExitCode(verdict),
		exitCode: verdict,
		baseUrl,
		checkedAt: new Date(finishedAt).toISOString(),
		durationMs: Math.max(0, finishedAt - startedAt),
		checks,
		paging: { attempted: false, delivered: false, reason: 'not_evaluated' },
	};
}

function buildInvalidBaseUrlResult(error) {
	const finishedAt = Date.now();
	return {
		status: 'down',
		reason: 'BASE_URL_INVALID',
		exitCode: EXIT_CODES.BASE_URL_INVALID,
		baseUrl: null,
		checkedAt: new Date(finishedAt).toISOString(),
		durationMs: 0,
		checks: [{ path: null, httpStatus: null, ok: false, reason: error }],
		paging: { attempted: false, delivered: false, reason: 'not_evaluated' },
	};
}

/**
 * Runs the probe and classifies the outcome. Never throws and never returns
 * `UP` after an unexpected fault — a broken monitor must report DOWN, because a
 * monitor that silently passes is the exact failure this issue is about.
 */
async function run(options = {}, deps = {}) {
	const fetchImpl = deps.fetchImpl || global.fetch;
	const now = deps.now || Date.now;
	const resolvedOptions = resolveOptions(options, deps.env);
	try {
		const startedAt = now();
		const resolved = resolveBaseUrl(resolvedOptions.baseUrl);
		if (resolved.error) {
			return buildInvalidBaseUrlResult(resolved.error);
		}
		const health = await probeHealthcheck(resolved.origin, resolvedOptions, fetchImpl);
		const checks = [health.check];
		let verdict = health.verdict;
		if (resolvedOptions.checkDocs !== false) {
			const docs = await probeDocs(resolved.origin, resolvedOptions, fetchImpl);
			checks.push(docs.check);
			if (verdict === EXIT_CODES.UP) {
				verdict = docs.verdict;
			}
		}
		return buildResult({
			baseUrl: resolved.origin,
			checks,
			verdict,
			startedAt,
			finishedAt: now(),
		});
	} catch (error) {
		console.warn('[uptime-monitor] unexpected internal failure:', error && error.message);
		const finishedAt = Date.now();
		return {
			status: 'down',
			reason: 'MONITOR_INTERNAL_ERROR',
			exitCode: EXIT_CODES.MONITOR_INTERNAL_ERROR,
			baseUrl: null,
			checkedAt: new Date(finishedAt).toISOString(),
			durationMs: 0,
			checks: [{ path: null, httpStatus: null, ok: false, reason: 'internal_error' }],
			paging: { attempted: false, delivered: false, reason: 'not_evaluated' },
		};
	}
}

/**
 * Pure state-transition decision for operator paging.
 *
 * Returns `'down'` on the first failing run after a passing/absent one,
 * `'recovered'` on the first passing run after a failing one, and `null`
 * otherwise. A continuing outage deliberately does NOT page on every interval:
 * GitHub already notifies on each failed scheduled run, and a page every five
 * minutes for six days is how an alert channel gets ignored.
 */
function shouldPage({ ok, previousConclusion }) {
	const previous = normalizeConclusion(previousConclusion);
	const wasFailing = FAILURE_CONCLUSIONS.has(previous);
	if (ok) {
		return wasFailing ? 'recovered' : null;
	}
	return wasFailing ? null : 'down';
}

function buildTelegramMessage(result, transition) {
	const endpointRows = result.checks
		.map((check) => {
			const label = check.path || 'base-url';
			const status = check.httpStatus === null ? 'no-response' : `HTTP ${check.httpStatus}`;
			return `• ${label} — ${status} (${check.reason})`;
		})
		.join('\n');
	if (transition === 'recovered') {
		return [
			'✅ <b>Uptime monitor: RECOVERED</b>',
			`Target: ${result.baseUrl || 'unset'}`,
			`Previous verdict: ${result.reason}`,
			`Probe duration: ${result.durationMs}ms`,
			endpointRows,
			'',
			'External uptime monitor (issue #1107) reports production answering again.',
		].join('\n');
	}
	return [
		'🔴 <b>Uptime monitor: DOWN</b>',
		`Target: ${result.baseUrl || 'unset'}`,
		`Verdict: ${result.reason} (exit ${result.exitCode})`,
		`Probe duration: ${result.durationMs}ms`,
		endpointRows,
		'',
		'External uptime monitor (issue #1107). This is an external HTTP probe of',
		'the public health endpoint, so it also fires when the hosting platform',
		'removes the deployment. Runbook: docs/monitoring.md',
	].join('\n');
}

async function sendTelegramPage({ env, text, fetchImpl, timeoutMs }) {
	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_PAGING_TIMEOUT_MS);
	try {
		const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
			signal: controller.signal,
		});
		const payload = parseJsonSafe(await boundedText(response));
		return response.status === 200 && isPlainObject(payload) && payload.ok === true;
	} catch (error) {
		// Never surface the error object: it can embed the request URL, which
		// carries the bot token.
		console.warn('[uptime-monitor] telegram paging failed:', isAbortError(error) ? 'timeout' : 'request_failed');
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fail-open paging. A paging failure must never change the probe verdict — the
 * job still fails, which is what triggers the GitHub notification.
 */
async function resolvePaging(result, options, deps) {
	const env = deps.env || {};
	const fetchImpl = deps.fetchImpl || global.fetch;
	if (options.pagingDisabled) {
		return { attempted: false, delivered: false, reason: 'paging_disabled' };
	}
	const transition = shouldPage({
		ok: result.status === 'up',
		previousConclusion: options.previousConclusion,
	});
	if (!transition) {
		return { attempted: false, delivered: false, reason: 'no_state_transition' };
	}
	if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID) {
		console.warn('[uptime-monitor] paging_not_configured: TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID unset');
		return { attempted: false, delivered: false, reason: 'paging_not_configured' };
	}
	const delivered = await sendTelegramPage({
		env,
		text: buildTelegramMessage(result, transition),
		fetchImpl,
		timeoutMs: options.timeoutMs,
	});
	return {
		attempted: true,
		delivered,
		reason: delivered ? 'page_sent' : 'paging_failed',
	};
}

function formatSummary(result) {
	const rows = result.checks
		.map((check) => {
			const endpoint = check.path || 'base-url';
			const http = check.httpStatus === null ? 'no response' : String(check.httpStatus);
			const verdict = check.ok ? 'ok' : 'FAILED';
			return `| \`${endpoint}\` | ${http} | ${verdict} | ${check.reason} |`;
		})
		.join('\n');
	return [
		'### External uptime monitor',
		'',
		`Target: \`${result.baseUrl || 'unset'}\``,
		`Verdict: **${result.reason}** (exit \`${result.exitCode}\`) in ${result.durationMs}ms`,
		`Paging: \`${result.paging.reason}\``,
		'',
		'| Endpoint | HTTP | Verdict | Detail |',
		'| --- | --- | --- | --- |',
		rows,
		'',
	].join('\n');
}

function appendStepSummary(env, result) {
	const target = env && env.GITHUB_STEP_SUMMARY;
	if (!target) {
		return;
	}
	try {
		fs.appendFileSync(target, formatSummary(result));
	} catch (error) {
		console.warn('[uptime-monitor] could not write step summary:', error && error.message);
	}
}

/**
 * CLI entrypoint. Writes exactly one single-line JSON object to stdout so the
 * workflow (and an operator running it locally) always gets a machine-readable
 * verdict, then renders the step summary and attempts optional paging.
 */
async function main(deps = {}) {
	// Defaults must come from the real process: the CLI entrypoint passes no
	// deps, and silently ignoring argv would make the monitor always probe the
	// default target no matter what the workflow asked for.
	const argv = deps.argv !== undefined ? deps.argv : process.argv.slice(2);
	const env = deps.env || process.env;
	const stdout = deps.stdout || process.stdout;
	const fetchImpl = deps.fetchImpl || global.fetch;

	let options;
	let result;
	try {
		options = parseArgs(argv, env);
		result = await run(options, { fetchImpl, env, now: deps.now });
	} catch (error) {
		console.warn('[uptime-monitor] failed to evaluate monitor:', error && error.message);
		// A monitor that cannot even parse its own arguments is still an outage
		// signal, so paging stays enabled for this path.
		options = { pagingDisabled: false, previousConclusion: 'unknown', timeoutMs: DEFAULT_TIMEOUT_MS };
		result = await run({ baseUrl: '' }, { fetchImpl, env, now: deps.now });
		result.reason = 'MONITOR_INTERNAL_ERROR';
		result.exitCode = EXIT_CODES.MONITOR_INTERNAL_ERROR;
		// The probe below only re-establishes that fetch works; it is not the
		// verdict, so it must not decide `status`. Leaving the recovered verdict
		// here emitted status 'up' beside a MONITOR_INTERNAL_ERROR and suppressed
		// the down page this path is meant to send.
		result.status = 'down';
	}

	try {
		result.paging = await resolvePaging(result, options, { env, fetchImpl });
	} catch (error) {
		console.warn('[uptime-monitor] paging raised, keeping probe verdict:', error && error.message);
		result.paging = { attempted: false, delivered: false, reason: 'paging_failed' };
	}

	stdout.write(`${JSON.stringify(result)}\n`);
	appendStepSummary(env, result);
	return result.exitCode;
}

module.exports = {
	CREDENTIAL_QUERY_MARKERS,
	DEFAULT_BASE_URL,
	DEFAULT_TIMEOUT_MS,
	EXIT_CODES,
	FAILURE_CONCLUSIONS,
	appendStepSummary,
	buildTelegramMessage,
	fetchEndpoint,
	formatSummary,
	main,
	parseArgs,
	probeDocs,
	resolveOptions,
	probeHealthcheck,
	resolveBaseUrl,
	run,
	sendTelegramPage,
	shouldPage,
};

if (require.main === module) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error('[uptime-monitor] fatal:', error && error.message);
			process.exitCode = EXIT_CODES.MONITOR_INTERNAL_ERROR;
		},
	);
}