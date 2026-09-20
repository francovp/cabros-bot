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
| `undici` | `6.28.0` | `8.10.2` | Native fetch dispatcher & connection pool agent | **Compatibility Hold** | 2026-12-31 |
| `uuid` | `11.1.1` | `14.0.2` | Request tracing, job IDs, idempotency deduplication | **Compatibility Hold** | 2026-12-31 |
| `helmet` | `7.2.0` | `8.3.0` | Express security headers & CSP middleware | **Compatibility Hold** | 2026-12-31 |
| `dotenv` | `16.6.1` | `18.0.1` | Application environment initialization | **Compatibility Hold** | 2026-12-31 |
| `express` | `4.22.1` | `5.2.1` | Core HTTP application framework (GH-558 / PR #908) | **Compatibility Hold** | 2026-12-31 |

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

### 3.6. `undici` (6.28.0 → 8.x)
- **Role:** Custom HTTP dispatcher and connection pooling agent for external requests.
- **Breaking Changes:** v7/v8 modifies Dispatcher pool lifecycle, request options, and error classes.
- **Risk Assessment:** Medium. Affects global HTTP timeout handling and connection reuse.
- **Compatibility Hold Rationale:** v6.28.0 is tightly integrated with Node 24 native `fetch` and custom pool configurations.
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
