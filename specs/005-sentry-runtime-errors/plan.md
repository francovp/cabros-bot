# Implementation Plan: Sentry Runtime Errors Integration

**Branch**: `005-sentry-runtime-errors` | **Date**: 2025-11-26 | **Spec**: `/specs/005-sentry-runtime-errors/spec.md`
**Input**: Feature specification from `/specs/005-sentry-runtime-errors/spec.md`

**Note**: This plan is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Integrate Sentry using `@sentry/node` into the existing Node.js alerting service to capture runtime errors across the main flows:

- HTTP webhooks (`/api/webhook/alert`, `/api/news-monitor`)
- Telegram and WhatsApp notification channels (after internal retries are exhausted)
- Process-level failures (`uncaughtException`, `unhandledRejection`)

The integration will be gated by environment configuration, defaulting to a safe no-op when disabled or misconfigured. Sentry events will include tags for channel, feature and environment, and—subject to privacy policy—selected alert/news content. The goal is to make production incidents observable without changing existing HTTP responses or notification fallbacks.

## Technical Context

**Language/Version**: Node.js 20.x (JavaScript, CommonJS modules)

**Primary Dependencies**:

- express – existing HTTP server framework
- telegraf – existing Telegram bot framework
- @sentry/node – Sentry SDK for Node.js v8, initialized once at process startup via a `SentryService` wrapper with error-monitoring-only configuration (no tracing; DSN read from `SENTRY_DSN`/env)
- jest – existing test runner for unit and integration tests

**Storage**: N/A (stateless service; no new persistence required for this feature)

**Testing**: Jest with existing structure:

- `tests/unit` for core logic (e.g., monitoring service, configuration gating)
- `tests/integration` for end-to-end behavior (e.g., error capture from webhooks and notification channels)

**Target Platform**: Node.js 20.x service deployed on Linux (Render) behind HTTP, plus Telegram/WhatsApp integrations.

**Project Type**: Single backend service (Express HTTP API + Telegram bot + background notification services).

**Performance Goals**:

- Preserve current behavior for successful requests; Sentry must not add noticeable latency in the non-error path.
- Under sustained error conditions, additional overhead from Sentry must keep total processing time within the ~20% envelope defined in SC-005.

**Constraints**:

- Monitoring must be fully optional and controlled via environment variables (e.g., DSN + enable flags); when disabled, all monitoring calls MUST be inexpensive no-ops.
- Integration MUST NOT change HTTP semantics or notification fallbacks even if Sentry is misconfigured or unavailable.
- Process-level failures (`uncaughtException`, `unhandledRejection`) will be captured via @sentry/node's built-in integrations, configured to avoid double-reporting and to preserve Node's default process semantics for rejections.
- HTTP error monitoring will use a thin manual wrapper (`SentryService.captureError(...)`) invoked from existing catch blocks in handlers, instead of global Express error middleware, to keep coupling minimal and avoid changing routing.
- Environment and release tagging scheme will be derived from `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` when present, otherwise from existing deployment env vars (`RENDER`, `IS_PULL_REQUEST`, `NODE_ENV`, `RENDER_GIT_COMMIT`) so that operators can distinguish `production`, `preview` and `development` incidents.

**Scale/Scope**:

- Single existing Node.js service; this feature adds one monitoring service module and small, focused hooks in existing handlers and notification services.
- No new external processes or storage; only one new third-party dependency (`@sentry/node`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Code Quality & Readability

- Plan introduces a single focused monitoring service (`SentryService`) instead of scattering `@sentry/node` calls across the codebase.
- Error reporting API will use clear, high-level helpers (e.g., `captureError(channel, error, context)`) with well-documented parameters.

### Simplicity & Minimalism

- Use the official `@sentry/node` SDK directly; avoid building a generic, provider-agnostic observability framework for this feature.
- Limit functionality to error monitoring (no performance/tracing) in line with FR-010.
- Configuration will reuse existing env-driven patterns used for other features (e.g., `ENABLE_*` flags) to minimize new concepts.

### Testing Policy

- Unit tests will cover configuration gating and the monitoring service behavior (enabled vs disabled, DSN missing, environment mapping).
- Integration tests will validate that representative errors in HTTP handlers and notification flows trigger monitoring calls without altering responses.
- Tests will stub `@sentry/node` so no real network calls are made.

### Review & Quality Gates

- Changes will be localized to a new monitoring service plus small, clearly-documented hooks in existing handlers.
- PR description will reference `/specs/005-sentry-runtime-errors/spec.md` and summarize monitoring decisions (privacy, tagging, env gating).

### Incremental Delivery & Semantic Versioning

- Feature can be rolled out behind an `ENABLE_SENTRY`-style flag and Sentry DSN presence, allowing progressive enablement by environment.
- No public API contracts change; behavior remains backward compatible from the perspective of HTTP clients and Telegram/WhatsApp users.

No Constitution violations have been identified before or after Phase 1 design; Complexity Tracking remains empty unless later phases introduce additional projects or abstractions.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
index.js                         # App entry; will initialize Sentry monitoring service and process-level hooks
app.js                           # Express app; existing middleware, optionally wired to Sentry if we use Express handlers

src/
├── controllers/
│   ├── commands.js
│   └── webhooks/
│       └── handlers/
│           ├── alert/
│           │   └── alert.js           # Existing alert webhook handler; will call monitoring helpers on failures
│           └── newsMonitor/
│               └── newsMonitor.js     # Existing news monitor handler; will call monitoring helpers on unexpected errors
├── services/
│   ├── notification/
│   │   ├── NotificationManager.js     # May emit monitoring events for persistent external send failures
│   │   ├── TelegramService.js         # Existing; may tag/channel metadata for monitoring
│   │   └── WhatsAppService.js         # Existing; integrates with retryHelper, used to detect exhausted retries
│   └── monitoring/
│       └── SentryService.js          # NEW: thin wrapper around @sentry/node, env gating, tags and capture helpers
└── lib/
    └── retryHelper.js                # Existing retry helper; metadata fed into monitoring for FR-005

tests/
├── integration/
│   └── sentry-runtime-errors.test.js # NEW: end-to-end tests for Sentry capture across HTTP and notification flows
└── unit/
    └── sentry-service.test.js        # NEW: unit tests for monitoring service configuration and behavior
```

**Structure Decision**: Reuse the existing single-service Node.js layout, adding a focused `src/services/monitoring/SentryService.js` module and thin hooks in existing handlers and notification services. No new projects or packages are introduced; tests follow the established Jest `unit`/`integration` split.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
