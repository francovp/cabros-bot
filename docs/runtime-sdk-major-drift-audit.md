# Runtime SDK Major Drift Audit & Compatibility Policy

**Reference Issue:** [#1170](https://github.com/francovp/cabros-bot/issues/1170) — *chore(deps): audit untracked major SDK drift in runtime integrations*  
**Date Established:** 2026-09-20  
**Status:** Active Policy  
**Revisit Date:** 2026-12-31 (or upon formal upstream deprecation announcements)

---

## 1. Executive Summary

Cabros Bot is an automated alerting and trading decision-support service operating continuously across Telegram, WhatsApp, and Discord. The service maintains strict reliability and safety invariants:
- Zero blocking of core alert delivery on external service failure (fail-open / fail-safe).
- Timing-safe authentication (`validateApiKey`, Firebase Admin ID token verification).
- Deterministic Binance Spot order execution with client-order reconciliation and exchange filter validation.
- Native `fetch` with bounded `AbortController` timeouts (Axios strictly forbidden).
- CommonJS module runtime (`require`) targeting Node `24.18.0` with `pnpm 10.34.1`.

This audit catalogs every major runtime SDK with untracked semver-major drift between the locked dependency version in `pnpm-lock.yaml` and the latest upstream npm registry release.

Per the alignment plan in GH-1170:
1. **Registry availability alone does not authorize dependency upgrades.**
2. Major runtime SDKs are **held on their current stable major versions** with explicit ignore rules configured in `.github/dependabot.yml`.
3. Any future major SDK migration must occur in an **isolated, dedicated pull request** with targeted regression coverage rather than bulk upgrades.
4. `package.json` and `pnpm-lock.yaml` remain frozen-install consistent.

---

## 2. Runtime SDK Drift Inventory & Compatibility Holds

| Runtime Package | Locked Version | Suggested Latest | Code Surface / Service Role | Decision | Revisit Date |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `@google/genai` | `1.34.0` | `2.23.0` | `src/services/grounding/gemini.js` (Grounding & LLM analysis) | **Compatibility Hold** | 2026-12-31 |
| `firebase-admin` | `12.7.0` | `14.4.0` | Firestore persistence, Admin Auth, Remote Config | **Compatibility Hold** | 2026-12-31 |
| `bullmq` | `5.81.3` | `6.3.8` | `src/services/jobs/JobQueue.js`, worker execution | **Compatibility Hold** | 2026-12-31 |
| `ioredis` | `5.11.1` | `6.0.0` | Redis client backing BullMQ queue & worker | **Compatibility Hold** | 2026-12-31 |
| `openai` | `4.104.0` | `7.20.0` | `src/services/grounding/cloudflareAiGateway.js` | **Compatibility Hold** | 2026-12-31 |
| `binance` | `2.15.22` | `3.6.5` | Crypto price lookup, gated Spot order execution | **Compatibility Hold** | 2026-12-31 |
| `undici` | `6.29.0` | `8.11.2` | Native fetch dispatcher & connection pool agent | **Compatibility Hold** | 2026-12-31 |
| `uuid` | `11.1.1` | `14.0.2` | Request tracing, job IDs, idempotency deduplication | **Compatibility Hold** | 2026-12-31 |
| `helmet` | `7.2.0` | `8.3.0` | Express security headers & CSP middleware | **Compatibility Hold** | 2026-12-31 |
| `dotenv` | `16.6.1` | `18.0.1` | Application environment initialization | **Compatibility Hold** | 2026-12-31 |
| `express` | `4.22.1` | `5.2.1` | Core HTTP application framework (GH-558, closed by PR #908) | **Compatibility Hold** | 2026-12-31 |

---

## 3. Detailed Technical Assessment per Package

### 3.1. `@google/genai` (1.34.0 → 2.x)
- **Role:** Primary LLM grounding and market news analysis engine.
- **Breaking Changes:** Version 2.x fundamentally restructures client initialization (`GoogleGenAI` constructor), alters method names for content generation, restructures system instruction configuration, and modifies safety rating structures.
- **Risk Assessment:** High. An unverified migration would break news sentiment analysis, alert grounding enrichment, and prompt token accounting.
- **Compatibility Hold Rationale:** The current v1 integration is stable, robustly tested, and fully aligned with Gemini API requirements.
- **Revisit Trigger:** Upstream v1 API deprecation notice or official requirement for Gemini 2.5/3 features.
- **Verification Requirement:** Run `tests/unit/gemini.test.js`, test fallback to Brave Search / heuristic scoring, verify token usage reporting.

### 3.2. `firebase-admin` (12.7.0 → 14.x)
- **Role:** Firestore database persistence (`alerts`, `scannerPresets`, `signalOutcomes`), Firebase ID-token verification for web admin console, and Remote Config server template publishing.
- **Breaking Changes:** Drops support for Node < 18, alters Firestore internal types and error handling, deprecates legacy credential loaders, and changes Remote Config template validation responses.
- **Risk Assessment:** High. Persistence failure could prevent alert recording or crash idempotency checks; token verification changes could lock operators out of `/admin`.
- **Compatibility Hold Rationale:** Firestore write sanitization (stripping `undefined` properties), idempotency claims, and transaction leases are battle-tested on v12.
- **Revisit Trigger:** Node engine upgrade or Firebase Admin v12 end-of-life.
- **Verification Requirement:** `pnpm test:firebase` against local emulator suite, test ID-token verification, test Remote Config retrieval and publishing.
- **Advisory Note (#872):** The critical `protobufjs` RCE (`GHSA-xq3m-2v4x-88gg`) on the Firestore wire decoder is cleared by a pinned transitive version, **not** by this migration. The 12 → 14 move relocates `admin.credential` to top-level `cert`/`applicationDefault` and drops `admin.firestore` as a property, breaking every storage service at runtime while the mocked test suite stays green. See Section 4.1.

### 3.3. `bullmq` (5.81.3 → 6.x) & `ioredis` (5.11.1 → 6.x)
- **Role:** Asynchronous job queue for background TradingView technical analysis and Render worker processing.
- **Breaking Changes:** BullMQ v6 introduces changes to Redis Lua script hash handling, queue options, worker concurrency event loops, and requires modern ioredis versioning. ioredis v6 drops legacy cluster/sentinel options and updates Promise rejection behaviors.
- **Risk Assessment:** Medium-High. Can cause stalled jobs, worker starvation, or silent unhandled Promise rejections during shutdown.
- **Compatibility Hold Rationale:** Current queue implementation handles graceful worker drain on `SIGTERM`/`SIGINT` without dropped jobs.
- **Revisit Trigger:** Redis 8 / Valkey compatibility requirements or BullMQ v5 maintenance cessation.
- **Verification Requirement:** BullMQ queue creation, job completion, task progress reporting, worker drain on SIGTERM.

### 3.4. `openai` (4.104.0 → 7.x)
- **Role:** Cloudflare AI Gateway secondary LLM client provider.
- **Breaking Changes:** v5 through v7 introduce major changes to client configuration, streaming response iterables, error hierarchy types, and request timeouts.
- **Risk Assessment:** Medium. Secondary LLM provider must fail-open without blocking alert pipelines.
- **Compatibility Hold Rationale:** Current v4 integration cleanly maps Cloudflare AI Gateway endpoints with timeout budgets and secret redaction.
- **Revisit Trigger:** Cloudflare AI Gateway API schema updates or OpenAI v4 deprecation.
- **Verification Requirement:** Focused tests in `tests/unit/cloudflareAiGateway.test.js` verifying timeout handling and fail-open fallbacks.

### 3.5. `binance` (2.15.22 → 3.x)
- **Role:** Live cryptocurrency price resolution and operator-gated Binance Spot order execution.
- **Breaking Changes:** v3 changes constructor parameter shapes, default base URLs, response beautification flags (`beautifyResponses`), timestamp synchronization, and request signing helpers.
- **Risk Assessment:** Critical. Flaws in order placement, filter validation, or client-order reconciliation can result in real financial loss or invalid trades.
- **Compatibility Hold Rationale:** Binance Spot order workflows require exact request matching, raw decimal response values, deterministic client-order reconciliation, and zero unverified changes to exchange-info filter validation.
- **Revisit Trigger:** Binance API protocol migration or Spot API breaking revisions.
- **Verification Requirement:** `tests/unit/binanceOrders.test.js`, dry-run order validation, filter step-size arithmetic, and price resolution tests.

### 3.6. `undici` (6.29.0 → 8.x)
- **Role:** Custom HTTP dispatcher and connection pooling agent for external requests.
- **Breaking Changes:** v7/v8 modifies Dispatcher pool lifecycle, request options, and error classes.
- **Risk Assessment:** Medium. Affects global HTTP timeout handling and connection reuse.
- **Compatibility Hold Rationale:** v6.29.0 is tightly integrated with Node 24 native `fetch` and custom pool configurations. Bumped from 6.28.0 by #872 for `GHSA-rfgv-xxqx-mfg5`; still the 6.x line.
- **Revisit Trigger:** Node.js native fetch upgrades or HTTP/2 requirement changes.
- **Verification Requirement:** Verify timeout handling, connection keep-alive, and proxy support.

### 3.7. `uuid` (11.1.1 → 14.x)
- **Role:** Generates unique request IDs, job IDs, replay IDs, and idempotency keys.
- **Breaking Changes:** Major releases starting from v12 dropped legacy CommonJS export patterns in favor of ESM conditional exports.
- **Risk Assessment:** High (runtime import break). In a CommonJS project (`"main": "index.js"`), importing a pure ESM `uuid` package causes immediate `ERR_REQUIRE_ESM` crash on startup.
- **Compatibility Hold Rationale:** v11.1.1 provides full CommonJS compatibility (`const { v4: uuidv4 } = require('uuid')`).
- **Revisit Trigger:** Full repository ESM migration (if ever scheduled).
- **Verification Requirement:** Confirm `uuidv4()` continues to generate RFC4122 v4 UUIDs across CommonJS imports.

### 3.8. `helmet` (7.2.0 → 8.x)
- **Role:** Sets HTTP security headers (CSP, HSTS, X-Frame-Options) for Express.
- **Breaking Changes:** v8 updates default Content Security Policy (CSP) directives and removes deprecated header middleware options.
- **Risk Assessment:** Low-Medium. Breaking CSP changes can block Swagger UI `/docs` or browser admin console assets.
- **Compatibility Hold Rationale:** Current CSP is tuned to allow Swagger UI and internal dashboard styles/scripts without console warnings.
- **Revisit Trigger:** Web security compliance audit or browser deprecation of legacy headers.
- **Verification Requirement:** Verify `/docs` and `/admin` asset loading without CSP violations; verify security headers via `tests/integration/healthcheck.test.js`.

### 3.9. `dotenv` (16.6.1 → 18.x)
- **Role:** Loads local `.env` configuration during development and testing.
- **Breaking Changes:** v17/v18 changes handling of multiline strings, variable expansion, and encoding.
- **Risk Assessment:** Low.
- **Compatibility Hold Rationale:** Stable environment loading without unintended variable substitution.
- **Revisit Trigger:** Next annual dependency review.
- **Verification Requirement:** `node scripts/validate-env.js` and test suite execution.

---

## 4. Dependabot Configuration & Automation Protection

To prevent noisy, failing, or dangerous automated pull requests from breaking CI, `.github/dependabot.yml` explicitly ignores `version-update:semver-major` for all audited runtime SDKs.

Weekly Dependabot scans will continue to open pull requests for **patch** and **minor** updates, ensuring security fixes and non-breaking improvements are reviewed and merged promptly.

Any major SDK version upgrade must be conducted via a human- or agent-led migration initiative adhering to the verification checklist outlined in Section 3.

### 4.1 Advisory Remediation Without a Major Migration (Issue #872)

An advisory against a locked version does **not** by itself authorize a semver-major migration.
Criterion 4 of Section 5 promotes a package for *attention*, but the remedy for most advisories is
a pinned transitive version, not a framework change. The gate is:

```bash
pnpm run audit:gate   # must exit 0; equivalent to `pnpm audit --audit-level=high`
```

The gate is a **separate command, not part of `pnpm test`**, because it queries the npm registry
while the default Jest suite is documented to need no external network access. CI runs
`pnpm run audit:gate` as its own step. It exits `1` on any high or critical advisory, and `2` when
the audit report cannot be parsed — a registry outage must never be reported as a clean tree.

**Where an override is declared.** pnpm 10 reads `overrides` and `auditConfig` from
`pnpm-workspace.yaml`. The `pnpm` field in `package.json` is *ignored* — pnpm prints a warning and
silently skips it, so an override placed there is inert while appearing configured.
`tests/unit/dependency-advisory-remediation.test.js` fails if a `pnpm.overrides` block reappears in
`package.json`, because that failure mode is invisible until an advisory returns.

**Order of preference.** Escalate in this order, and stop at the first step that clears the
advisory:

1. **Patch or minor bump of the direct dependency.** Always preferred; no override needed.
2. **Scoped transitive override** in `pnpm-workspace.yaml` (`parent>child` when a bare name would
   drag an unrelated major onto a caller). `express>path-to-regexp: 0.1.13` is the worked example:
   it clears the Express 4 route ReDoS without the Express 5 migration Section 3 treats as a
   first-party decision.
3. **Drop an unused optional dependency** with `-`. `binance` declares `webpack`, `ts-loader`,
   `source-map-loader` and `webpack-cli` as *optional* — they exist to build the published package
   and are never exercised by consuming it. Removing them deleted 44 packages and, with them, the
   unpatchable `braces` advisory that no version bump could ever fix.
4. **`auditConfig.ignoreGhsas`** — last resort, and only with a written reachability argument
   recorded next to the ignore in `pnpm-workspace.yaml`.

**A pin that fixes an advisory must not break a consumer that calls it.** The `minimatch` case is
the worked example of why step 2 says *scoped*. Two high ReDoS advisories cover it —
`GHSA-23c5-xmqv-rm74` (nested `*()` extglobs) and `GHSA-7r86-cg39-jmmj` (non-adjacent GLOBSTAR
backtracking) — and each is patched on every major line at a *different* floor: `3.x→3.1.4`,
`5.x→5.1.8`, `6.x→6.2.2`, `9.x→9.0.7`, `10.x→10.2.3`. A bare `minimatch:` override therefore does
not just choose a version, it forces one major onto every consumer in the tree, and minimatch 10's
CommonJS entry point is a namespace object rather than the directly-callable export that the 3.x and
6.x lines ship. `nodemon`, `test-exclude@6` and `superstatic` all call `minimatch(...)` directly, so
the global pin turned `pnpm run start-dev` into `TypeError: minimatch is not a function` on the first
watched-file change. Each consumer is instead pinned to its own major at that line's floor
(`nodemon>minimatch`, `firebase-tools>minimatch`, `test-exclude@6>minimatch`, `superstatic>minimatch`,
`glob@10>minimatch`), which clears both advisories while leaving every caller's API contract intact.
This is the same rule as the `firebase-admin` hold one layer down: a dependency's *declared* range is
part of its contract. Two tests pin it — no bare `minimatch:` override, and `require('minimatch')`
resolved from nodemon's and superstatic's own directories is still a function.

**An ignore requires a reachability proof, not a risk tolerance.** The single current ignore,
`GHSA-86w9-cpqp-85rv` (node-forge RSA PKCS#1 v1.5 verification), has no patched release at any
version. It is suppressed because `firebase-admin` calls exactly one node-forge function —
`forge.pki.privateKeyFromPem()`, to parse a key we supply ourselves — and never reaches the
signature-verification path the advisory describes. A test asserts that the call surface stays at
`forge.pki`, so the justification cannot silently become false after an SDK bump.

**Superseded majors stay held.** Upgrading to clear an advisory would have meant `firebase-admin`
12 → 14, which relocates `admin.credential` to top-level `cert`/`applicationDefault` and removes
`admin.firestore` as a property. That is a breaking change across every storage service, and the
test suite mocks `firebase-admin` — so the migration would have passed CI and broken at runtime.
The `protobufjs` override clears the same critical advisory (the Firestore wire decoder,
`GHSA-xq3m-2v4x-88gg`) with no API change, which is why `firebase-admin` remains on 12.x.

**Re-verify after every change to the dependency tree.** `pnpm run audit:gate` re-checks the
advisory surface, `pnpm test` covers the unit and integration surfaces, and `pnpm test:firebase`
exercises the real Admin SDK against the emulator — which is the only thing that proves the pinned
`protobufjs` still decodes Firestore responses correctly. See Section 6, Stage 2.

---

## 5. Migration Prioritization Framework

When the `2026-12-31` revisit date arrives (or a revisit trigger fires early), candidates are
ranked against four criteria. The criteria are ordered by blast radius, not by how large the
version gap looks — a two-major gap in a leaf utility outranks a one-major gap on the order path.

| # | Criterion | Question | Why it ranks here |
| :-- | :--- | :--- | :--- |
| 1 | **Operational criticality** | Does a failure here stop alert delivery, order execution, or persistence? | A regression here is user-visible and revenue-affecting within minutes. |
| 2 | **Blast radius** | How many call sites and services would need to change together? | Determines whether the migration is one PR or a coordinated series. |
| 3 | **Breaking-change severity** | Does the release alter control flow, error semantics, or persistence formats? | Silent semantic changes are more dangerous than loud API breaks, which tests catch. |
| 4 | **Security exposure** | Are there advisories against the currently locked version? | The one criterion that can *accelerate* a migration ahead of the normal order. |

Criteria 1–3 set the default sequence. Criterion 4 is an override: a live advisory promotes a
package immediately and out of order, ahead of anything merely queued behind it. It promotes
*attention*, not necessarily a migration — check Section 4.1 first, because for most advisories the
correct remedy is a pinned transitive version rather than a semver-major move.

Applying the framework yields the sequence already recorded in GH-1170:

1. `@google/genai` + `openai` — provider clients. High call-site count, but failures are
   contained by the existing fail-open enrichment path, so they are the safest place to learn
   a new client SDK's ergonomics.
2. `firebase-admin` — persistence, auth, and Remote Config. Isolated behind storage services,
   but a failure here can prevent alert recording outright.
3. `bullmq` + `ioredis` — worker queue. Treated as a matched pair because BullMQ's Redis client
   coupling means migrating one without the other is not a coherent state.
4. `binance` — live order execution. Sequenced late deliberately: it is the only audited package
   whose defects can move real money, so it inherits the most mature migration practice.
5. `undici`, `uuid`, `helmet` — leaf utilities with narrow blast radius, migrated last.
6. `express` — already on hold via the merged Dependabot suppression in PR #908 (GH-558, CB-259).
   Listed last for completeness; any future move to Express 5 is a first-party framework
   decision rather than a routine SDK bump.

---

## 6. Migration Validation & Rollout Strategy

There is no shadow-traffic or dual-write mechanism for outbound provider and queue calls, and
this document does not propose adding one. A dual path would double the failure surface for
exactly the components that must fail open. Instead, each migration is validated by a staged
ladder built from controls that already exist on `master`:

**Stage 1 — Isolated branch, no external effect.**
One package per PR, branched from current `master`. Dependabot suppression for that package is
lifted only for the duration of the migration so the diff is reviewed against a known target.

**Stage 2 — Automated regression gates.**
`pnpm test` plus the focused suite named in that package's Section 3 entry. Where persistence is
touched, `pnpm test:firebase` against the Firestore emulator. A migration is not eligible to
advance while `tests/unit/sync-production-env.test.js` is failing for unrelated reasons, because
that suite gates the env-sync path these migrations depend on.

**Stage 3 — Synthetic probe against a real deployment.**
Master already exposes the probe surfaces needed here, so no new endpoint is required:
- `POST /api/admin/test-alert` (admin-gated, idempotency-protected) exercises the real
  notification path end to end without waiting for market conditions.
- `GET /api/selftest` and `POST /api/selftest/run` report component-level health.
- `GET /api/status` and `GET /api/capabilities` confirm provider and queue wiring after restart.

These run against the PR preview deployment first, then against production post-merge.

**Stage 4 — Staged production rollout via Remote Config.**
Where a migration can be toggled at runtime, the new path is gated behind a Remote Config
boolean, defaulted off, and enabled for a single channel or worker pool before wider rollout.
Packages with no runtime flag (`helmet`, `undici`, `uuid`, `dotenv`) skip this stage because
their effect is observable at boot via the Stage 3 probes.

**Stage 5 — Rollback rehearsal before full enablement.**
Confirm the revert path is a redeploy of the previous image and not a data migration. This is a
hard gate for `firebase-admin` and `binance`: if a migration cannot be reverted by redeploy
alone, it requires a dedicated migration plan and explicit human sign-off rather than an
automated merge.

**Worker queue specifics (`bullmq` + `ioredis`).** The queue is drained gracefully on
`SIGTERM`/`SIGINT` via `src/lib/processLifecycle.js`, so queue migrations must be validated by
observing a full drain-then-restart cycle with no dropped or double-processed jobs. Job
reconciliation is the assertion that matters: a duplicated or lost job is a correctness bug, not
a performance regression.
