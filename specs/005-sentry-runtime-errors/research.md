# Research: Sentry Runtime Errors (@sentry/node)

**Branch**: `005-sentry-runtime-errors` | **Date**: 2025-11-26  
**Purpose**: Resolve technical unknowns around integrating Sentry into the existing Node.js bot for runtime error monitoring.

---

## Topic 1: Sentry SDK choice & initialization pattern

**Decision**: Use the official `@sentry/node` v8 SDK with a minimal "error monitoring only" configuration, initialized once at process startup.

**Rationale**:

- The Sentry JavaScript docs recommend `@sentry/node` as the SDK for Node-based backends.
- The SDK can load the DSN from `process.env.SENTRY_DSN` when `dsn` is omitted, avoiding hardcoded secrets.
- The v8 Node docs (`v8-node.md`) show a simple initialization model plus optional Express helpers; we only need core error capture, not tracing/profiling.
- Keeping initialization in a single `SentryService` module aligns with the Constitution's simplicity and readability goals.

**Implementation notes** (conceptual):

- Import and initialize once near application startup (e.g., from `index.js` via `SentryService.init()`):
  - Configure `dsn` (or rely on `SENTRY_DSN`).
  - Set `environment` and `release` from existing env vars (see Topic 4).
  - Disable tracing/profiling for this feature (no `tracesSampleRate`, `profilesSampleRate`, or profiling integrations by default).
- Expose small, typed helpers such as `captureError({ channel, error, context })` from `SentryService` instead of using `Sentry.captureException` directly in many places.

**Alternatives considered**:

- **Using generic `@sentry/browser` or multi-environment SDKs only** – rejected because the official docs recommend `@sentry/node` for backend Node apps, and v8 provides Node-specific features (e.g., Express helpers, OnUnhandledRejection integration).
- **Custom HTTP client sending events directly to Sentry API** – rejected as unnecessary complexity and maintenance burden vs. using the official SDK.
- **Using the Supabase Sentry JS integration** (`supabase-community/sentry-integration-js`) – rejected as it targets Supabase SDK instrumentation, which is not relevant here.

---

## Topic 2: Handling `uncaughtException` and `unhandledRejection`

**Decision**: Rely on the Node SDK's built-in integrations for process-level error capture, configuring unhandled rejection behavior to avoid changing process semantics.

**Rationale**:

- The Sentry JavaScript changelog for v5 highlights an `OnUnhandledRejection` integration with a configurable `mode` option, showing that unhandled promise rejections are a first-class concern for the Node SDK.
- The Node SDK already wires up global error handlers for uncaught exceptions and unhandled rejections; duplicating `process.on('uncaughtException')` / `process.on('unhandledRejection')` logic risks double-reporting and inconsistent behavior.
- Using the official integrations keeps us closer to upstream best practices and reduces code we must maintain.

**Implementation notes** (conceptual):

- Allow the default `OnUncaughtException` integration to capture uncaught exceptions so that at least one event is sent before process termination.
- Configure the `OnUnhandledRejection` integration (via its `mode` option) to log and report rejections without changing the default Node process behavior (i.e., do not introduce a new `process.exit()` path for rejections). Exact configuration will follow current `@sentry/node` recommendations.
- Avoid register­ing additional manual global handlers in application code; use `SentryService` only for explicit, expected error capture in catch blocks and retry exhaustion paths.

**Alternatives considered**:

- **Manual `process.on('uncaughtException' / 'unhandledRejection')` handlers** – rejected because the SDK already does this safely; additional handlers complicate control flow and risk double-reporting or missed events.
- **Disabling process-level integrations entirely** – rejected because FR-002 specifically requires capturing process-level failures before restart.

---

## Topic 3: Express integration vs. manual instrumentation

**Decision**: Do **not** use the high-level Express helpers such as `Sentry.setupExpressErrorHandler(app)` for this feature. Instead, rely on:

- Explicit calls to `SentryService.captureError()` from existing `catch` blocks in HTTP handlers.
- The process-level integrations from Topic 2 for truly uncaught errors.

**Rationale**:

- The `v8-node` docs show `Sentry.setupExpressErrorHandler(app)` as a convenient way to capture Express errors, but our handlers already wrap their logic in `try/catch` and construct HTTP responses directly (they do not regularly call `next(err)`).
- Introducing global Express error middleware would require reworking existing error handling to route everything through `next(err)`, which is out-of-scope and risks changing observable HTTP behavior (conflicts with FR-003 and User Story 2).
- Manual instrumentation in the few central catch blocks (`alert.js`, `newsMonitor.js`) is straightforward and makes it explicit which paths are monitored and how they are tagged.

**Alternatives considered**:

- **Using `Sentry.setupExpressErrorHandler(app)` plus `requestHandler` middleware** – rejected for this iteration because it would either be ineffective (if errors never reach `next(err)`) or require refactoring all handlers to Express-style error middleware, increasing complexity and risk.
- **Wrapping every controller in a generic Express error wrapper** – rejected as over-engineering for a small service with a handful of entrypoints.

---

## Topic 4: Environment, release, and enablement configuration

**Decision**: Control Sentry entirely via environment variables with a simple enable flag and environment/release derivation helpers.

**Rationale**:

- Sentry's Node docs mention that the DSN can be loaded from `process.env.SENTRY_DSN`, which is a standard pattern for keeping secrets out of code.
- The existing project already uses env-based gating for features (`ENABLE_WHATSAPP_ALERTS`, `ENABLE_NEWS_MONITOR`, `ENABLE_GEMINI_GROUNDING`, etc.), so following the same pattern keeps configuration predictable.
- The Sentry JavaScript changelog notes automatic release string generation from environment for Node. Combining that with our Render deployment vars (`RENDER_GIT_COMMIT`, `RENDER_GIT_REPO_SLUG`, `IS_PULL_REQUEST`) makes it easy to generate stable `release` and `environment` values.

**Planned configuration** (conceptual, names subject to final review):

- `ENABLE_SENTRY` – `'true'` enables monitoring; when not `'true'`, the monitoring service initializes as a no-op and logs a single info-level message.
- `SENTRY_DSN` – DSN for the Sentry project; required when `ENABLE_SENTRY==='true'` in environments where we actually want events.
- `SENTRY_ENVIRONMENT` (optional) – explicit environment label that, if present, overrides derived values.
- `SENTRY_RELEASE` (optional) – explicit release identifier; otherwise derived from `RENDER_GIT_COMMIT` or similar.

**Environment derivation strategy** (conceptual):

- If `SENTRY_ENVIRONMENT` is set, use it.
- Else if `RENDER==='true' && IS_PULL_REQUEST==='true'`, use `environment = 'preview'`.
- Else if `NODE_ENV==='production'` or `RENDER==='true'`, use `environment = 'production'`.
- Else use `environment = 'development'`.

**Release derivation strategy** (conceptual):

- If `SENTRY_RELEASE` is set, use it.
- Else if `RENDER_GIT_COMMIT` is present, use a short commit-based identifier (e.g., first 7 chars, optionally combined with repo slug).
- Else leave `release` unset and allow Sentry's automatic release detection when available.

**Alternatives considered**:

- **Per-environment allowlist/denylist variables (e.g., `SENTRY_ENABLE_PREVIEW`)** – rejected as overkill; operators can control enablement simply by setting `ENABLE_SENTRY` and/or `SENTRY_DSN` in the environments they care about.
- **Hardcoding environment names in code** – rejected in favor of a small derivation helper that respects an explicit `SENTRY_ENVIRONMENT` override.

---

## Topic 5: Error event shape, tagging, and external integrations

**Decision**: Use Sentry tags and structured context objects to represent channels, features, and external provider metadata, while defaulting to include full alert/news text as allowed by FR-007.

**Rationale**:

- FR-009 requires tags such as `channel=telegram|whatsapp|http-alert|news-monitor` and feature names for filtering.
- Sentry's Node SDK supports tags (key/value pairs) and structured `contexts` objects on each event, which is a natural fit for this requirement.
- The project already uses clear feature names (e.g., `gemini-grounding`, `news-monitor`), which can map directly to Sentry tags like `feature=gemini-grounding`.
- For external integrations (WhatsApp/GreenAPI, Telegram, Gemini, Azure, Binance, URL shorteners), we often know retry counts and duration from helpers like `retryHelper`; those values can be added as context fields on events generated when retries are exhausted.

**Planned event shaping** (conceptual examples):

- HTTP webhook error (alert):
  - `tags`: `{ channel: 'http-alert', feature: 'alerts', endpoint: '/api/webhook/alert' }`
  - `contexts.alert`: `{ has_enrichment: boolean, text_length: number }`
- HTTP webhook error (news monitor):
  - `tags`: `{ channel: 'news-monitor', feature: 'news-monitor', endpoint: '/api/news-monitor' }`
  - `contexts.news`: `{ symbols: string[], alerts_sent: number }`
- External provider failure after retries (e.g., WhatsApp):
  - `tags`: `{ channel: 'whatsapp', feature: 'whatsapp-alerts', provider: 'greenapi' }`
  - `contexts.retry`: `{ attemptCount, durationMs }`

**Alternatives considered**:

- **Sending only bare error messages with no tags or context** – rejected because it would make it hard to filter by channel/feature and violates FR-009.
- **Sending full HTTP payloads and all provider responses by default** – rejected on privacy and noise grounds; we will include structured, minimal context and (by default per FR-007) the full alert/news text but not arbitrary request/response blobs.

---

## Summary of Unknowns Resolved

| Unknown (from Technical Context) | Resolution | Status |
| -------------------------------- | ---------- | ------ |
| Which SDK and init pattern to use for Node | Use official `@sentry/node` v8 with a single `SentryService` wrapper and error-only configuration | ✅ RESOLVED |
| How to capture `uncaughtException` / `unhandledRejection` safely | Rely on SDK's built-in integrations, configuring unhandled rejections to avoid changing process semantics | ✅ RESOLVED |
| Whether to use Express helpers or manual instrumentation | Prefer manual instrumentation in existing catch blocks; skip `setupExpressErrorHandler` for now | ✅ RESOLVED |
| How to map environments and releases | Derive from `SENTRY_ENVIRONMENT`/`SENTRY_RELEASE` when present, otherwise from `RENDER`, `IS_PULL_REQUEST`, `NODE_ENV`, and `RENDER_GIT_COMMIT` | ✅ RESOLVED |
| How to structure tags/context for channels and external providers | Use Sentry tags and contexts for `channel`, `feature`, endpoints, and retry metadata; include full alert/news text by default per FR-007 | ✅ RESOLVED |

All `NEEDS CLARIFICATION` items in the Technical Context have been addressed at the planning level. Details such as exact option names will be aligned with the current `@sentry/node` v8 documentation during implementation, but no additional research blockers remain for Phase 1 design.
