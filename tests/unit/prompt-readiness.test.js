'use strict';

/**
 * Issue #1178 enables Langfuse dynamic prompts in production.
 *
 * Before this module, `dependencies.langfuse` on `/api/status` was
 * `dependencyStatus({ enabled, configured })`, which means `ready` was computed
 * from *env-var shape alone*. Flipping `ENABLE_LANGFUSE_PROMPTS=true` would
 * therefore have made a deployment report `ready: true` / `status: "ready"` at
 * boot even when:
 *
 *   - `@langfuse/client` could not be resolved,
 *   - the credentials were wrong, revoked, or pointed at the wrong project,
 *   - no prompt had ever been fetched successfully,
 *   - the `production` label was never published, so every `prompt.get()` 404s
 *     and every alert silently falls back to the local file.
 *
 * That last case is the important one: it is the default failure mode of this
 * exact enablement, and a shape-derived `ready` makes it invisible.
 *
 * This is the fifth instance of the repo's "shape is not readiness" rule, after
 * `firebaseRemoteConfig.ready` (#598), Firestore `readHealth` (#1285),
 * `equityMarketData.ready` (#1116) and `idempotencyStorage.ready` (#1111). Do not
 * fold `readiness` back into `configured`.
 */

const {
	REASONS,
	READINESS,
	PROBE_TIMEOUT_MS,
	MAX_TRACKED_PROMPTS,
	classifyPromptError,
	getPromptReadiness,
	resetPromptReadinessForTesting,
	recordPromptReadinessSafely,
} = require('../../src/services/prompts/promptReadiness');

function withEnv(overrides, fn) {
	const original = {};
	for (const [key, value] of Object.entries(overrides)) {
		original[key] = process.env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return fn();
	} finally {
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

const READY_ENV = {
	ENABLE_LANGFUSE_PROMPTS: 'true',
	LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
	LANGFUSE_SECRET_KEY: 'sk-lf-secret',
};

describe('promptReadiness', () => {
	beforeEach(() => {
		resetPromptReadinessForTesting();
	});

	afterEach(() => {
		resetPromptReadinessForTesting();
	});

	describe('closed error enum', () => {
		it('exposes every reason as a stable string constant', () => {
			expect(REASONS).toEqual({
				NOT_CONFIGURED: 'langfuse_not_configured',
				CLIENT_UNAVAILABLE: 'langfuse_client_unavailable',
				AUTH_FAILED: 'langfuse_auth_failed',
				PROMPT_NOT_FOUND: 'langfuse_prompt_not_found',
				TIMEOUT: 'langfuse_timeout',
				INVALID_RESPONSE: 'langfuse_invalid_response',
				UNAVAILABLE: 'langfuse_unavailable',
			});
		});

		it('classifies an authentication rejection distinctly from a transport failure', () => {
			// A wrong or revoked key is an operator-actionable misconfiguration, not a
			// blip. Collapsing it into `unavailable` would tell the operator to retry
			// something only a credential rotation can fix.
			expect(classifyPromptError({ statusCode: 401 })).toBe(REASONS.AUTH_FAILED);
			expect(classifyPromptError({ status: 401 })).toBe(REASONS.AUTH_FAILED);
			expect(classifyPromptError({ statusCode: 403 })).toBe(REASONS.AUTH_FAILED);
			expect(classifyPromptError({ statusCode: 404 })).toBe(REASONS.PROMPT_NOT_FOUND);
			expect(classifyPromptError({ statusCode: 429 })).toBe(REASONS.UNAVAILABLE);
			expect(classifyPromptError({ statusCode: 500 })).toBe(REASONS.UNAVAILABLE);
		});

		it('classifies an unpublished prompt label as prompt_not_found', () => {
			// The single most likely outcome of this enablement: prompts exist under
			// `latest` but were never published under `production`.
			expect(classifyPromptError(new Error('Prompt not found: alert-enrichment'))).toBe(
				REASONS.PROMPT_NOT_FOUND,
			);
			expect(classifyPromptError(new Error('404 not_found prompt'))).toBe(REASONS.PROMPT_NOT_FOUND);
		});

		it('classifies an unresolvable SDK and a deadline distinctly', () => {
			expect(classifyPromptError(new Error('LangfuseClient constructor could not be resolved'))).toBe(
				REASONS.CLIENT_UNAVAILABLE,
			);
			expect(classifyPromptError(Object.assign(new Error('timed out'), { name: 'AbortError' }))).toBe(
				REASONS.TIMEOUT,
			);
			expect(classifyPromptError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(
				REASONS.TIMEOUT,
			);
		});

		it('never lets an arbitrary provider message escape as a reason', () => {
			// A Langfuse error body can embed the project id, the base URL and the key.
			// `lastErrorReason` is a closed enum precisely so that text cannot reach
			// `/api/status`.
			expect(classifyPromptError(new Error('secret sk-lf-abcdef rejected for proj_12345'))).toBe(
				REASONS.UNAVAILABLE,
			);
			expect(classifyPromptError(null)).toBe(REASONS.UNAVAILABLE);
			expect(classifyPromptError({})).toBe(REASONS.UNAVAILABLE);
			expect(classifyPromptError({ statusCode: 'nonsense' })).toBe(REASONS.UNAVAILABLE);
		});

		it('passes through a reason that is already a known constant', () => {
			expect(classifyPromptError({ reason: REASONS.NOT_CONFIGURED })).toBe(REASONS.NOT_CONFIGURED);
			// An unknown `reason` field is not trusted.
			expect(classifyPromptError({ reason: 'sk-lf-leaked-secret' })).toBe(REASONS.UNAVAILABLE);
		});
	});

	describe('getStatus(): gate state wins over observed health', () => {
		it('reports disabled when the gate is off, even after successes were recorded', () => {
			withEnv({ ENABLE_LANGFUSE_PROMPTS: 'false' }, () => {
				getPromptReadiness().recordSuccess({ promptName: 'alert-enrichment', label: 'latest' });

				const status = getPromptReadiness().getStatus();
				expect(status.enabled).toBe(false);
				expect(status.ready).toBe(false);
				expect(status.status).toBe('disabled');
			});
		});

		it('reports misconfigured when the gate is on but a credential is missing', () => {
			withEnv({ ...READY_ENV, LANGFUSE_SECRET_KEY: '' }, () => {
				const status = getPromptReadiness().getStatus();
				expect(status.enabled).toBe(true);
				expect(status.configured).toBe(false);
				expect(status.ready).toBe(false);
				expect(status.status).toBe('misconfigured');
			});
		});

		it('treats a whitespace-only credential as missing', () => {
			withEnv({ ...READY_ENV, LANGFUSE_PUBLIC_KEY: '   ' }, () => {
				expect(getPromptReadiness().getStatus().configured).toBe(false);
			});
		});

		it('reports unverified when configured but nothing has been fetched yet', () => {
			withEnv(READY_ENV, () => {
				const status = getPromptReadiness().getStatus();
				expect(status.configured).toBe(true);
				// The regression this module exists to prevent.
				expect(status.ready).toBe(false);
				expect(status.status).toBe('unverified');
				expect(status.readiness).toBe(READINESS.UNVERIFIED);
			});
		});

		it('keeps a disabled gate from being reported as misconfigured', () => {
			withEnv({ ENABLE_LANGFUSE_PROMPTS: 'false', LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' }, () => {
				expect(getPromptReadiness().getStatus().status).toBe('disabled');
			});
		});
	});

	describe('readiness transitions', () => {
		it('moves unverified -> ready only after an observed successful fetch', () => {
			withEnv(READY_ENV, () => {
				expect(getPromptReadiness().getStatus().status).toBe('unverified');

				getPromptReadiness().recordAttempt();
				// An attempt alone is not evidence.
				expect(getPromptReadiness().getStatus().status).toBe('unverified');

				getPromptReadiness().recordSuccess({ promptName: 'alert-enrichment', label: 'production' });

				const status = getPromptReadiness().getStatus();
				expect(status.ready).toBe(true);
				expect(status.status).toBe('ready');
				expect(status.readiness).toBe(READINESS.VERIFIED);
				expect(status.promptsSucceeded).toBe(1);
				expect(status.lastSuccessAt).toEqual(expect.any(String));
			});
		});

		it('moves ready -> degraded on the first failure and self-heals on the next success', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordSuccess({ promptName: 'alert-enrichment', label: 'production' });
				expect(readiness.getStatus().status).toBe('ready');

				readiness.recordAttempt();
				readiness.recordFailure(REASONS.PROMPT_NOT_FOUND);
				const degraded = readiness.getStatus();
				expect(degraded.ready).toBe(false);
				expect(degraded.status).toBe('degraded');
				expect(degraded.readiness).toBe(READINESS.DEGRADED);
				expect(degraded.lastErrorReason).toBe(REASONS.PROMPT_NOT_FOUND);

				// Self-heal without a restart: the label can be published mid-incident.
				readiness.recordAttempt();
				readiness.recordSuccess({ promptName: 'alert-enrichment', label: 'production' });
				expect(readiness.getStatus().status).toBe('ready');
			});
		});

		it('never latches degraded: a later success clears consecutiveFailures', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				for (let i = 0; i < 5; i += 1) {
					readiness.recordAttempt();
					readiness.recordFailure(REASONS.TIMEOUT);
				}
				expect(readiness.getStatus().consecutiveFailures).toBe(5);

				readiness.recordAttempt();
				readiness.recordSuccess({ promptName: 'alert-enrichment', label: 'production' });

				const status = readiness.getStatus();
				expect(status.consecutiveFailures).toBe(0);
				expect(status.status).toBe('ready');
				expect(status.promptsFailed).toBe(5);
			});
		});

		it('reports degraded on a first-ever failure, matching the house readiness rule', () => {
			// `consecutiveFailures > 0 -> degraded` is the shared rule across
			// equityMarketData (#1116) and idempotencyStorage (#1111), and it is the
			// only verdict that works here: the startup probe is the very first
			// observation on a fresh process, so if a failed probe reported
			// `unverified` it would be indistinguishable from "nothing has tried yet",
			// which is the ambiguity this module exists to remove.
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordFailure(REASONS.AUTH_FAILED);

				const status = readiness.getStatus();
				expect(status.readiness).toBe(READINESS.DEGRADED);
				expect(status.ready).toBe(false);
				expect(status.status).toBe('degraded');
				expect(status.lastErrorReason).toBe(REASONS.AUTH_FAILED);
				expect(status.promptsFailed).toBe(1);
			});
		});

		it('counts a local fallback as an outcome of a failed remote attempt', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordFailure(REASONS.UNAVAILABLE);
				readiness.recordLocalFallback({ promptName: 'alert-enrichment' });

				const status = readiness.getStatus();
				expect(status.localFallbackCount).toBe(1);
				expect(status.localFallbackByPrompt['alert-enrichment']).toBe(1);
			});
		});
	});

	describe('per-prompt provenance', () => {
		it('separates langfuse and local counts per prompt so a partial rollout is visible', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordSuccess({ promptName: 'alert-enrichment', label: 'production', version: 12 });
				readiness.recordLocalFallback({ promptName: 'news-analysis' });

				const status = readiness.getStatus();
				expect(status.byPrompt['alert-enrichment']).toMatchObject({
					langfuse: 1,
					local: 0,
					failures: 0,
					lastLabel: 'production',
					lastVersion: 12,
				});
				expect(status.byPrompt['news-analysis']).toMatchObject({ langfuse: 0, local: 1, failures: 0 });
			});
		});

		it('bounds the per-prompt map so a hostile prompt name cannot grow it without limit', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				for (let i = 0; i < MAX_TRACKED_PROMPTS + 25; i += 1) {
					readiness.recordAttempt();
					readiness.recordSuccess({ promptName: `prompt-${i}` });
				}

				expect(Object.keys(readiness.getStatus().byPrompt).length).toBeLessThanOrEqual(MAX_TRACKED_PROMPTS);
			});
		});

		it('ignores a non-string or empty prompt name rather than indexing it as undefined', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordSuccess({ promptName: undefined });
				readiness.recordSuccess({ promptName: '   ' });

				expect(readiness.getStatus().byPrompt).toEqual({});
			});
		});
	});

	describe('secret safety', () => {
		it('never exposes a credential through getStatus()', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordFailure(classifyPromptError(new Error('auth failed for sk-lf-supersecret pk-lf-publickey')));

				const serialized = JSON.stringify(readiness.getStatus());
				expect(serialized).not.toContain('sk-lf-supersecret');
				expect(serialized).not.toContain('pk-lf-publickey');
				expect(serialized).not.toContain('LANGFUSE_SECRET_KEY');
			});
		});

		it('reports the configured base URL host but never the credentials', () => {
			withEnv({ ...READY_ENV, LANGFUSE_BASE_URL: 'https://cloud.langfuse.com' }, () => {
				const status = getPromptReadiness().getStatus();
				expect(status.baseUrlHost).toBe('cloud.langfuse.com');
			});
		});

		it('reports a null base URL host rather than throwing on a malformed base URL', () => {
			withEnv({ ...READY_ENV, LANGFUSE_BASE_URL: 'not a url' }, () => {
				expect(getPromptReadiness().getStatus().baseUrlHost).toBeNull();
			});
		});
	});

	describe('fail-open telemetry', () => {
		it('never lets a throwing recorder escape', () => {
			const readiness = getPromptReadiness();
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

			expect(() => recordPromptReadinessSafely(() => {
				throw new Error('counter exploded');
			})).not.toThrow();

			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});

		it('survives a malformed success payload', () => {
			const readiness = getPromptReadiness();
			expect(() => readiness.recordSuccess(null)).not.toThrow();
			expect(() => readiness.recordFailure(undefined)).not.toThrow();
			expect(readiness.getStatus().lastErrorReason).toBe(REASONS.UNAVAILABLE);
		});
	});

	describe('status reads', () => {
		it('never register an attempt: a status read is not a durable-use attempt', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.getStatus();
				readiness.getStatus();
				readiness.getStatus();

				expect(readiness.getStatus().promptsAttempted).toBe(0);
			});
		});

		it('keeps promptsFailed <= promptsAttempted after a rejected client construction', () => {
			// Asking for a remote prompt and not getting one is the event an operator
			// needs to see, so it is counted as an attempt even when initialization
			// itself was refused.
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordFailure(REASONS.CLIENT_UNAVAILABLE);

				const status = readiness.getStatus();
				expect(status.promptsAttempted).toBe(1);
				expect(status.promptsFailed).toBe(1);
				expect(status.promptsFailed).toBeLessThanOrEqual(status.promptsAttempted);
			});
		});
	});

	describe('reset', () => {
		it('clears every counter, timestamp, reason and per-prompt entry', () => {
			withEnv(READY_ENV, () => {
				const readiness = getPromptReadiness();
				readiness.recordAttempt();
				readiness.recordSuccess({ promptName: 'alert-enrichment', label: 'production', version: 3 });
				readiness.recordAttempt();
				readiness.recordFailure(REASONS.TIMEOUT);
				readiness.recordLocalFallback({ promptName: 'news-analysis' });

				resetPromptReadinessForTesting();

				const status = readiness.getStatus();
				expect(status.promptsAttempted).toBe(0);
				expect(status.promptsSucceeded).toBe(0);
				expect(status.promptsFailed).toBe(0);
				expect(status.consecutiveFailures).toBe(0);
				expect(status.localFallbackCount).toBe(0);
				expect(status.lastSuccessAt).toBeNull();
				expect(status.lastFailureAt).toBeNull();
				expect(status.lastErrorReason).toBeNull();
				expect(status.byPrompt).toEqual({});
				expect(status.localFallbackByPrompt).toEqual({});
			});
		});
	});

	describe('bounded startup probe', () => {
		it('exposes a bounded timeout so a half-open Langfuse cannot stall boot', () => {
			expect(typeof PROBE_TIMEOUT_MS).toBe('number');
			expect(Number.isFinite(PROBE_TIMEOUT_MS)).toBe(true);
			expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
			expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30000);
		});
	});
});
