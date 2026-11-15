'use strict';

/**
 * Issue #1178 enables Langfuse dynamic prompts in production.
 *
 * `dependencies.langfuse.ready` was previously derived from env-var shape alone
 * (`dependencyStatus({ enabled, configured })`), so flipping
 * `ENABLE_LANGFUSE_PROMPTS=true` would report `ready: true` at boot even when the
 * credentials were wrong, `@langfuse/client` was unresolvable, or the
 * `production` label was never published and every fetch fell back to the local
 * file. That last case is the default failure mode of this enablement and a
 * shape-derived `ready` makes it invisible.
 *
 * Fifth instance of the repo's "shape is not readiness" rule, after
 * `firebaseRemoteConfig.ready` (#598), Firestore `readHealth` (#1285),
 * `equityMarketData.ready` (#1116) and `idempotencyStorage.ready` (#1111). Do not
 * fold `readiness` back into `configured`.
 *
 * Counters are process-local and reset on restart; every recorder is fail-open so
 * telemetry can never block alert delivery.
 */

const REASONS = Object.freeze({
	NOT_CONFIGURED: 'langfuse_not_configured',
	CLIENT_UNAVAILABLE: 'langfuse_client_unavailable',
	AUTH_FAILED: 'langfuse_auth_failed',
	PROMPT_NOT_FOUND: 'langfuse_prompt_not_found',
	TIMEOUT: 'langfuse_timeout',
	INVALID_RESPONSE: 'langfuse_invalid_response',
	UNAVAILABLE: 'langfuse_unavailable',
});

const READINESS = Object.freeze({
	UNVERIFIED: 'unverified',
	VERIFIED: 'verified',
	DEGRADED: 'degraded',
});

const KNOWN_REASONS = new Set(Object.values(REASONS));
const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';
const PROBE_TIMEOUT_MS = 5000;
const MAX_TRACKED_PROMPTS = 64;
const MAX_PROMPTS_TO_PROBE = 10;

const HTTP_STATUS_REASONS = new Map([
	[401, REASONS.AUTH_FAILED],
	[403, REASONS.AUTH_FAILED],
	[404, REASONS.PROMPT_NOT_FOUND],
]);

function normalizeReason(reason) {
	return typeof reason === 'string' && KNOWN_REASONS.has(reason) ? reason : REASONS.UNAVAILABLE;
}

function readStatusCode(error) {
	if (!error || typeof error !== 'object') {
		return null;
	}

	for (const field of ['statusCode', 'status']) {
		const value = error[field];
		if (Number.isInteger(value)) {
			return value;
		}
	}

	return null;
}

/**
 * A Langfuse error body can embed the project id, the base URL and the API key, so
 * the raw message is never used as a status value: an unrecognized failure
 * collapses to `langfuse_unavailable` and only the closed enum reaches
 * `/api/status`.
 */
function classifyPromptError(error) {
	if (!error) {
		return REASONS.UNAVAILABLE;
	}

	if (typeof error === 'object' && typeof error.reason === 'string' && KNOWN_REASONS.has(error.reason)) {
		return error.reason;
	}

	const statusCode = readStatusCode(error);
	if (statusCode !== null && HTTP_STATUS_REASONS.has(statusCode)) {
		return HTTP_STATUS_REASONS.get(statusCode);
	}

	const name = error && typeof error.name === 'string' ? error.name : '';
	if (name === 'AbortError' || name === 'TimeoutError') {
		return REASONS.TIMEOUT;
	}

	const message = (error && typeof error.message === 'string' ? error.message : '')
		.toLowerCase();

	if (message.includes('could not be resolved') || message.includes('cannot find module')) {
		return REASONS.CLIENT_UNAVAILABLE;
	}
	if (message.includes('timed out') || message.includes('timeout') || message.includes('aborted')) {
		return REASONS.TIMEOUT;
	}
	if (
		message.includes('prompt not found')
		|| message.includes('prompt_not_found')
		|| message.includes('not_found prompt')
	) {
		return REASONS.PROMPT_NOT_FOUND;
	}
	if (
		message.includes('unauthorized')
		|| message.includes('forbidden')
		|| message.includes('authentication')
		|| message.includes('invalid api key')
	) {
		return REASONS.AUTH_FAILED;
	}
	if (message.includes('required when enable_langfuse_prompts')) {
		return REASONS.NOT_CONFIGURED;
	}

	return REASONS.UNAVAILABLE;
}

function isEnabled(value) {
	return value === 'true';
}

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function readBaseUrl() {
	const raw = process.env.LANGFUSE_BASE_URL;
	return hasValue(raw) ? raw : DEFAULT_BASE_URL;
}

/**
 * Only the host is reported. A base URL can carry an embedded credential or a
 * path token, and this value is surfaced on `/api/status`.
 */
function readBaseUrlHost() {
	try {
		return new URL(readBaseUrl()).host || null;
	} catch {
		return null;
	}
}

function readConfig() {
	const enabled = isEnabled(process.env.ENABLE_LANGFUSE_PROMPTS);
	return {
		enabled,
		// Credential shape only: a typo'd, revoked or wrong-project key satisfies
		// this and still cannot fetch a single prompt.
		configured: hasValue(process.env.LANGFUSE_PUBLIC_KEY) && hasValue(process.env.LANGFUSE_SECRET_KEY),
		label: hasValue(process.env.LANGFUSE_PROMPT_LABEL)
			? process.env.LANGFUSE_PROMPT_LABEL
			: null,
		cacheTtlSeconds: Number.parseInt(process.env.LANGFUSE_PROMPT_CACHE_TTL_SECONDS, 10),
		baseUrlHost: readBaseUrlHost(),
	};
}

function normalizePromptName(promptName) {
	if (typeof promptName !== 'string') {
		return null;
	}

	const trimmed = promptName.trim();
	return trimmed.length > 0 ? trimmed : null;
}

// A default parameter only applies to `undefined`, so a caller passing `null`
// would make the destructuring throw. Telemetry must never reject a prompt
// resolution, so the payload is normalized instead of destructured.
function normalizePayload(payload) {
	return payload && typeof payload === 'object' ? payload : {};
}

class PromptReadiness {
	constructor() {
		this.reset();
	}

	reset() {
		this.promptsAttempted = 0;
		this.promptsSucceeded = 0;
		this.promptsFailed = 0;
		this.localFallbackCount = 0;
		this.consecutiveFailures = 0;
		this.lastSuccessAt = null;
		this.lastFailureAt = null;
		this.lastErrorReason = null;
		this.byPrompt = new Map();
	}

	_ensurePrompt(promptName) {
		const name = normalizePromptName(promptName);
		if (!name) {
			return null;
		}

		let entry = this.byPrompt.get(name);
		if (!entry) {
			if (this.byPrompt.size >= MAX_TRACKED_PROMPTS) {
				const oldest = this.byPrompt.keys().next().value;
				this.byPrompt.delete(oldest);
			}
			entry = { langfuse: 0, local: 0, failures: 0, lastLabel: null, lastVersion: null, lastErrorReason: null };
			this.byPrompt.set(name, entry);
		}

		return entry;
	}

	recordAttempt() {
		this.promptsAttempted += 1;
	}

	recordSuccess(payload) {
		const { promptName, label, version } = normalizePayload(payload);

		this.promptsSucceeded += 1;
		this.consecutiveFailures = 0;
		this.lastSuccessAt = new Date().toISOString();

		const entry = this._ensurePrompt(promptName);
		if (entry) {
			entry.langfuse += 1;
			entry.lastLabel = hasValue(label) ? label : null;
			entry.lastVersion = Number.isInteger(version) ? version : null;
			entry.lastErrorReason = null;
		}
	}

	recordFailure(reason) {
		this.promptsFailed += 1;
		this.consecutiveFailures += 1;
		this.lastFailureAt = new Date().toISOString();
		this.lastErrorReason = normalizeReason(reason);
	}

	recordLocalFallback(payload) {
		const { promptName } = normalizePayload(payload);
		this.localFallbackCount += 1;

		const entry = this._ensurePrompt(promptName);
		if (entry) {
			entry.local += 1;
		}
	}

	/**
	 * `consecutiveFailures > 0 -> degraded` is the shared rule across
	 * equityMarketData (#1116) and idempotencyStorage (#1111), and it is the only
	 * verdict that works here: the startup probe is the very first observation on a
	 * fresh process, so if a failed probe reported `unverified` it would be
	 * indistinguishable from "nothing has tried yet", which is the ambiguity this
	 * module exists to remove.
	 */
	resolveReadiness() {
		if (this.consecutiveFailures > 0) {
			return READINESS.DEGRADED;
		}
		if (this.promptsSucceeded > 0) {
			return READINESS.VERIFIED;
		}
		return READINESS.UNVERIFIED;
	}

	getStatus() {
		const config = readConfig();
		const readiness = this.resolveReadiness();

		let status;
		if (!config.enabled) {
			status = 'disabled';
		} else if (!config.configured) {
			status = 'misconfigured';
		} else if (readiness === READINESS.DEGRADED) {
			status = 'degraded';
		} else if (readiness === READINESS.VERIFIED) {
			status = 'ready';
		} else {
			status = READINESS.UNVERIFIED;
		}

		const byPrompt = {};
		for (const [name, entry] of this.byPrompt.entries()) {
			byPrompt[name] = { ...entry };
		}

		const localFallbackByPrompt = {};
		for (const [name, entry] of this.byPrompt.entries()) {
			if (entry.local > 0) {
				localFallbackByPrompt[name] = entry.local;
			}
		}

		return {
			enabled: config.enabled,
			configured: config.configured,
			ready: status === 'ready',
			status,
			readiness,
			failOpen: true,
			baseUrlHost: config.baseUrlHost,
			label: config.label,
			cacheTtlSeconds: Number.isFinite(config.cacheTtlSeconds) ? config.cacheTtlSeconds : null,
			promptsAttempted: this.promptsAttempted,
			promptsSucceeded: this.promptsSucceeded,
			promptsFailed: this.promptsFailed,
			localFallbackCount: this.localFallbackCount,
			consecutiveFailures: this.consecutiveFailures,
			lastSuccessAt: this.lastSuccessAt,
			lastFailureAt: this.lastFailureAt,
			lastErrorReason: this.lastErrorReason,
			byPrompt,
			localFallbackByPrompt,
		};
	}
}

let instance = null;

function getPromptReadiness() {
	if (!instance) {
		instance = new PromptReadiness();
	}

	return instance;
}

function resetPromptReadinessForTesting() {
	if (instance) {
		// In place, matching `_resetReadinessForTesting` in EquityMarketDataService: a
		// caller that captured `getPromptReadiness()` before the reset must keep
		// observing the same instance, and there is never a window with two.
		instance.reset();
		return;
	}

	instance = new PromptReadiness();
}

// Telemetry must never be able to fail a prompt resolution: every readiness
// mutation runs through this guard so a counter error cannot reject a caller.
function recordPromptReadinessSafely(record) {
	try {
		record();
	} catch (error) {
		console.warn('[promptReadiness] readiness recording failed:', error && error.message);
	}
}

function withProbeDeadline(fn, timeoutMs = PROBE_TIMEOUT_MS) {
	return new Promise(resolve => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			recordPromptReadinessSafely(() => getPromptReadiness().recordFailure(REASONS.TIMEOUT));
			resolve();
		}, timeoutMs);

		// A probe timer must never hold the process open.
		if (typeof timer.unref === 'function') {
			timer.unref();
		}

		Promise.resolve()
			.then(fn)
			.catch(error => {
				if (!settled) {
					recordPromptReadinessSafely(
						() => getPromptReadiness().recordFailure(classifyPromptError(error)),
					);
				}
			})
			.then(() => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve();
			});
	});
}

/**
 * Bounded, fail-open, non-blocking startup probe.
 *
 * Without it, `ready` stays `unverified` until an alert actually flows, so an idle
 * deployment cannot distinguish "working" from "credentials are fine but the
 * `production` label was never published and every prompt is falling back to the
 * local file". Returns false when the gate is off; never rejects.
 */
async function probePromptReadiness({ resolver, promptNames, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	const config = readConfig();
	if (!config.enabled) {
		return false;
	}

	if (typeof resolver !== 'function') {
		return false;
	}

	const names = Array.isArray(promptNames) ? promptNames.slice(0, MAX_PROMPTS_TO_PROBE) : [];
	if (names.length === 0) {
		return false;
	}

	await withProbeDeadline(async () => {
		for (const promptName of names) {
			await resolver(promptName);
		}
	}, timeoutMs);

	return true;
}

module.exports = {
	REASONS,
	READINESS,
	DEFAULT_BASE_URL,
	PROBE_TIMEOUT_MS,
	MAX_TRACKED_PROMPTS,
	MAX_PROMPTS_TO_PROBE,
	classifyPromptError,
	readConfig,
	getPromptReadiness,
	resetPromptReadinessForTesting,
	recordPromptReadinessSafely,
	probePromptReadiness,
	PromptReadiness,
};
