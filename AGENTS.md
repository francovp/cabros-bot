---
name: Cabros Bot Developer
description: Expert agent specializing in maintaining and extending a Telegram + WhatsApp crypto/stock alert bot built with Node.js and Express.
---

## Persona

You are **Cabros Bot Developer**, an expert Node.js and Express developer specializing in real-time alert services, external API integrations (Telegram, GreenAPI for WhatsApp, Binance, Google Gemini, TradingView MCP), and Firestore database persistence. You write clean, performant, and fail-safe/fail-open asynchronous code with comprehensive unit and integration test coverage.

## Boundaries

- **Always do:**
  - Preserve existing environment-driven gating (e.g. `ENABLE_TELEGRAM_BOT`, `ENABLE_GEMINI_GROUNDING`).
  - Maintain the `parse_mode: 'MarkdownV2'` styling for Telegram notifications.
  - Implement fail-open/fail-safe pathways: external service failures (such as Sentry, Firestore, or TradingView MCP timeouts) must never block core alert delivery or crash the server.
  - Use native `fetch` with `AbortController` timeouts for HTTP requests; do not add new HTTP client dependencies (like Axios).
  - For authenticated requests to deployed API endpoints, read `WEBHOOK_API_KEY` from the environment and send it in the `x-api-key` header; never print the value or place it in URLs, query strings, logs, or command output.
  - Format all filesystem links in your communications using absolute URLs with the `file://` scheme.
  - Update the Postman collection (`CabrosBot.postman_collection.json`) with every new endpoint, new request variant, or API contract change — include request body examples, response examples, and valid/invalid input variations.
  - Evaluate every new application-owned environment variable for Firebase Remote Config support. Add eligible non-secret runtime settings to the Remote Config schema, validation tests, operator documentation, and `firebase-remote-config-template.json`; explicitly record why secrets, credentials, authentication, security controls, destinations, and process-startup gates are excluded.
- **Ask first:**
  - Ask before deleting files or removing existing integration modules.
  - Ask before changing default environment variable fallback behaviors or route mounts.
- **Never do:**
  - Do not bypass API-key checks (`validateApiKey`) on protected webhook endpoints.


## Project Overview

This project is a small Express + Telegraf (Telegram) bot service that exposes an HTTP webhook and a Telegram command interface.

> For a human-readable capability map, status legend, and the first-24-hours operator journey, see [`docs/PRODUCT.md`](docs/PRODUCT.md).

### Key Files & Entry Points
- `index.js` — App entry. Starts Express server and conditionally launches the Telegraf bot. Important logic for enabling the bot lives here.
- `instrument.js` — Initializes Sentry logging + monitoring early (loaded by `index.js`).
- `app.js` — Express app configuration (body parsing, CORS, helmet, healthcheck route).
- `src/routes/index.js` — Registers HTTP API routes (mounted under `/api`; endpoints are feature-gated at runtime).
- `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js` — Price lookup resolver routing crypto to Binance and equities/stocks to Twelve Data (`EquityMarketDataService`); crypto replies optionally include bounded Binance 24h ticker context and retain the bare-price fallback.
- `src/controllers/commands.js` — Telegram command handlers wired in `index.js` (`/precio`, `/cryptobot`, `/jobs`) plus per-chat throttling for expensive commands.
- `src/controllers/trading/binanceOrders.js` — Operator-only `POST /api/trading/binance/orders`, `GET /api/trading/binance/orders`, and `DELETE /api/trading/binance/orders` controllers.
- `src/controllers/webhooks/handlers/alert/alert.js` — Webhook handler that forwards alert text to a Telegram chat.
- `src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js` — `POST /api/webhook/expanded-analysis-alert` handler that builds TradingView MCP analysis reports and sends them through notification channels.
- `src/controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation.js` — `POST /api/webhook/volume-confirmation` handler that returns structured TradingView MCP volume-confirmation data.
- `src/controllers/webhooks/handlers/jobs/jobs.js` — Job creation (`POST /api/jobs/tradingview-analysis`), listing (`GET /api/jobs`), and status polling (`GET /api/jobs/:jobId`) handlers.
- `src/services/notification/requestRouting.js` — Shared optional channel-routing validator/dispatcher for alert-producing routes (`channels`, `telegramChatId`, `whatsappChatId`) that preserves legacy broadcast behavior when `channels` is omitted.
- `src/controllers/alerts/alerts.js` — Stored alert read, export, analytics, and replay handlers for `GET /api/alerts`, `GET /api/alerts/export`, `GET /api/alerts/summary`, `GET /api/alerts/:alertId`, and `POST /api/alerts/:alertId/replay`.
- `src/controllers/status.js` — Status handler that computes capabilities, feature flags, notification channels, and active dependencies status.
- `src/services/storage/FirestoreWriteMetricsService.js` — In-memory counters tracking Firestore write attempts, successes, failures, and success rates across persistence domains (`alerts`, `alertReplays`, `jobs`), surfaced conditionally under `dependencies.firestoreWriteMetrics` in `/api/status` and `/api/capabilities`, with fail-open Sentry count metrics (`captureFirestoreWriteMetric`).
- `src/services/storage/SignalOutcomeService.js` — Records and evaluates signal outcomes, schedules the role-gated evaluator, and persists safe worker heartbeats.
- `src/controllers/outcomes/outcomes.js` — Signal outcome query and summary handlers for `GET /api/outcomes` and `GET /api/outcomes/summary`.
- `src/workers/signalOutcomeWorker.js` — Dedicated Render worker bootstrap with SIGTERM drain handling.
- `src/lib/adminAuth.js` — Opt-in Firebase ID-token verification and `admin.viewer`/`admin.operator` authorization for browser admin workflows; legacy API keys remain supported.
- `src/lib/telegramErrorBoundary.js` — Telegraf global update error boundary (`bot.catch`), polling error rate-limiting supervisor, Sentry reporting, and fail-open admin notifications.
- `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` — Scanner webhook handler executing sequential gainers, losers, and breakouts scanner runs on TradingView MCP.
- `src/services/jobs/JobService.js` — Manages job state, executes background TradingView analysis runs, and performs periodic expiration cleanup.
- `src/services/jobs/JobQueue.js` / `src/services/jobs/jobWorker.js` — BullMQ producer/worker integration for the optional Render worker execution mode.
- `worker.js` — Dedicated Render worker entry point with graceful BullMQ shutdown.
- `src/services/tradingview/expandedAnalysisAlertReport.js` — Parses `EXCHANGE:SYMBOL` requests and formats grouped Spanish technical-analysis reports.
- `src/services/monitoring/SentryService.js` — Wraps `@sentry/node` for runtime error, external failure, and custom metric monitoring (LLM tokens/duration, Firestore write counts) with tag enrichment (endpoint, provider, status_code, trace_id), automatic PII sanitization, and actionable 500 error grouping.
- `src/lib/processLifecycle.js` — Coordinates bounded HTTP/process shutdown and cleanup of runtime resources.
- `src/services/prompts/` — Langfuse-backed PromptService that resolves prompts with file-backed local defaults.
- `src/controllers/helpers.js` — Small numeric helper (`round10`) used by price formatting.
- `src/lib/logging.js` — Configures `console.*` levels via `LOG_LEVEL` and emits one-line structured JSON logs with multi-layer secret redaction (sensitive object keys, URL query secrets, JSON string secrets, key-value scalar patterns, Authorization headers, Bearer tokens, Telegram bot tokens, Discord webhook tokens, OpenAI keys, and request-scoped `registerSecretValue` / `clearSecretValue` registry helpers).
- `src/lib/rateLimiter.js` — Global API rate limiting middleware (returns 429 when exceeded; configured via `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`, with safe defaults for invalid values). Core alert/message webhook ingest uses a separate finite 1,000-request bucket per IP and window.
- `src/lib/cors.js` — Express CORS middleware configuring explicit origin allowlists (`https://cabros-bot.web.app`, `https://cabros-bot.firebaseapp.com`, `https://cabros-bot-production.up.railway.app`, `http://localhost:*`, and `CORS_ALLOWED_ORIGINS`).
- `src/openapi/openapi.json` — Canonical OpenAPI 3.1 contract for every mounted `/api` operation.
- `src/openapi/docs.js` — Public, read-only `/openapi.json`, self-hosted Swagger UI `/docs`, and `/admin` console routes (mounted before the rate limiter to exempt documentation and operator UI assets from the global API rate limit).

### External Integrations
- **Binance**: Uses `binance` package `MainClient` for prices and the gated Spot order workflow; order execution uses explicit Testnet/demo/live base URLs, raw decimal response values (`beautifyResponses: false`), deterministic client-order reconciliation before current exchange gates, exact request matching (including LIMIT `timeInForce`), order-test validation for dynamic and account-dependent filters, exchange-info filter validation, and one `submitNewOrder` call without automatic retry.
- **Telegram**: Uses `telegraf` package. Commands are wired in `index.js`, and direct `bot.telegram.sendMessage` is used for alerts.
- **TradingView MCP**: Remote MCP Streamable HTTP endpoint defaults to `https://tradingview-mcp-yp6b.onrender.com/mcp`. Tool `coin_analysis` expects complete symbols split from `EXCHANGE:SYMBOL` values.

---

## Build and Test Commands

Use these exact commands when configuring or verifying the project locally:

- **Install dependencies**: `pnpm install --frozen-lockfile`
- **Run production server**: `pnpm start`
- **Run development server**: `pnpm run start-dev` (runs `nodemon index.js`)
- **Verify healthcheck**: `GET /healthcheck` (provided by `app.js`)
- **Run focused test file**: `pnpm test -- tests/unit/price-parsing.test.js`
- **Run focused integration test**: `pnpm test -- tests/integration/news-monitor-basic.test.js`
- **Run unit tests folder with fast timeout**: `pnpm test -- tests/unit/ --testTimeout=5000`
- **Run tests by matching name**: `pnpm test -- --testNamePattern="should parse price"`
- **Run full test suite (do once as final check)**: `pnpm test`

---

## Code Style Guidelines

Maintain these patterns and rules in all contributions:

### Conventions & Style
- **Asynchronous Flow**: When interacting with external APIs, handlers return Promises (resolve on success, reject on error).
- **Graceful Fallbacks**: External service failures (Sentry, Firestore, or TradingView MCP timeouts) must never block core alert delivery or crash the server.
- **HTTP Client**: Use native `fetch` with `AbortController` timeouts for all HTTP requests; do not add new HTTP client dependencies (like Axios).
- **Environment Gating**: Do not alter how env gating works in `index.js` without adjusting tests/deploys.
- **Markdown Formatting**: Keep `parse_mode: 'MarkdownV2'` when composing Telegram messages, and ensure special Markdown characters are escaped correctly using `src/services/notification/formatters/MarkdownV2Formatter.js`.
- **Webhook & Notification Reliability**: When handling HTTP 429 from Discord webhooks, parse floating-point `Retry-After` headers accurately without integer truncation, respect the exponential backoff cap, and ensure the complete URL format (`/api/webhooks/:id/:token`) is validated.
- **Firestore Object Sanitization**: Always omit or sanitize `undefined` properties before passing objects to Firestore Admin SDK write APIs (`docRef.set`, `docRef.update`, `transaction.set`, `batch.set`, etc.) or client SDK methods to prevent runtime serialization exceptions. Keep pending idempotency claims locked with duration covering max webhook processing (e.g. 180s).
- **Background Worker Resilience**: Worker evaluation loops must rotate query candidate batches across sweeps to prevent starvation. Standalone workers register `SIGTERM`/`SIGINT` handlers that drain active sweeps or in-flight jobs on shutdown.
- **Structured Logging**: Log via `console.log`, `console.debug`, etc. The centralized logger (`src/lib/logging.js`) formats logs as structured one-line JSON containing `timestamp`, `level`, `message`, `service`, `pid`, etc.
- **Verification Before Completion**: Before claiming a fix, feature, or test run is done, run the exact verification command fresh in the current state and read the full output first. No success claims from memory, assumptions, or partial checks.
- **Clean Worktree Test Invariant**: Unit, integration, and contract tests must never mutate the working tree (e.g. overwriting `public/admin/admin.js` from `src/admin/admin.js`). Tests exercising build scripts, generators, or asset copiers must write to isolated temporary directories or verify in-memory, ensuring that `git status --porcelain` remains clean after running tests.
- **Admin Console Source of Truth**: Change the admin console in `src/admin/`, never in `public/admin/`, which is generated by `pnpm run build:hosting` and overwritten on every Firebase deploy. Always run `pnpm run build:hosting` and commit both trees; `tests/unit/admin-hosting-parity.test.js` fails CI on any divergence. See [Admin Console Source of Truth and Hosting Parity](#admin-console-source-of-truth-and-hosting-parity-issue-1201).
- **Systematic Debugging**: For any bug, test failure, or unexpected behavior, use `superpowers:systematic-debugging` first. Reproduce it, inspect the error, trace the root cause, then fix the source instead of patching symptoms.
- **Test-First Changes**: For every feature, bugfix, or behavior change, use `superpowers:test-driven-development`. Write the failing test first, verify it fails for the right reason, then make the minimal code change to pass it.
- **Review Discipline**: When handling PR feedback, use `superpowers:receiving-code-review` and `github:gh-address-comments`. Verify each comment against the codebase, avoid performative agreement, and address inline threads one at a time.

### Common Failure Modes
- **Missing BOT_TOKEN**: Throws on startup (explicit check in `index.js`).
- **Preview Environments**: Gated bot launch disabled in Render preview PR builds or Vercel preview deployments (`RENDER==='true' && IS_PULL_REQUEST==='true'` or `VERCEL_ENV==='preview'`).
- **HTTP 429**: Non-ingest requests are rejected if the global rate limit window is exceeded (`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`); core alert/message ingest has its own 1,000-request bucket.
- **JSON Error Parsing**: Webhook error responses must not crash if `error.response` is missing or shaped unexpectedly.

### Commits and Cleanups
- **Ignore linting mid-implementation**: Focus on features first. ESLint issues should be addressed in a dedicated cleanup pass.
- **Git Commits**: Commit locally with `--no-verify` (e.g. `git commit --no-verify -m "message"`) to bypass pre-commit hooks during development.

---

## Authorized-User ADC Credentials (Issue #1127)

`src/services/storage/firebaseAdminCredentials.js` classifies every parsed credential document before building a Firebase Admin app. A document that `admin.credential.cert()` can accept (explicit `type: "service_account"`, or the service-account fields with no `type`) keeps the existing `cert()` path. **Every other document type is routed to `admin.credential.applicationDefault()`** and never handed to `cert()`.

Why this is not optional: `gcloud application-default login` writes an `authorized_user` document (client id / client secret / refresh token) and workload identity federation writes `external_account`. Neither has a `private_key` or `client_email`, so `cert()` rejects them. `firestoreConfig.js` already reported both types as "configured", so before this fix a deployment could be *declared* configured, pass `isFirestoreConfigured()`, then throw inside the loader — which surfaced as `503 ADMIN_AUTH_UNAVAILABLE` for Firebase bearer-token requests, because `getFirebaseAuth()` swallows loader throws and returns `null`.

Three invariants to preserve:

- **`FIREBASE_PROJECT_ID` must always be forwarded on the ADC path.** `authorized_user` and `external_account` documents carry no project id, so the env override is the *only* one available. Callers copy `projectId` from a non-null loader result and from nothing else, so an ADC result that drops it initializes Firestore without a discoverable project and every durable operation fails.
- **Inline JSON must NOT fall back to ADC.** Application Default Credentials resolves a file, the well-known gcloud path, or the managed-runtime metadata server — never an inline value. Handing back an ADC credential for an inline `authorized_user` document would authenticate with a *different* credential than the operator configured, so that case raises `FIREBASE_CREDENTIALS_UNSUPPORTED_TYPE` and still fails open to `null` through `loadFirebaseAdminCredentialsOrNull()`.
- **Both ADC shapes must be covered.** The explicit `GOOGLE_APPLICATION_CREDENTIALS` file and the well-known `~/.config/gcloud/application_default_credentials.json` path need separate handling — the well-known branch is wrapped in a swallow-and-fall-through `try/catch`, so a regression there is silent rather than loud.

`__mocks__/firebase-admin.js` exposes both `credential.cert` and `credential.applicationDefault`. Removing the latter breaks every suite that `jest.mock('firebase-admin')` with a `TypeError`, not just this one.

**Coverage**: `tests/unit/firebase-admin-credentials.test.js` (both ADC paths, `external_account`, service-account regressions, inline rejection, ADC-unavailable fail-open), `tests/security/admin-auth.test.js` (bearer token verifies instead of `ADMIN_AUTH_UNAVAILABLE`), and `tests/unit/alert-storage-service.test.js` (`initializeApp` receives both the ADC credential and `FIREBASE_PROJECT_ID`).

No environment variable, Remote Config key, endpoint, response schema, OpenAPI, or Postman variant was added — the loader's return value gained an internal `credentialType` field (`cert` | `application_default`) that no HTTP response exposes.

## API Key Timing-Safe Comparison (Issue #667)

`src/lib/auth.js` now copies supplied and configured webhook API keys into fixed-size zero-padded buffers before `crypto.timingSafeEqual`, ensuring mismatched-length keys take the fixed-length comparison path without triggering weak-password-hash analysis. Values above the 4 KiB comparison ceiling are rejected after comparison. The middleware's redundant key extraction was removed. `tests/security/auth_check.test.js` covers the short-key regression; no environment, endpoint, OpenAPI, Postman, or Remote Config contract changed.

## Testing Instructions

### Test Locations & Conventions
- **Unit tests**: Located in `tests/unit/` for testing core logic (parsers, formatters, helpers, cache, prompts).
  - Firestore read/write unit coverage: `tests/unit/alert-storage-service.test.js`
- **Integration tests**: Located in `tests/integration/` for end-to-end flows (webhook alerts, multi-channel notifications, news monitor).
  - Stored alerts endpoint contract tests: `tests/integration/alerts-endpoint.test.js`
  - Volume confirmation endpoint contract tests: `tests/integration/volume-confirmation-endpoint.test.js`
- **Guidance**: Write tests after implementation. Ensure new endpoints and critical paths have test coverage. mock external services (Binance, Sentry, Firestore, Telegram, WhatsApp) in unit tests.

### Test Structure
- **Unit**:
  ```javascript
  describe('analyzer', () => {
    it('calculates confidence correctly', () => { ... })
  })
  ```
- **Integration**:
  ```javascript
  describe('news-monitor', () => {
    it('sends alert when confidence exceeds threshold', () => { ... })
  })
  ```

---

## Security Considerations

Implement the following security practices to safeguard endpoints and credentials:

- **Timing-Safe API Key Authentication**: Webhook-style write endpoints and news-monitor routes remain protected by `validateApiKey` middleware (`src/lib/auth.js`) which compares keys using timing-safe comparisons (`crypto.timingSafeEqual`) to prevent timing attacks. Supports keys from the `x-api-key` header or the `api-key` query param.
- **Firebase Admin Authentication**: When `ENABLE_FIREBASE_ADMIN_AUTH=true`, the browser admin routes accept verified Firebase ID tokens in `Authorization: Bearer`; `verifyIdToken(token, true)` fails closed for expired, revoked, disabled, malformed, or wrong-project tokens. `admin.viewer` is read-only and `admin.operator` is required for mutations. Webhook paths continue to require the API-key middleware.
- **Server-Side Firestore Access**: Client-side read/write access to the `alerts` database collection is denied by Firestore security rules (`firestore.rules`). Access is strictly server-side using the Firebase Admin SDK initialized with service account credentials.
- **Sensitive Key Redaction**: Sensitive keys (passwords, secrets, tokens, API keys, cookies, DSNs, and auth headers) must be redacted from logs via the centralized logger. The logger automatically redacts bare scalars preceded by sensitive labels, embedded strings (JSON payloads, URL query parameters), well-known token formats (Bearer tokens, Telegram bot tokens, Discord webhooks, OpenAI keys), and provides runtime registry helpers (`registerSecretValue`, `clearSecretValue`, `clearAllSecretValues`) for request-scoped secret lifecycle management.
- **API Key Fallback Warning**: Using API keys in query parameters is supported for client compatibility but is not recommended due to exposure risk in server logs or proxy middleware.
- **Authenticated API Requests**: When testing or calling deployed protected endpoints, use the `WEBHOOK_API_KEY` environment variable through the `x-api-key` header. Never expose the value in output, logs, URLs, query strings, or committed files.

---

## Environment and runtime behavior (discoverable)
- NODE version: `24.18.0` (see `.node-version` and `package.json` engines).
- Required env vars: `BOT_TOKEN` (throws if missing; even when Telegram bot is disabled).
- Optional but relevant (non-exhaustive; see feature sections below for full config): `ENABLE_TELEGRAM_BOT`, `ENABLE_TELEGRAM_COMMAND_RATE_LIMITING`, `TELEGRAM_COMMAND_RATE_LIMITS_JSON`, `PORT`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_TOPIC_ROUTES`, `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID`, `ENABLE_WHATSAPP_ALERTS`, `ENABLE_DISCORD_ALERTS`, `ENABLE_NOTIFICATION_REDRIVE`, `NOTIFICATION_REDRIVE_WORKER_ROLE`, `NOTIFICATION_REDRIVE_INTERVAL_MS`, `NOTIFICATION_REDRIVE_BATCH_LIMIT`, `NOTIFICATION_REDRIVE_MAX_ATTEMPTS`, `NOTIFICATION_REDRIVE_MAX_AGE_MS`, `ZERO_CHANNEL_ALERT_COOLDOWN_MS`, `ENABLE_API_ONLY_MODE`, `ENABLE_GEMINI_GROUNDING`, `GEMINI_API_KEY`, `ENABLE_TOKEN_COST_BUDGET`, `TOKEN_COST_DAILY_BUDGET_USD`, `TOKEN_COST_WARN_THRESHOLD_PCT`, `ENABLE_LANGFUSE_PROMPTS`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_PROMPT_LABEL`, `LANGFUSE_PROMPT_CACHE_TTL_SECONDS`, `BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_ENDPOINT`, `FORCE_BRAVE_SEARCH`, `MODEL_PROVIDER`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `ENABLE_NEWS_MONITOR`, `NEWS_MAX_ALERTS_PER_BATCH`, `NEWS_MAX_ALERTS_PER_WINDOW`, `NEWS_MAX_ALERTS_PER_WINDOW_MS`, `EXPANDED_ANALYSIS_ALERT_SYMBOLS`, `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS`, `TRADINGVIEW_MCP_URL`, `TRADINGVIEW_MCP_TIMEOUT_MS`, `TRADINGVIEW_MCP_MAX_RETRIES`, `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME`, `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION`, `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT`, `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME`, `ENABLE_ALERT_HTF_RENDER`, `ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT`, `ENABLE_SENTRY`, `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_PROFILE_SESSION_SAMPLE_RATE`, `SENTRY_CONSOLE_LOG_LEVELS`, `ENABLE_SENTRY_DEBUG_ROUTE`, `LOG_LEVEL`, `SERVICE_NAME`, `TRUST_PROXY`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `WEBHOOK_MAX_BODY_SIZE`, `ENABLE_FIRESTORE_ALERT_STORAGE`, `ENABLE_FIRESTORE_SCANNER_PRESETS`, `ENABLE_FIRESTORE_IDEMPOTENCY`, `ENABLE_SIGNAL_OUTCOME_TRACKING`, `ENABLE_EQUITY_MARKET_DATA`, `EQUITY_MARKET_DATA_PROVIDER`, `TWELVE_DATA_API_KEY`, `TWELVE_DATA_BASE_URL`, `EQUITY_MARKET_DATA_TIMEOUT_MS`, `EQUITY_MARKET_DATA_RPM`, `TWELVE_DATA_RPM`, `SIGNAL_OUTCOME_WORKER_ROLE`, `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS`, `SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT`, `SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS`, `SIGNAL_OUTCOME_EVALUATION_LEASE_MS`, `SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS`, `SIGNAL_OUTCOME_MAX_RETRY_AGE_MS`, `SIGNAL_OUTCOME_RETENTION_DAYS`, `ENABLE_JOB_BACKLOG_MONITOR`, `JOB_BACKLOG_ALERT_THRESHOLD_MS`, `JOB_BACKLOG_PAGE_COOLDOWN_MS`, `JOB_BACKLOG_PROBE_INTERVAL_MS`, `JOB_BACKLOG_PROBE_TIMEOUT_MS`, `ENABLE_MARKET_SCANNER`, `ENABLE_MESSAGE_FOOTER_METADATA`, `ENABLE_FIREBASE_ADMIN_AUTH`, `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`, `FIREBASE_WEB_CONFIG_JSON`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_MODEL_NAME_FALLBACK`, `RENDER`, `IS_PULL_REQUEST`, `RENDER_GIT_COMMIT`, `RENDER_GIT_REPO_SLUG`.

`WEBHOOK_MAX_BODY_SIZE` defaults to `256kb`, accepts human-readable byte units, and falls back to that default with a startup warning when malformed or outside `[1kb, 10mb]`. It applies to JSON, text/plain, and application/x-www-form-urlencoded bodies on `/api/webhook/*` and the exact `/api/news-monitor` ingest route. This is a security control and remains environment-only, excluded from Firebase Remote Config.

### Environment-template parity

`.env.example` is the canonical operator template. Static application-owned environment reads must appear there with defaults and valid-value guidance. The documentation-alignment test also extracts audited literal arguments for dynamic environment helpers (`parseEnvInt`, `getSymbolsFromEnv`, prompt `envVar` overrides, URL-shortener maps, and aliases created from `process.env`), so computed or aliased reads do not evade the guard. It explicitly classifies platform-injected values (Render, GitHub, Google runtime metadata), test-only controls (`ENABLE_TEST_RATE_LIMITER`), and deprecated aliases (`ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE`, `SIGNAL_OUTCOME_EVALUATION_CADENCE_MS`) so they are not mistaken for production configuration.

The audited controls include grounding limits/model/timeout, TradingView enrichment budget, persistent news deduplication, Binance timeout, Binance Spot order execution settings (`ENABLE_BINANCE_TRADING`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_TRADING_ENV`, `BINANCE_TRADING_ALLOWED_SYMBOLS`, `BINANCE_TRADING_MAX_NOTIONAL`, `BINANCE_TRADING_TIMEOUT_MS`), rate limiting, service identity, Discord retry controls, local prompt overrides, callback security/retry settings, idempotency TTL, Cloudflare enablement, Sentry debug-route gating, and public Firebase browser configuration fields. Defaults and security boundaries remain unchanged.

### Firebase Remote Config parity workflow

For every pull request that adds or changes an application-owned environment variable:

1. Classify the variable before implementation: `remote-config eligible` for non-secret runtime tuning or request-time behavior, or `environment-only` for secrets, credentials, authentication, security controls, notification destinations, external endpoints, process-startup gates, or other values that must remain deployment-controlled.
2. For `remote-config eligible` variables, add the same key to `src/services/remoteConfig/RemoteConfigService.js` with its type, default, bounds/enum validation, fail-open fallback, and focused tests. Add the matching `key:value` entry to `firebase-remote-config-template.json` (the repository template of record) and document it in `.env.example`, README, and `agents.md` when applicable.
3. Do not publish or synchronize Remote Config manually from the agent. After the PR merges and the target deployment reaches a terminal green `SUCCESS`/`OK` state, the manual `.github/workflows/firebase-remote-config.yml` workflow publishes `firebase-remote-config-template.json` with the server publisher script.
4. Verify the deployed service after the workflow succeeds: `/api/status` or `/api/capabilities` must report Remote Config as enabled/ready with `source: "remote"` (or the documented equivalent), and no secret or protected value may appear in the template, logs, status response, or issue/PR output.
5. If the deployment fails, the template is invalid, or Firebase Remote Config cannot load, report the exact failure and preserve the existing environment/default behavior. Never claim the key was synchronized based only on a queued or building deployment.

The Remote Config workflow publishes the server-side template consumed by Firebase Admin `initServerTemplate()`. It requires the `FIREBASE_SERVICE_ACCOUNT_JSON` GitHub Actions secret and uses the `FIREBASE_PROJECT_ID` repository variable when set (default: `cabros-bot`). Never commit credentials or publish environment-only values.

**Server namespace and bootstrap contract (issue #598):** the workflow must publish to the **`firebase-server`** namespace (`projects/{projectId}/namespaces/firebase-server/serverRemoteConfig`), because that is the namespace `initServerTemplate()` reads. Publishing to the default/client namespace (`/remoteConfig`) is a silent no-op: the template shows in the console while the runtime keeps loading an empty server template. Because the `firebase-server` namespace does not exist before the first publish, `scripts/deploy-server-remote-config.js` treats a `remote-config/not-found` pre-publish read as the expected bootstrap state and creates the namespace with `If-Match: *`; any other pre-publish read failure still aborts. `scripts/deploy-server-remote-config.js` also resolves credentials through the application order (`FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS` / ADC) and falls back to `GCLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT` for the project id, matching runtime.

**Truthful readiness:** `dependencies.firebaseRemoteConfig.ready` is true only after a *proven, successful, still-fresh* template load, and the new `templatePublished` flag is true only after at least one successful load. `enabled: true` + `configured: true` therefore never reads as "the template is live". A `remote-config/not-found` load rejection is classified as `lastErrorCategory: "template_not_published"` (not the opaque `load_failed`), alongside `permission_denied`, `unauthenticated`, `failed_precondition`, `internal_error`, `aborted`, `resource_exhausted`, `invalid_argument`, and `unknown_error`. Coverage: `tests/unit/remote-config-service.test.js`, `tests/unit/remote-config-publish.test.js`, `tests/integration/status-endpoint.test.js`.

- Bot startup is gated: bot is launched only when `ENABLE_TELEGRAM_BOT === 'true'` and not a preview environment (`RENDER==='true' && IS_PULL_REQUEST==='true'` or `VERCEL_ENV==='preview'` disables it).
- Process shutdown is coordinated for `SIGINT`/`SIGTERM`: the HTTP server stops accepting new connections, active requests and accepted `JobService` work drain, the news-monitor cache and signal-outcome worker stop, Telegram polling and in-flight handlers drain, and Sentry is flushed last within `SHUTDOWN_TIMEOUT_MS` (default `10000`, hard cap `30000`). If the deadline is exceeded, active jobs receive an independent bounded finalization attempt and are persisted as retryable `cancelled` records before remaining connections are force-closed and the process exits non-zero.
- Routes under `/api` (e.g. `/api/webhook/alert`) are mounted regardless of bot launch; individual features and notification channels are gated via env flags and per-channel validation.
- API documentation is public and read-only at `/docs` and `/openapi.json`; webhook and news-monitor operations remain guarded by `validateApiKey`, while documented admin read/action routes also accept verified Firebase bearer tokens when enabled. `/admin/auth-config` exposes only public browser configuration.
- Alert-producing routes now accept optional per-request notification routing:
  - `channels` — non-empty array limited to `telegram`, `whatsapp`, and/or `discord`
  - `telegramChatId` / `whatsappChatId` / `discordWebhookUrl` — optional per-channel destination overrides (`discordWebhookUrl` must be a valid HTTPS Discord webhook URL)
  - `telegramThreadId` — optional Telegram forum topic message thread ID override (`message_thread_id`, non-negative integer; use `0` to explicitly target the chat's General topic).
  - If `channels` is omitted, delivery still uses the existing broadcast-to-all-enabled-channels behavior.
- Telegram forum topic routing (`TELEGRAM_TOPIC_ROUTES`) routes alerts into dedicated `message_thread_id` topics by alert category/source (`webhook-signal`, `market-scanner`, `news-monitor`, `scanner-preset`, `tradingview-analysis`, `generic-message`, `default`). Per-request `telegramThreadId` takes precedence over environment topic routes.
- Telegram command authorization (`TELEGRAM_ALLOWED_CHAT_IDS`) gates every bot command behind an explicit chat-id allowlist (default: `TELEGRAM_CHAT_ID`) before any external provider call runs. Unauthorized senders are dropped silently (log once per sender per cooldown, no reply) so the bot's features are not confirmed. The middleware lives in `src/lib/telegramCommandAuth.js` and is registered before all command handlers in `index.js`; `/api/status` reports `featureFlags.telegramCommandAuth` and `dependencies.telegramCommandAuth` (allowlist source, size, and dropped-sender counters). The variable is a security control/destination and is **environment-only** for Remote Config parity.
- Stored alert read, export, analytics, and replay routes (`GET /api/alerts`, `GET /api/alerts/export`, `GET /api/alerts/summary`, `GET /api/alerts/:alertId`, `POST /api/alerts/:alertId/replay`) are also mounted under `/api`; they require `WEBHOOK_API_KEY` when configured, return `403 FEATURE_DISABLED` unless `ENABLE_FIRESTORE_ALERT_STORAGE=true`, and return `503 STORAGE_UNAVAILABLE` when Firestore is enabled but unreadable.
- Trader alert feedback (👍/👎 verdicts from inline keyboard callbacks) is persisted in the `alertFeedback` Firestore collection when `ENABLE_FIRESTORE_ALERT_FEEDBACK=true`, with an in-memory fallback otherwise. `POST /api/alerts/feedback` records one verdict per `(alertId, chatId)` tuple (re-clicks update rather than append); `GET /api/alerts/feedback/summary` aggregates verdicts per source/symbol/exchange; the `/api/alerts/summary` response always includes a `feedback` block alongside `enrichment`, `delivery`, and `latency`. Raw chat ids are never returned — only their SHA-256 hashes are stored on documents. `/api/status` exposes `featureFlags.alertFeedback` and `dependencies.alertFeedback` (with `mode: durable|ephemeral`, `backend: firestore|memory`, `enabled`, `configured`, `inMemoryEntryCount`).
- Both `ENABLE_FIRESTORE_ALERT_FEEDBACK` and `ALERT_FEEDBACK_RETENTION_DAYS` are documented in `.env.example` and follow the same fail-open semantics as the existing alert storage surface.
- Signal classification (`signalClass` enum: `breakout`, `mean_reversion`, `trend_continuation`, `reversal`, `volume_spike`, `news_event`, `manual`, `unknown`) classifies alerts across webhook ingestion, Firestore storage, alert querying/filtering, export, and analytics summary. Notification formatters display emoji badge markers (`🎯 breakout`, `🔄 mean_reversion`, etc.) for active classes when `ENABLE_SIGNAL_CLASS_MARKER` is enabled (`true` by default, Remote Config supported); `/api/status` exposes `featureFlags.signalClassMarker`.
- Webhook idempotency (`IdempotencyService`) stores reservations and cached responses in Cloud Firestore `idempotency_keys` collection when `ENABLE_FIRESTORE_IDEMPOTENCY=true`. All storage interactions fail open to in-memory caching upon Firestore errors, ensuring webhooks remain responsive across process restarts and horizontal scaling. `/api/status` exposes `featureFlags.firestoreIdempotency` and `dependencies.idempotencyStorage`.

**Production enablement and proven readiness (Issue #1111).** `render.yaml` declares `ENABLE_FIRESTORE_IDEMPOTENCY: true` with `previewValue: false` on the **web service only**. Two deliberate boundaries:

- **Web service only.** `IdempotencyStorageService` is reached exclusively through the HTTP route layer (`idempotencyMiddleware` in `src/routes/index.js`); `worker.js` never mounts routes, so the worker keeps the ephemeral default rather than becoming a second writer on the collection.
- **Previews stay off**, matching `ENABLE_FIRESTORE_JOB_STORAGE` and `ENABLE_FIRESTORE_SCANNER_PRESETS`. Preview environments share the production Firestore project, so a preview reserving keys could suppress a real production replay.

**`dependencies.idempotencyStorage.ready` is proven, not inferred.** This is the fourth instance of the repo's "shape is not readiness" rule, after `firebaseRemoteConfig.ready` (#598), Firestore `readHealth` (#1285) and `equityMarketData.ready` (#1116); do not fold `readiness` back into `configured`. `getStorageStatus()` derives `status` as `disabled` / `misconfigured` / `unverified` / `ready` / `degraded` from `consecutiveFailures > 0` → `degraded`, else `operationsSucceeded > 0` → `verified`, else `unverified`, so it self-heals on the next success without a restart and never latches degraded. Gate state wins over observed provider health.

The fail-open design is what makes this necessary rather than cosmetic: **every** Firestore error in this service is swallowed, so before this change a deployment that could not reach Firestore reported the same `ready` verdict as a working one, and an enablement that silently did nothing was indistinguishable from a successful one. `lastErrorReason` is constrained to a closed enum (`firestore_not_initialized`, `firestore_unavailable`) because a Firestore error message embeds the fully-qualified project/database path. `failOpen: true` is reported rather than implied — a `degraded` verdict still delivers alerts.

Four invariants to preserve:

- **`mode` and `backend` stay intent-derived.** They report the configured target (`durable`/`firestore`) and must not flip to `memory` while the flag is on, or an operator reads "memory" and concludes the flag is off. `ready`/`status` carry the proof question instead.
- **`isReady()` is the availability question and must never require a prior success.** `IdempotencyService` gates durable behaviour on `isEnabled()` and relies on `reserveEntry()` returning `null` to fall back, so folding the proven-readiness verdict into `isReady()` would make a freshly restarted process skip durable storage until it had already proven it works. `getStorageStatus()` must also never call `getFirestore()`, or a status read would register a durable attempt.
- **`operationsAttempted` counts a durable-use attempt even when Firebase initialization is rejected**, because asking for durable storage and not getting it is the event an operator needs to see. That keeps `operationsFailed <= operationsAttempted`.
- **Every readiness mutation runs through `recordReadinessSafely()`**, so a counter error can never reject a webhook. Telemetry is never allowed to break delivery.

**Deployment prerequisite, not a code step.** `expiresAt` is only honoured once Firestore's TTL policy exists, and TTL deletion is eventually consistent (~24 h) and only removes already-expired documents. `getEntry()` lazily deletes an expired document it reads, but a key that is never replayed is never read, so `bash ops/configure-operational-collection-retention.sh` must be run once per project or the collection grows without bound. Rollback is `false` plus a redeploy.

No composite index is required: every durable query is a point read (`firestore.collection('idempotency_keys').doc(docId)`) inside `runTransaction`, so Firestore's automatic indexes cover it. The flag remains environment-only for Remote Config parity — it is a process-startup gate that decides where a collection lives, not a runtime tuning knob.

**Coverage**: `tests/unit/idempotency-storage-service.test.js` (unverified → verified → degraded, self-heal, cold-start `isReady()`, rejected initialization, error-message non-leakage, status reads recording nothing, gate precedence, reset), `tests/integration/status-endpoint.test.js` (status projection in all three states plus the disabled default), `tests/unit/render-blueprint.test.js` (blueprint declares it for web with previews off and not for the worker), `tests/unit/postman-collection.test.js` and `src/openapi/openapi.json` (`IdempotencyStorage` schema, four documented response variants).
**Production enablement and proven confluence counters (Issue #1109).** `render.yaml` declares `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT: true` and `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME: true`, both with `previewValue: false`, on the **web service only**.

**The Blueprint gap was the actual bug, and it applied to *both* flags.** Each key was already present in the worker block as a `fromService` mirror of a value the web service never set, so the Blueprint *looked* configured while the only service that can reach the flags kept the `false` default. Only `/api/webhook/alert` reaches them (`TradingViewMcpService.enrichFromSignal`), and that route is mounted on the web service; the BullMQ worker never serves it. Do not "fix" this by moving the declaration to the worker — `tests/unit/render-blueprint.test.js` asserts the web block for **both** keys. A `fromService` mirror whose `envVarKey` source is never declared upstream is a silent no-op, so any future key added to a worker mirror must be declared on the web service too or it resolves to nothing. Previews stay off because a preview alert spends shared MCP budget and delivers to the production Telegram/WhatsApp destinations.

**`ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME` is nested inside the confluence gate** in `enrichFromSignal()`, so it is inert while confluence is off. The two flags therefore cannot disagree, and enabling MTF alone does nothing.

Five invariants to preserve:

- **The base-budget split is not cumulative.** `optionalEnrichmentEnabled = volumeConfirmationEnabled || confluenceEnabled` feeds a single `budgetMs * 0.75` ternary, so enabling confluence does **not** shrink the reserved base slice further when volume confirmation is already on. Do not "fix" this into two successive multiplications — with both optional features on that would silently starve `coin_analysis`, which is the one call that produces signal data.
- **Both confluence calls share one deadline.** `combined_analysis` and `multi_timeframe_analysis` are passed the same `combinedSignal`, capped at `min(8000, remainingBudget)`. With the default `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS=12000` and the 75% base reserve, the second call is commonly aborted and the alert is stored as `tradingViewEnrichmentStatus: "partial"`. That is honest, not a bug, but it does mean flipping this flag moves the dominant `tradingViewStatusCounts` bucket from `full` to `partial` — an operator reading that analytics surface will see it as enrichment degrading when the budget is simply too small for two calls. `REQUEST_TIMEOUT_MS` (default `30000`) bounds the whole request, so the budget cannot usefully exceed it.
- **`enrichment.confluence` must stay separate from `enrichment.alertPath`.** `alertPath.appliedCount = fullCount + partialCount` aggregates the entire webhook path, so it cannot distinguish a working confluence call from a base `coin_analysis` call that succeeded on its own. Collapsing the new counters into `alertPath` would recreate exactly the false-green this issue was filed against.
- **The confluence counters count CALLS, not enrichments.** One alert enrichment issues up to two calls (`combined_analysis`, then `multi_timeframe_analysis`), so a single alert can move `attemptedCount` by 2. The second call records its **own** `attempted` before it runs and its own `applied` after it returns; the shared `catch` records exactly one `failed`, because only the first call to throw can reach it. That is what makes `appliedCount + failedCount <= attemptedCount` hold. Do **not** "simplify" the two records back into one per enrichment: with a single per-enrichment attempt, a budget-starved `multi_timeframe_analysis` was charged to `combined_analysis`'s attempt and reported as `applied=1` *and* `failed=1`, so `1 + 1 > 1` — the invariant the docs, OpenAPI and Postman all assert was arithmetically false. `budgetExhaustedCount` counts *skipped stages*, not calls, and is deliberately outside the arithmetic.
- **Telemetry can never reject a webhook.** `_recordConfluenceOutcome()` is wrapped in `try/catch` internally and every call site is outside the delivery path; covered by a named test that makes `_getErrorCategory` throw. `lastFailureCategory` reuses the existing closed enum because a provider message can embed the fully-qualified project/database path — asserted not to leak.

Counters are process-local and reset on restart, so `enabled: true` with every counter at `0` is the expected state right after a deploy. They are per call, so do not compare them 1:1 against `enrichment.alertPath.totalCount`.

**Coverage**: `tests/unit/tradingview-mcp-service.test.js` (zeroed-with-enabled seed, attempt+apply, failure category and message non-leakage, budget exhaustion without a call, telemetry-never-throws, and the multi-timeframe second call — applied, rejected, and skipped-on-budget — each asserting `appliedCount + failedCount <= attemptedCount`), `tests/unit/render-blueprint.test.js` (web declares both flags, previews off, and the worker mirrors resolve to a real web-service value), `tests/unit/postman-collection.test.js` and `src/openapi/openapi.json` (`enrichment.confluence` schema plus the invariant assertions).

No new environment variable, Remote Config key, endpoint, or feature flag was added.

- Scanner preset CRUD responses include a non-sensitive `storage` object with the effective `mode` (`durable` or `ephemeral`) and `backend` (`firestore` or `memory`). `ENABLE_FIRESTORE_SCANNER_PRESETS=true` enables Firestore independently; `/api/status` and `/api/capabilities` expose the same state under `dependencies.scannerPresetStorage`.
- Scanner Preset Scheduler (`ScannerPresetSchedulerService.startWorker()`) runs recurring sweeps for due scanner presets with distributed lease locking when `ENABLE_SCANNER_PRESET_SCHEDULER=true`. `SCANNER_PRESET_SCHEDULER_WORKER_ROLE=web` (default) runs in web, `worker` runs in worker mode, `disabled` disables execution. `/api/status` exposes `featureFlags.scannerPresetScheduler` and `dependencies.scannerPresetScheduler`.
- News Monitor Scheduler (`NewsMonitorSchedulerService.startWorker()`) runs recurring news-monitor sweeps when `ENABLE_NEWS_MONITOR_SCHEDULER=true`. `NEWS_MONITOR_SCHEDULER_WORKER_ROLE=web` (default) runs in web, `worker` runs in worker mode, `disabled` disables execution. Defaults reuses `NEWS_SYMBOLS_CRYPTO` / `NEWS_SYMBOLS_STOCKS` for the sweep's symbol list, with a bounded lease via the `newsMonitorSchedulerLocks` Firestore collection so web + worker replicas don't double-fire. `/api/status` exposes `featureFlags.newsMonitorScheduler` and `dependencies.newsMonitorScheduler`.

**The news-monitor scheduler renewal callback takes the current time, not a deadline (issue #1135).** `_renewLease(nowMs, leaseMs)` owns the `now + leaseMs` arithmetic and writes `updatedAt: new Date(nowMs)`, so every caller — including the `_executeAnalysis` renewal tick — must pass `Date.now()`. The tick used to pass `Date.now() + leaseMs`, which the helper added `leaseMs` to a second time: `lockedUntil` became `now + 2 * leaseMs` (up to **20 minutes** at `MAX_LEASE_MS=600000`) and `updatedAt` was written *into the future*. After a crash or SIGTERM the standby replica therefore could not take the lock for up to double the intended window, delaying news sweeps.

This repo now contains **both** renewal conventions, so neither signature enforces its own: `AlertSchedulerService`, `SignalOutcomeService` and `ScannerPresetSchedulerService` all use `(nowMs, leaseMs)`, while `UserPriceAlertService._renewLease(lockedUntilMs)` deliberately takes an absolute deadline and writes `updatedAt: new Date()`. They are each internally consistent — but mixing them is what produced #1135. **Pass the current time to any `*_renewLease` that takes a `leaseMs` second argument; only the absolute-deadline signature takes a pre-computed deadline.** `updatedAt` must never be a future timestamp on any lock document. Coverage: `tests/unit/news-monitor-scheduler.test.js` (`lease renewal (#1135)`) asserts the `_renewLease` arithmetic from fixed timestamps, asserts `lockedUntil === now + leaseMs` after a real tick, and pins the `MAX_LEASE_MS` held window at `<= leaseMs`.
- Alert Scheduler (`AlertSchedulerService.startWorker()`) runs recurring JSON-defined news-monitor and market-scanner schedules when `ENABLE_ALERT_SCHEDULER=true`. `ALERT_SCHEDULER_WORKER_ROLE=web` (default) runs in web, `worker` runs in worker mode, `disabled` disables execution. Schedules are defined in `ALERT_SCHEDULER_SCHEDULES`, with a distributed concurrency lease via the `alertSchedulerLocks` Firestore collection to coordinate across web + worker instances. `/api/status` exposes `featureFlags.alertScheduler` and `dependencies.alertScheduler`.
- Signal Outcome Tracking includes an autonomous background evaluation worker (`SignalOutcomeService.startWorker()`) that runs on a configurable cadence (default: 5 minutes / `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS=300000`). `SIGNAL_OUTCOME_WORKER_ROLE=web` preserves the existing web timer; `worker` starts only `src/workers/signalOutcomeWorker.js`; `disabled` prevents scheduler startup. Sweeps are single-flight, drain active work on dedicated-worker shutdown, and remain bounded by `SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT` (default: 50) and `SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS` (default: 30000). `/api/status` exposes role, heartbeat, scanned/pending/evaluated/error counters under `dependencies.signalOutcomeWorker`; a disabled local scheduler reports `ready: false` and `status: "disabled"`; the dedicated process also persists those safe counters to `workerHeartbeats/signal-outcome` for cross-process inspection.
- **The signal outcome sweep is single-writer across processes (GH-1110).** `isEvaluating` only guards *this* process, and `startWorker()` only compares a process's own role, so role gating alone does not stop a web-role process and the dedicated worker from both sweeping. `SignalOutcomeService` therefore claims each sweep with a transaction-backed lease in the `signalOutcomeLocks` collection (`SIGNAL_OUTCOME_EVALUATION_LEASE_MS`, `10000`-`600000`, default `120000`, environment-only), matching the pattern already used by `ScannerPresetSchedulerService`, `NewsMonitorSchedulerService`, `AlertSchedulerService` and `UserPriceAlertService`. Five invariants: a replica that loses the claim returns `{ skipped: true, reason: 'lease-held' }` and issues **no** market-data calls, because a second evaluator re-prices and re-writes the same pending signal and doubles Binance / Gemini / Twelve Data quota spend (see GH-284); an expired lease is taken over rather than skipped forever; `releaseSweepLease` never clears a lease a different replica has since taken; and **the lease fails open** — an unavailable Firestore or a lease write that cannot be attempted proceeds with the sweep rather than silently disabling outcome evaluation. **Only proven ownership loss stops a sweep.** `renewSweepLease` returns the tri-state `LEASE_RENEWAL` (`ACQUIRED` / `LOST` / `UNDETERMINED`) rather than a boolean, because `LOST` (the lock is held by another replica, or the lock document is gone) means this process is not the owner and must halt before pricing the next document, while `UNDETERMINED` (no Firestore, no `runTransaction`, a thrown or timed-out transaction) is no evidence either way and stays fail-open — collapsing the two into one boolean either silently drops the single-writer guarantee or turns a Firestore blip into an evaluation outage. Renewals are serialized on one promise chain and `finally` awaits it, so ownership is never classified while a renewal is still in flight. A sweep halted by a lost lease increments `leaseHeldSkipCount` and sets `lastRunLeaseHeld`, and can still report a non-zero `lastRunEvaluatedCount` for the documents it finished before ownership moved on. Because nothing validates the two budgets against each other and the sweep budget is Remote-Config eligible while the lease is env-only, `startWorker()` warns once when `SIGNAL_OUTCOME_EVALUATION_LEASE_MS <= SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS`: a sweep that outlives its own lease can legitimately be taken over mid-run. `_resetForTesting` clears `lastRunLeaseHeld`/`leaseHeldSkipCount`. The unit Firestore double exposes no `runTransaction`, so the lease degrades to single-process behaviour in the default suite; only `tests/unit/signal-outcome-lease.test.js` injects a transaction-capable double. Production enablement is pinned in `render.yaml` (`ENABLE_SIGNAL_OUTCOME_TRACKING=true` on the **web** service, `previewValue: false`) instead of being left dashboard-only, and both roles may be configured simultaneously because the lease is what makes the outcome single-writer — so cutting the sweep over to the paid worker is now a role change, not a lock-step reconfiguration. `dependencies.signalOutcomeWorker` reports `leaseMs`, `lastRunLeaseHeld` and `leaseHeldSkipCount` so an operator can identify the winning evaluator from status instead of inferring it from the dashboard.
- `SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES` is an optional Remote Config-eligible comma-separated first-success chain (`mcp`, `binance`, `twelve-data`, `gemini`). Empty preserves the existing crypto (`mcp,binance,gemini`) and equity (`twelve-data`) defaults; `/api/status` reports the effective non-secret chains under `dependencies.signalOutcomeWorker.entryPriceSources`.
- Equity outcome records persist shadow-only session metadata (`observedAt`, `decisionBarClosedAt`, `tradableAt`, `observedPrice`, `tradablePrice`, `sessionContext`, `anchorMode`, and `measurementCohort`) using the built-in `America/New_York` regular-session calendar for BATS/NASDAQ/NYSE/AMEX/NYSE ARCA. Post-close, holiday, and pre-open windows remain explicitly labeled raw-observation cohorts; outcome math and delivery are unchanged until an executable-session price is available.
- Equity outcome evaluation is opt-in via `ENABLE_EQUITY_MARKET_DATA=true` with `EQUITY_MARKET_DATA_PROVIDER=twelve-data` and `TWELVE_DATA_API_KEY`. `EquityMarketDataService` supports `BATS`, `NASDAQ`, `NYSE`, `AMEX`, and `NYSE ARCA`, uses native `fetch` with bounded AbortController timeouts for `/quote` and `/time_series`, maps provider/quota/malformed-data failures to unavailable outcomes, and never blocks alert delivery. `/api/status` exposes non-sensitive readiness under `featureFlags.equityMarketData` and `dependencies.equityMarketData`.
- **Equity market data readiness is proven, not inferred (issue #1116).** `dependencies.equityMarketData.configured` reports credential *shape* only (`enabled && provider === 'twelve-data' && apiKey.length > 0`) and must never be read as "equity outcomes work": a typo'd, revoked, quota-exhausted, or wrong-plan key satisfies it. `ready` is true only after an observed successful provider call, recorded at the HTTP/auth boundary inside `requestJson()`. `status` is `disabled` / `misconfigured` / `unverified` / `ready` / `degraded`, where `unverified` (no call observed yet) is deliberately distinct from both `ready` and `degraded`. This is the third instance of the repo's "shape is not readiness" rule, after `firebaseRemoteConfig.ready` (#598) and Firestore `readHealth` (#1285); do not fold `readiness` back into `configured`. Invariants: readiness is computed from `consecutiveFailures > 0` → `degraded`, else `requestsSucceeded > 0` → `verified`, else `unverified`, so it self-heals on the next success without a restart and never latches degraded. Gate state wins over provider health. `requestsAttempted` increments **after** `waitForPacing()` grants a slot, because a local pacing rejection is not evidence about the provider and must not be able to fake degradation. Every mutation runs through `recordReadinessSafely()` so telemetry can never reject an equity evaluation. `lastErrorReason` is constrained to the closed `REASONS` enum so a provider response body can never leak into status. Counters are process-local and reset on restart; **there is no startup probe** — it would spend 8-RPM-tier quota on every restart to manufacture a green checkmark. `getProviderName()` still keys off `configured`, and `/precio` (`fetchPriceCryptoSymbol.js`) still gates on `enabled`/`configured` only, so runtime evaluation and Telegram behavior are unchanged; only the reported verdict changed.
- Token spend tracking & daily budget alerting (`ENABLE_TOKEN_COST_BUDGET=true`, `TOKEN_COST_DAILY_BUDGET_USD=5.00`, `TOKEN_COST_WARN_THRESHOLD_PCT=80`): aggregates LLM token usage across Gemini, Azure OpenAI, OpenRouter, and Cloudflare AI. Persists shared daily spend across web and worker processes via Cloud Firestore `tokenBudgets` collection (`FieldValue.increment`), triggers Telegram admin warning and hard ceiling alerts, and fails open safely when the budget is reached without crashing services or blocking core alert delivery. `/api/status` exposes `featureFlags.tokenCostBudget` and `dependencies.tokenCostBudget`.
- User Price Threshold Alerts (`UserPriceAlertService`, Telegram `/alerta`) let users define their own thresholds (e.g. `/alerta BTCUSDT < 60000`) when `ENABLE_USER_PRICE_ALERTS=true` (default off). `USER_PRICE_ALERT_WORKER_ROLE=web|worker|disabled` is matched against the process source in `startWorker({ source })`, so a mismatched role starts no worker; `worker.js` starts it with `{ source: 'worker' }`. Alerts persist in the server-side-only `userPriceAlerts` collection (requires **two** composite indexes in `firestore.indexes.json`: `userPriceAlerts{chatId,status}` for `listAlerts` and `userPriceAlerts{status,__name__}` for the rotating sweep query, which filters on `status` **and** orders by `FieldPath.documentId()` — Firestore rejects the sweep without the `__name__` composite, and the unit Firestore double makes `orderBy` a no-op so the suite cannot catch a missing index) with an in-process `Map` fallback; the sweep is arbitrated by a `userPriceAlertLocks` lease and the `armed → triggered` transition is claimed in a Firestore transaction **before** delivery, so overlapping sweeps or multiple replicas cannot double-notify. The claim is only *final* once the Telegram send succeeds: `_markDeliveryAttempted()` records `deliveryAttemptedAt` **before** the send, `_markDelivered()` records `deliveredAt` after it, and `_rearmUndelivered()` (the only path that can resurrect a trigger) requires the absence of **both** markers — so a failed delivery-marker write can never double-notify. The re-arm runs only on the no-bot branch, never on a failed send. `_scheduleNextSweep()` also skips entirely when `hasBot()` is false: a web replica with Telegram disabled would otherwise claim, re-price and re-arm the same alert every cycle, and the lease guarantees that bot-less replica wins every round. Durable-mode reads (`listAlerts`, `getAlert`, and the sweep fetch) must surface a storage error rather than answering from the process-local map: the mirror is authoritative only in ephemeral mode, and a silent fallback would report armed alerts as missing and make them impossible to cancel. `getStatus()` reports `configured: false` / `status: "degraded"` when Firestore is absent so an operator never mistakes ephemeral alerts for durable ones. The sweep orders by document id and resumes after the last scanned id to avoid starving alerts past the batch limit, deduplicates price lookups per symbol, and caps concurrency with `USER_PRICE_ALERT_PRICE_FETCH_CONCURRENCY`. Durable write and cancel failures surface a user-visible error rather than acknowledging lost state. `createAlert()` refuses when the feature is disabled so an unevaluated alert can never be created. Telegram forum topic `message_thread_id: 0` is the chat's General topic and must be preserved (compare against `null`/`undefined`, never truthiness). `/api/status` exposes `featureFlags.userPriceAlerts` and `dependencies.userPriceAlertWorker` (role, `running`, sweep counters, `lastError`, `storageMode`). Notification-only — no exchange keys and no order placement.

---

## Development Workflow for AI Agents

### Repository skills

- `issue-triage` (`.agents/skills/issue-triage/`): applies one ordered `priority/1-roi` through `priority/7-other` label to evidence-backed open issues, while preserving the existing operational `priority/p*` labels.
- `detect-unused-features` (`.agents/skills/detect-unused-features/`): fetches protected production capabilities through `WEBHOOK_API_KEY`; `.agents/skills/detect-unused-features/scripts/fetch-capabilities.sh` exits with `AUTH_BLOCKED` before parsing when the key is unavailable, supplies the header through stdin instead of argv, never prints the key, and does not follow redirects.
- `transaction-safety-review` (`.agents/skills/transaction-safety-review/`): reviews live order/auth boundaries, ambiguous provider outcomes, idempotency, Firestore type preservation, undefined sanitization, and TTL/claim retention before changing or reviewing transactional paths.
- `async-integration-review` (`.agents/skills/async-integration-review/`): reviews deadlines, abortable external calls, retries, cooldowns, worker fairness, scheduling inputs, telemetry, and graceful shutdown for asynchronous integrations.
- `contract-alignment-review` (`.agents/skills/contract-alignment-review/`): reviews runtime/API/config/deployment changes for alignment across OpenAPI, Postman, `.env.example`, README/specs, and repository agent skills.
- `agent-cross-review` (`.agents/skills/agent-cross-review/`): discovers and cross-reviews pull requests created by other AI coding agents (Codex, GitHub Copilot, OpenCode, Claude) against Cabros Bot fail-open async, formatting, persistence, auth, and contract standards.

### When implementing a feature:

1. **Read the spec** (`specs/*/spec.md`) for requirements and user stories
2. **Check patterns** in this file for similar implementations
3. **Understand failure modes** (see Common Failure Modes sections)
4. **Follow existing code style**: Simple functions, explicit logging, env-driven config
5. **Add tests** for critical paths after implementation
6. **Run focused tests during development** (see Test Execution Strategy below)
7. **Update Postman collection**: Add new endpoint requests, request variants (including error/invalid input examples), and response examples to `CabrosBot.postman_collection.json` for every API change
8. **Update environment variables** section if adding new config
9. **Evaluate Remote Config support** for every new environment variable and follow the parity workflow above; do not add secrets, credentials, authentication, security controls, destinations, or startup-only gates to Remote Config
10. **Update `firebase-remote-config-template.json`** with every approved eligible key/value and keep it aligned with `RemoteConfigService.js`
11. **After merge and green deployment**, let the Remote Config workflow publish the template and verify the deployed source/status; do not run the Firebase publish command manually
12. **Update this agents.md file** with the new context, recent PRs, and implementation details before creating a new PR
13. **Agent & Model Attribution Labels**: Ensure every PR created or updated by an AI agent carries an attribution label matching `<agent>-<model>` (e.g. `antigravity-gemini-3.7-flash`, `codex-gpt-5.6-luna`, `github-copilot-minimax-m3:free`)
14. **Final verification pass** before completion: run the exact relevant checks again, then do the full test suite `pnpm test` once per implementation to ensure no regressions

### Post-merge production environment synchronization

After a PR that adds or changes an environment variable is merged, wait for the merged commit's deployment to finish with a green/`SUCCESS` status before synchronizing runtime configuration. Then add the variable, with the exact corresponding value from the approved deployment configuration, to all production environments used by this project:

- Render production services, using the Render CLI/API or configured deployment tooling.
- Vercel production, using the Vercel CLI/API.
- Railway production, using `railway-cli` with explicit project, environment, and service identifiers.

Use the repository helper script [`scripts/sync-production-env.js`](file:///Users/fgvaleriop/repositorios/cabros-bot/scripts/sync-production-env.js) (or `pnpm run sync:production-env --key <NAME>`) to generate safe per-platform commands, identify affected Render services, and audit configuration.
- **Dry-run by default**: `pnpm run sync:production-env --key <NAME>` inspects `render.yaml` and prints ready-to-run per-platform commands without mutating anything.
- **Record verified execution & explicit no-ops**: `pnpm run sync:production-env --key <NAME> --verified --no-op vercel --no-op-reason vercel="Backend unhosted on Vercel"` (or `--status render=VERIFIED --status railway=VERIFIED`) appends a timestamped audit record to `.env-sync.log` only after platform updates and deployments are verified.
- **Audit drift**: `pnpm run sync:production-env --check-drift` diffs `.env.example` against platform blueprint definitions.

Use the platform's secret mechanism for credentials and never print secret values, place them in URLs, commit them, or include them in command output (the helper strictly rejects `KEY=VALUE` on `argv`). Public configuration values may be set directly, but still must match the approved `.env.example`, Blueprint, or PR configuration. Verify each platform with a redacted variable-name/readiness check and confirm any resulting deployment reaches green/`SUCCESS`. If a platform does not host the affected service, record that as an explicit no-op rather than silently skipping it. Do not claim the change is complete until the application deployment and environment synchronization checks pass.

### Firebase Hosting preview channel cleanup

Ephemeral preview channels created by the `.github/workflows/firebase-hosting.yml` PR deploy accumulate over time. Use [`scripts/cleanup-preview-channels.js`](file:///Users/fgvaleriop/repositorios/cabros-bot/scripts/cleanup-preview-channels.js) (or `pnpm run cleanup:preview-channels`) to list and delete preview channels older than a configured age. It drives the locally pinned `firebase-tools` CLI (`hosting:channel:list` / `hosting:channel:delete`), requires an authenticated firebase session (`firebase login` or `FIREBASE_TOKEN`) with site-update permission, and never deletes the `live` channel or channels without a parseable create time.

- **Dry-run by default**: `pnpm run cleanup:preview-channels` lists matching preview channels without deleting anything.
- **Apply with a bounded window**: `pnpm run cleanup:preview-channels --apply --max-age-days 3` deletes non-live channels created more than 3 days ago and appends a timestamped audit record (project, max age, deleted channel ids) to `.preview-channels-cleanup.log` (override with `--log-file`).
- **Project/site override**: `--project <id>` (default `cabros-bot`) and `--site <siteId>` (default resolved from the project); output is available as JSON via `--json`.
- **Tests**: `tests/unit/cleanup-preview-channels.test.js` covers argument parsing, resource-name parsing, JSON envelope parsing, age cutoff selection (including `live`-channel protection and unparseable create-time skipping), delete-command construction, and audit logging.



**Linting and Commits During Implementation**:
- **Ignore linter issues during implementation**: Focus on feature functionality first; linter errors will be fixed in a dedicated final pass
- **Make commits with `--no-verify`**: Use `git commit --no-verify -m "message"` to bypass pre-commit hooks during development (prevents blocking on linter/test failures mid-implementation)
- **Final cleanup phase**: After all user stories are complete DO NOT run linting and formatting, it will be done manually
- **Rationale**: This approach maximizes development velocity during active feature work and prevents context-switching between implementation and linting

**Test Execution Strategy**:
- **During development**: Run focused/specific tests only, NOT the full test suite. Examples:
  - `pnpm test -- tests/unit/price-parsing.test.js` — test single unit file
  - `pnpm test -- tests/integration/news-monitor-basic.test.js` — test single integration file
  - `pnpm test -- tests/unit/ --testTimeout=5000` — test entire unit directory
  - `pnpm test -- --testNamePattern="should parse price"` — test by name pattern
- **After completing all changes**: Run the full test suite `pnpm test` once per implementation to ensure no regressions
- **Rationale**: Full test runs take 2-5 minutes and consume significant token budget. Focused tests give rapid feedback (10-30s) during development. Only run full suite as final validation after full implementation phase.
- **Performance tip**: Use `--testTimeout=5000` with unit tests to speed up execution; integration tests need higher timeouts (~10000ms)

## Admin Console Source of Truth and Hosting Parity (Issue #1201)

`src/admin/` is authoritative. `public/admin/` is **generated output** served by Firebase Hosting, produced by `pnpm run build:hosting` (`scripts/build-hosting.js`), which `.github/workflows/firebase-hosting.yml` runs on every deploy with an unconditional `copyFileSync`.

**The rule: make every console change in `src/admin/`, then run `pnpm run build:hosting` and commit both trees.** Never hand-edit `public/admin/` — the next deploy deletes it, and nothing in the diff would show the fix existed.

This is now **enforced**, not advisory: `tests/unit/admin-hosting-parity.test.js` compares a SHA-256 of every `src/admin/*` file against its `public/admin/*` counterpart, rejects a built asset with no source, and asserts the four assets the issue enumerates (`admin.js`, `admin.css`, `index.html`, `admin-request.js`) plus `vue.runtime.global.prod.js` are present in both trees. It runs inside `pnpm test`, so `node.js.yml` fails on any divergence with no workflow edit.

**Why it is a test and not documentation:** this drifted once already and the prose instruction to "keep it in sync" was still in `AGENTS.md` when it happened. In `#1147` an SSE fix was hand-applied to the generated artifact only; `#1204` then ran `build:hosting`, which silently deleted both fixes from *both* trees while CI stayed green. Neither `tests/` nor `.github/workflows/` compared the two directories, so the loss was invisible until after the fact.

**Two invariants the SSE stream depends on** (`setupSseStream`), which the drift temporarily reverted:

- `SSE_HANDSHAKE_TIMEOUT_MS` (15s) bounds the **handshake only**. `fetch` against an event stream settles only once response headers arrive, so a connection that accepts TCP but never flushes headers leaves the promise pending forever and the console sits on "Connecting…" without reconnecting. The deadline must be cleared as soon as `fetch` settles (success *and* catch paths) because an SSE body is legitimately idle between events — widening it into a read deadline tears down healthy streams.
- The catch guard is `controller.signal.aborted && sseAbortController !== controller`, not a bare `aborted` check. `disconnectSse()` and a newer `setupSseStream()` both clear `sseAbortController`, so ownership — not the abort flag — is what separates an intentional teardown from our own handshake deadline. Collapsing it to `if (aborted) return` makes the timeout above convert a hang into a **permanently dead stream**, because the deadline's own abort would then return without ever reconnecting. This matches the existing `sseAbortController === controller` check on the clean-`done` path in the same function.

Coverage: `tests/unit/admin-client.test.js` (stalled handshake aborts and reconnects; deadline armed then disarmed on a healthy idle stream; deliberate `clear-key` teardown arms no backoff) and `tests/unit/admin-hosting-parity.test.js`. Tests stay read-only and must never write into either tree — see the Clean Worktree Test Invariant above.

### When extending a feature:

1. **Locate entry points** (see "Where to look first" sections)
2. **Trace data flow** through service layer
3. **Identify dependencies** (other services, external APIs, env vars)
4. **Add feature flag** if feature is optional
5. **Implement graceful fallback** (don't break alert delivery)
6. **Update documentation** (README for users, agents.md for developers)

### When debugging:

1. **Check logs**: stdout for startup/shutdown, debug for processing steps, error for failures
2. **Verify env vars**: Feature might be disabled or misconfigured
3. **Test external APIs**: Check Gemini, Binance, Telegram, WhatsApp directly
4. **Review test cases**: Existing tests reveal expected behavior
5. **Check retry logic**: Some failures are transient and auto-recover
6. **Use systematic debugging**: Reproduce, trace root cause, then patch the source. No guess-and-check fixes.

### When implementing changes:

1. **Write the failing test first** for the exact behavior or regression you are changing
2. **Watch the test fail for the right reason** before touching production code
3. **Make the minimal code change** to pass the test
4. **Verify the test passes and nothing else regressed**

## Alert Enrichment with Gemini Grounding (001-gemini-grounding-alert)

The system provides optional enrichment of webhook alerts using Google Gemini API with GoogleSearch grounding to fetch verified sources and context.

**Core Components** (`src/services/grounding/` and `src/controllers/webhooks/handlers/alert/`):
- `grounding.js` — Orchestrates Gemini GoogleSearch grounding to fetch context and sources
- `genaiClient.js` — Wrapper around Google Generative AI client
- `gemini.js` — Gemini API configuration and prompt management
- `src/services/prompts/` — Central prompt registry + Langfuse-backed runtime prompt resolution with local file-backed fallbacks
- `alert.js` — Webhook handler that optionally calls grounding service

**Grounding Service Pattern**:
- Enabled via `ENABLE_GEMINI_GROUNDING=true` (default: false)
- Uses Gemini's GoogleSearch tool when available and falls back to Brave Search when needed to gather sources, then generates enriched output
- Returns structured response with sentiment/insights/levels plus sources (URLs with titles)
- Graceful degradation: if grounding fails (API error, timeout), sends original alert text and logs warning (does NOT block alert delivery)

**Alert Enrichment Flow**:
1. Webhook receives alert text (plain or JSON body with `text` property)
2. If `ENABLE_GEMINI_GROUNDING=true`, call grounding service to fetch context
3. Grounding service queries Gemini with alert text + system prompt + GoogleSearch results
4. Gemini returns structured insights (sentiment, key insights, technical levels, and optional risk parameters) plus extracted sources (URLs + titles)
5. Enriched alert stored as `alert.enriched` object with structure: `{ original_text, sentiment, sentiment_score, insights, technical_levels, invalidation_level, target_level, setup_type, risk_reward_ratio, prompt_provenance, sources, truncated }`
6. Original `alert.text` preserved for fallback
7. Enhanced alert sent to all enabled notification channels
8. Webhook response includes `enriched: true/false`, per-channel delivery `results`, and a `tokenUsage` object (with a formatted summary) when grounding runs

**Configuration**:
- `ENABLE_GEMINI_GROUNDING` — Feature flag (default: false)
- `GEMINI_API_KEY` — Google API key with Generative AI enabled
- `BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_ENDPOINT`, `FORCE_BRAVE_SEARCH` — optional Brave Search fallback/override for grounding when GoogleSearch is unavailable or empty.
- `MODEL_PROVIDER`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` — optional provider routing for `llmCallv2()` (Gemini/Azure/OpenRouter) used by grounding/enrichment.
- Grounding can run without the Telegram bot; Telegram delivery still requires a running bot + `TELEGRAM_CHAT_ID`.

**Enrichment Strategy**:
- Single grounding call per alert (results reused across all notification channels)
- Reuses same alert object for both Telegram and WhatsApp delivery
- Each channel formats the enriched alert appropriately (see 002-whatsapp-alerts for formatting)
- Graceful fallback: enrichment errors do NOT prevent alert delivery

**Timeout & Retry**:
- Grounding API calls use `retryHelper.sendWithRetry()` with 3 retries and exponential backoff
- Timeout: controlled by `GROUNDING_TIMEOUT_MS` (default: 30000 ms)
- If timeout exceeded, returns original alert text with warning

**Common Failure Modes**:
- Missing `GEMINI_API_KEY` when `ENABLE_GEMINI_GROUNDING=true` → error logged at startup
- Gemini API unavailable or rate-limited → fallback to original text + warning log
- Alert text too long (>4000 chars) → may be truncated by Gemini to avoid cost overruns
- Non-English alert text → Gemini respects language; returns summary in same language if possible

**Where to look first when extending or debugging**:
- `instrument.js` / `index.js` for lifecycle (loads config; grounding runs per-request when `ENABLE_GEMINI_GROUNDING=true`)
- `src/services/grounding/grounding.js` for orchestration logic and timeout handling
- `src/controllers/webhooks/handlers/alert/alert.js` for webhook flow and grounding integration
- `src/services/grounding/gemini.js` for response parsing and prompt variable assembly
- `src/services/prompts/` for runtime prompt definitions, Langfuse labels, and local fallback behavior (`defaults/*.txt`)
- Tests in `tests/integration/alert-grounding.test.js` for end-to-end behavior
- Tests in `tests/unit/grounding.test.js` and `tests/unit/gemini-client.test.js` for core logic

## Centralized Prompt Management (Langfuse-backed)

Runtime LLM prompts are centrally managed through `src/services/prompts/`.

**Current pattern**:
- `PromptService` resolves prompts by stable key/name.
- If `ENABLE_LANGFUSE_PROMPTS=true`, prompts are fetched from Langfuse using `LANGFUSE_PROMPT_LABEL` and `LANGFUSE_PROMPT_CACHE_TTL_SECONDS`.
- If Langfuse is disabled, misconfigured, unavailable, or missing a prompt, the system **fails open** to the local fallback text templates in `src/services/prompts/defaults/`.

**Rules for future changes**:
- Do **not** inline new runtime LLM prompt strings directly in feature code when they belong to production flows.
- Register new prompts in `src/services/prompts/promptRegistry.js` with a stable Langfuse name and add matching local fallback text templates under `src/services/prompts/defaults/`.
- Resolve prompts via `getPromptService()` from `src/services/prompts/`.
- Keep provider routing (`genaiClient.llmCallv2`, Azure/OpenRouter clients) separate from prompt ownership.
- Add or update unit tests in `tests/unit/prompt-service.test.js` and the affected feature tests whenever a prompt contract changes.
- Keep Langfuse `alert-enrichment` versions aligned with the local fallback's optional risk metadata schema.
- Keep Langfuse `alert-enrichment` versions aligned with the local fallback's optional risk metadata schema.

### Proven Langfuse Prompt Readiness (Issue #1178)

`ENABLE_LANGFUSE_PROMPTS=true` is enabled in production by `render.yaml` (`value: true`, `previewValue: false`) on the **web service and the jobs worker**. The jobs worker is included because it starts `newsMonitorSchedulerService` and `alertSchedulerService`, which resolve prompts through the same `PromptService`; a split gate would make two processes silently use different prompt versions for the same alert — the same uniformity argument as `ENABLE_FIREBASE_REMOTE_CONFIG` (#1113). Previews stay off so a throwaway PR deploy cannot publish traces against the production Langfuse project or spend its quota. Credentials are `sync: false` on both services: an operator sets them in the Render dashboard.

**`ready` is proven, not inferred.** `src/services/prompts/promptReadiness.js` is the sixth instance of the repo's "shape is not readiness" rule, after `firebaseRemoteConfig.ready` (#598), Firestore `readHealth` (#1285), `equityMarketData.ready` (#1116), `idempotencyStorage.ready` (#1111) and `jobExecutionQueue.brokerReachable` (#1117). `dependencies.langfuse.configured` validates credential **shape** only; do not read it as "prompts resolve". `ready` becomes true only after an observed successful prompt resolution, and `status` is `disabled` / `misconfigured` / `unverified` / `ready` / `degraded`. Do not fold `readiness` back into `configured`.

Why this matters more here than elsewhere: **prompt resolution fails open** to `src/services/prompts/defaults/`. That is what keeps alert delivery alive, and it is exactly why a shape-derived `ready` was a lie — a deployment where every alert silently resolved locally reported the same verdict as a working one. Four invariants to preserve:

- **`localFallbackCount` only counts fallbacks while the gate is on.** With the gate off, local use is the configured intent, not a fallback; counting it would make a healthy disabled deployment look broken. This counter is the number that proves the enablement is doing something.
- **`promptsAttempted` counts an attempt even when client construction is refused**, because asking for a managed prompt and not getting one is the event an operator needs to see. That keeps `promptsFailed <= promptsAttempted`.
- **`consecutiveFailures > 0` → `degraded`, cleared by the next success**, so publishing a missing label mid-incident self-heals the verdict without a restart and the verdict never latches. A *failed startup probe* must report `degraded`, not `unverified`: the probe is the first observation on a fresh process, so `unverified` there would be indistinguishable from "nothing has tried yet".
- **`lastErrorReason` is a closed enum** (`src/services/prompts/promptReadiness.js`) because a Langfuse error body can embed the project id, base URL and API key; an unrecognized failure collapses to `langfuse_unavailable`. Only the `LANGFUSE_BASE_URL` **host** is reported, never credentials. Every readiness mutation runs through `recordPromptReadinessSafely()` so telemetry can never reject a prompt resolution, and a status read never registers an attempt.

**Unlike equity market data, this feature deliberately DOES have a startup probe** (`probeManagedPromptReadiness()`, called detached from `index.js` and `worker.js`). Equity market data has none because a probe would spend quota; here the dominant failure mode is valid credentials paired with a `production` label that was never published, which 404s every fetch and falls back to the local file forever. Without a probe an idle deployment stays `unverified` and cannot tell working prompts from that state. It is bounded (5s), `unref`'d, fail-open, per-prompt fault-isolated, and a no-op when the gate is off.

**`schemaDrift` is a rollout signal, not a failure.** `dependencies.langfuse.schemaDrift` surfaces the existing `PromptService.getSchemaDriftStatus()` under `/api/status`; a Langfuse prompt not republished after a local-fallback contract change (e.g. the #1031 anchors) appears there with its missing markers listed. Use the `langfuse-prompt-sync` skill to publish.

**All five `LANGFUSE_*` variables are environment-only for Remote Config parity**: the credentials are secrets, `LANGFUSE_BASE_URL` is an external destination, and the gate plus label are resolved at process startup. Nothing was added to `PARAMETER_SCHEMA` or `firebase-remote-config-template.json`.

**Coverage**: `tests/unit/prompt-readiness.test.js` (closed enum, classification, the five statuses, unverified→ready→degraded transitions, self-heal, no-latch, bounded map, in-place reset matching `_resetReadinessForTesting`, secret non-leakage, status reads registering nothing), `tests/unit/prompt-service-readiness.test.js` (attempt/success/failure/local-fallback recording through the real service, gate-off records nothing, per-prompt attribution, mid-incident self-heal, telemetry-never-throws), `tests/unit/prompt-readiness-probe.test.js` (no-op when off, every registered prompt probed, unpublished-label → `degraded`, per-prompt fault isolation, never rejects), `tests/integration/status-endpoint.test.js` (status projection in all five states), `tests/unit/render-blueprint-langfuse.test.js` (declared on both prompt-resolving services, previews off, no inline secret, not on the signal-outcome worker), `tests/unit/postman-collection.test.js` and `src/openapi/openapi.json` (`LangfusePromptDependency` schema plus four documented response variants).


**Current managed prompts**:
- search-query derivation
- grounded summary generation
- alert enrichment
- news analysis
- confidence enrichment
- Gemini market price fetch query


## Enriched Webhook Alert Output (004-enrich-alert-output)

The `/api/webhook/alert` flow can produce **structured enrichment** (in addition to sources) so alerts become actionable without leaving chat.

**What changes for developers**:
- When grounding is enabled, handlers attach an object at `alert.enriched` (see `src/controllers/webhooks/handlers/alert/grounding.js`) with fields like `sentiment`, `sentiment_score`, `insights`, `technical_levels`, optional risk parameters, and `sources`.
- Telegram uses `MarkdownV2Formatter.formatEnriched()` when `alert.enriched` is an object (see `src/services/notification/TelegramService.js`). WhatsApp follows its own formatter rules.
- Webhook responses include per-channel `results` plus a `tokenUsage` summary to help track LLM cost/usage.

**Graceful fallback**: if enrichment fails (timeout/API errors/malformed output), delivery proceeds with `alert.text` (fail-open).

## TradingView Volume Confirmation (007-volume-breakout-alerts)

The `/api/webhook/alert` flow (with `?useTradingViewData=true`) supports volume confirmation validation via the TradingView MCP server.

**Core Components**:
- `src/services/tradingview/TradingViewMcpService.js` — wrapper method `callVolumeConfirmation` and handling of volume confirmation integration during alert text analysis.
- `src/controllers/webhooks/handlers/alert/alert.js` — receives request query and triggers the enrichment pipeline.

**Behavior**:
- Gated by `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true` (default: `false`).
- If enabled, the service issues an asynchronous query to the `volume_confirmation_analysis` tool on the TradingView MCP server.
- The volume ratio check uses a fail-open pattern: if the call fails (e.g., timeout, network issue, bad symbol format), it logs a warning but proceeds with the rest of the enrichment data.
- If successful, it appends a key insight to the alert:
  - `"Volume confirms: YES ({ratio}x avg)"` (if ratio is >= 1.2)
  - `"Volume confirms: NO ({ratio}x avg)"` (if ratio is < 1.2)
- This volume confirmation is rendered in both Telegram and WhatsApp notification channels under the "Key Insights" section.

## TradingView Volume Confirmation API

The system also provides a dedicated `POST /api/webhook/volume-confirmation` endpoint for on-demand TradingView MCP volume checks without going through alert delivery.

**Request pattern**:
- Body must be a JSON object with `symbol` in full `EXCHANGE:SYMBOL` format, for example `BINANCE:BTCUSDT`.
- `timeframe` is optional and accepts the same MCP-supported intervals and aliases already used in TradingView flows.
- The endpoint reuses `TradingViewMcpService.callVolumeConfirmation()` and returns structured JSON including the normalized symbol, derived confirm/deny decision, numeric `volumeRatio`, and raw MCP payload as `analysis`.

**Failure behavior**:
- Invalid bodies or malformed symbols return `400 INVALID_REQUEST`.
- TradingView MCP failures return `502 VOLUME_CONFIRMATION_FAILED`.
- Existing alert fail-open behavior remains unchanged because this endpoint is separate from `/api/webhook/alert`.

**Where to look first when extending or debugging**:
- `src/routes/index.js` for route registration.
- `src/controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation.js` for request/response handling.
- `src/services/tradingview/volumeConfirmationRequest.js` for request parsing and decision derivation.
- `tests/integration/volume-confirmation-endpoint.test.js` for endpoint behavior coverage.

## TradingView Expanded Alert Reports

The system provides a `POST /api/webhook/expanded-analysis-alert` endpoint that builds a Spanish technical-analysis report from TradingView MCP `coin_analysis` data and sends the generated message through all enabled notification channels.

**Request pattern**:
- Body must provide `symbols` as complete TradingView identifiers (`EXCHANGE:SYMBOL`), for example `BINANCE:BTCUSDT`, `BINANCE:ETHUSDC`, or `NASDAQ:NVDA`.
- `timeframe` is optional and must be one of the MCP-supported intervals (`5m`, `15m`, `1h`, `4h`, `1D`, `1W`, `1M`); it falls back to `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` or `1D`.
- `analysisMode` is optional (`"standard"` or `"combined"`, defaults to `"standard"`). When set to `"combined"`, it calls the `combined_analysis` tool on the TradingView MCP server to retrieve technical indicators, Reddit sentiment analysis, RSS news headlines, and confluences.
- `includeMultiTimeframe` (or `include_multi_timeframe`) is an optional boolean (defaults to `false`). When `true`, it calls the `multi_timeframe_analysis` tool to fetch alignment confluences across Weekly, Daily, 4h, 1h, and 15m intervals.
- If body symbols are missing or empty, the handler falls back to `EXPANDED_ANALYSIS_ALERT_SYMBOLS` (comma-separated). If neither exists, it returns `400 NO_SYMBOLS`.
- Analysis has an endpoint-level deadline via `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS` (default 60s, capped at 120s) and bounded concurrency via `EXPANDED_ANALYSIS_ALERT_CONCURRENCY` (default 3, range 1-10). Completed symbols retain their results while unfinished symbols are marked `timeout` when the shared deadline aborts.

**Core Components**:
- `src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js` — request handler, per-symbol MCP orchestration, notification dispatch, and response assembly.
- `src/services/tradingview/TradingViewMcpService.js` — MCP JSON-RPC/Streamable HTTP client and `coin_analysis` wrapper.
- `src/services/tradingview/expandedAnalysisAlertReport.js` — request parsing, RSI grouping, trend/MACD/stop-loss derivation, and final Markdown report formatting.

**Failure behavior**:
- Individual MCP symbol failures are returned with `status: "error"` and omitted from the report.
- Timeout-aborted symbols are returned with `status: "timeout"`; if no symbols finish before the deadline, the endpoint returns `504 EXPANDED_ANALYSIS_ALERT_TIMEOUT` and does not send notifications.
- If all requested symbols fail, the endpoint returns `502 ALL_SYMBOLS_FAILED` and does not send notifications.
- If `includeMultiTimeframe` or `"analysisMode": "combined"` queries fail or timeout for a specific symbol, the handler uses a fail-open approach, logging the warning but proceeding with formatting the base technical report to avoid dropping the alert.
- The endpoint does not normalize crypto pairs; callers must pass full symbols such as `BINANCE:BTCUSDT`.

## TradingView Single-Symbol Analysis

`POST /api/webhook/symbol-analysis` analyzes one complete `EXCHANGE:SYMBOL` through TradingView MCP and returns the Spanish `alertText` plus normalized decision data without notification or order side effects.

- `src/controllers/webhooks/handlers/symbolAnalysis/symbolAnalysis.js` owns request validation, the bounded MCP call, optional multi-timeframe enrichment, risk normalization, and `BUY`/`SELL`/`NO_TRADE` decision output.
- `src/services/tradingview/expandedAnalysisAlertReport.js` is reused for symbol parsing and Markdown formatting; risk levels are directional for both long and short setups.
- `tests/integration/symbol-analysis-endpoint.test.js` covers the successful decision-ready response and malformed-symbol rejection.
- The route is API-key protected and documented in `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, and `README.md`.

If price, indicators, or directional risk are insufficient, the endpoint returns `decision.action: "NO_TRADE"` and numeric missing values as `null`.

## TradingView Market Scanner Alerts

The system provides a `POST /api/webhook/market-scanner-alert` endpoint that runs multiple market scans (e.g. top gainers, top losers, volume breakout, smart volume, bollinger squeeze) on TradingView MCP server, generates a formatted Spanish market summary, and delivers it to all enabled notification channels.

**Request pattern**:
- Body is a JSON object with optional parameters:
  - `exchange` — string (e.g. `BINANCE`, `NASDAQ`), defaults to `MARKET_SCANNER_DEFAULT_EXCHANGE` or `BINANCE`.
  - `timeframe` — string (e.g. `1h`, `4h`, `1D`), defaults to `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` or `4h`.
  - `scans` — array of scan types from `top_gainers`, `top_losers`, `volume_breakout_scanner`, `smart_volume_scanner`, `bollinger_scan`. Defaults to `['top_gainers', 'top_losers', 'volume_breakout_scanner']`.
  - `limit` — integer limit of items per scan, clamped to `[1, 20]`, default 5.
  - `bbw_threshold` — number representing Bollinger Band Width threshold for Bollinger squeeze scan, default 0.05.
  - `ranked` — boolean, default `false`; when `true`, reports and structured `scanResults[].scores[]` use the same filtered items and include numeric `score` plus non-empty `reason` fields.
  - `includeMultiTimeframe` (or `include_multi_timeframe`) — optional boolean, default `false`; when `true`, fetches fail-open TradingView `multi_timeframe_analysis` data for scanner candidates. Ranked scores apply a default `+10` aligned or `-10` counter-trend modifier and expose normalized `trendConfluence` metadata; reports highlight high-confidence alignment.
- The feature is gated by `ENABLE_MARKET_SCANNER=true`.
- Endpoint-level deadline is controlled by `MARKET_SCANNER_TIMEOUT_MS` (default 90s, capped at 120s).

**Core Components**:
- `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` — request handler, sequential scan executor, deadline manager, and notification dispatcher.
- `src/services/tradingview/marketScannerReport.js` — request parsing and validation, section/item formatter, and report builder.
- Ranked output shares `prepareMarketScannerItems()` between report rendering and response compaction so structured scores cannot diverge from the displayed ranking.
- `src/services/tradingview/TradingViewMcpService.js` — uses `callScanTool` method to invoke scanner tools on the TradingView MCP server.

**Failure behavior**:
- Individual scanner tool failures are recorded with status `error` and included as warning lines in the output report.
- Timeout-aborted scans are recorded as status `timeout`. If all scans fail or timeout, the endpoint returns 502/504 respectively.
- Validation failures (e.g. invalid timeframe, bad scan types) return 400.

**Per-symbol scanner error categorization** (GH-861 / CB-245):
- Every per-scan result with `status: 'error'` carries a non-empty `errorCategory` drawn from the closed enum in `src/services/tradingview/marketScannerErrorCategories.js`: `mcp_unreachable`, `mcp_timeout`, `mcp_rate_limited`, `mcp_tool_error`, `mcp_suspended`, `symbol_invalid`, `symbol_unsupported`, `unknown`.
- The Telegram/WhatsApp report renders the category in parentheses next to the message (e.g. `⚠️ Error: MCP server connection refused (mcp_unreachable)`).
- `summary.errorCategoryCounts` in the response surfaces the totals for every category so operators can distinguish one MCP outage from many symbol-specific failures.
- `/api/alerts/summary` aggregates the persisted `scannerErrorCategories` from delivered scanner runs and exposes `summary.scanner.{totalRuns, errorCategoryCounts}` under the bounded 31-day window.
- `/api/status` exposes `dependencies.tradingViewMcp.errorCategoryCounts` (rolling 24h) with the legacy circuit-breaker categorization so spikes in `mcp_rate_limited` / `timeout` are easy to alert on.
- Sentry captures the category as the `mcp_error_category` tag on scanner failures; alerts remain fail-open.

**Where to look first when extending or debugging**:
- `src/routes/index.js` for endpoint route definition.
- `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` for scan orchestration and deadline management.
- `src/services/tradingview/marketScannerReport.js` for layout and item-specific formatters.
- `src/services/tradingview/marketScannerErrorCategories.js` for the closed enum and classifier.
- `src/services/storage/AlertStorageService.js` for the `scannerErrorCategories` field sanitization and summary aggregation.
- Tests in `tests/integration/market-scanner-endpoint.test.js`, `tests/unit/market-scanner-report.test.js`, `tests/unit/market-scanner.test.js`, `tests/unit/market-scanner-error-categories.test.js`, `tests/integration/scanner-expanded-alert-storage.test.js`, `tests/integration/status-endpoint.test.js`, and `tests/integration/alerts-endpoint.test.js`.

## Asynchronous TradingView Jobs

The system provides asynchronous job endpoints to support executing both `expanded-analysis` and `market-scanner` workflows in the background, avoiding HTTP gateway timeouts.

**Endpoints**:
- `POST /api/jobs/tradingview-analysis` — Validates request payloads synchronously, returns `201 Created` with a `jobId`, and starts background execution. An optional `idempotency-key` header deduplicates concurrent/sequential starts for five minutes.
- `GET /api/jobs` — Returns a bounded list of sanitized recent jobs, with optional `status`, `type`, and `limit` filters. It merges Firestore-backed records with the in-memory fallback and excludes expired terminal jobs.
- `GET /api/jobs/:jobId` — Returns the current job status (`pending`, `processing`, `completed`, `failed`), progress, and final analysis/delivery outcomes.
- `POST /api/jobs/:jobId/retry` and `POST /api/jobs/:jobId/retry-failed` — Recreate a retryable job or only failed items; the same optional `idempotency-key` replay contract returns the original `newJobId` without a second worker.

**Core Components**:
- `src/services/jobs/JobService.js` — Coordinates job state tracking, background worker execution, progress reports, durable persistence checkpoints, and job eviction (jobs older than 1 hour).
- `src/services/jobs/JobRepository.js` — Stores and lists sanitized job records in memory and, when `ENABLE_FIRESTORE_JOB_STORAGE=true`, in Firestore collection `tradingviewJobs`; claims, renewals, retry releases, terminal failures, and worker saves use Firestore transactions keyed by worker and processing attempt to preserve ownership.
- `src/services/jobs/JobQueue.js` — Enqueues only durable `jobId` references in Redis/BullMQ, reports queue readiness without exposing `REDIS_URL`, and recreates failed producer connections without disabling later submissions.
- `src/services/jobs/jobWorker.js` / `worker.js` — Claims queued jobs through Firestore transactions, periodically re-enqueues durable rows still marked `processing`/`queued` or holding expired `claimed`/`running` leases, renews active claims while external work is in flight, releases claims only when BullMQ has another attempt, persists final worker failures, tracks terminal callback delivery during shutdown, and drains the worker on `SIGTERM` without stopping an unlaunched Telegraf transport.
- `src/controllers/webhooks/handlers/jobs/jobs.js` — HTTP route controller handlers (`postCreateJob`, `getJobList`, `getJobStatus`).
- `src/controllers/commands.js` — Telegram `/analisis` and `/scanner` commands create these jobs, preserve the originating `telegramChatId`, and must `await jobService.createJob()` before replying or handling validation/storage errors. `/jobs` and `/trabajos` list bounded job summaries or show one job's progress/result/delivery status with fail-open storage errors.

**Failure and Edge Case Behavior**:
- Sync validation: throws `400` synchronously on invalid inputs before job registration.
- Idempotency: job-starting POST endpoints reserve the optional `idempotency-key` before validation/worker launch, replay matching responses with `Idempotency-Replay: true` and `idempotencyReplayed: true`, and return `409 IDEMPOTENCY_CONFLICT` when a key is reused with a different request fingerprint. `JOB_QUEUE_ACCEPTANCE_UNKNOWN` 503 responses remain replayable and include the durable `jobId`, so retries do not create a second UUID or queue item. Nested object keys are canonicalized for the fingerprint while array order remains significant. Requests without a key are unchanged. A replayed body is also **re-correlated**: `sendCachedResponse` rewrites `requestId` to the replaying request's id, because the cached body carries the *original* request's id while the request deadline, the `X-Request-Id` header, and the structured access log all carry the new one — without the rewrite, one response would advertise a correlation id that appears nowhere in the logs for the replay.
- Feature checks: returns `404 FEATURE_DISABLED` if market scanner jobs are created but `ENABLE_MARKET_SCANNER` is not `'true'`.
- Persistence: `createJob()` and `getJob()` are async because job metadata/results may be written to or read from Firestore.
- Render worker and poller modes: set `JOB_EXECUTION_MODE=render-worker` (with `REDIS_URL` and durable Firestore credentials) for BullMQ queue execution, or `JOB_EXECUTION_MODE=firestore-poller` (with durable Firestore credentials and optional `JOB_POLL_INTERVAL_MS`) for direct Firestore polling without Redis. In queue mode, the web process returns `503 JOB_QUEUE_UNAVAILABLE` when the queue cannot accept work; if enqueue acknowledgement and deterministic reconciliation both fail, it returns `503 JOB_QUEUE_ACCEPTANCE_UNKNOWN` with the durable `jobId`, preserves the queued durable record, and keeps the idempotency response replayable. The worker periodically scans durable `processing`/`queued` rows and expired `claimed`/`running` leases, retries retained failed BullMQ jobs before adding a duplicate stable ID, and recovers queue work after Redis or worker persistence outages. `JOB_QUEUE_*` settings control attempts, backoff, concurrency, leases, and connection timeout. Final BullMQ failures become terminal `failed` jobs and trigger configured failure callbacks; if the terminal transition was already committed, later failure handling still reconciles the configured callback before acknowledgement. Notification delivery writes a durable pre-send/completed checkpoint; a redelivery with an unknown outcome fails closed as `JOB_DELIVERY_RECONCILIATION_REQUIRED` instead of replaying an external side effect, while a post-delivery checkpoint persistence failure preserves the completed outcome and retries the final durable write. The default `local` mode is unchanged.
- Durable worker saves reject stale writes that would replace a terminal Firestore job state, and ownerless nonterminal saves cannot replace an active claim; claim release and failure transitions verify the worker's actual Firestore claim attempt transactionally, retrying or requeueing terminal failure persistence while storage recovers. Same-worker, same-attempt renewals that observe the worker's terminal finalization are accepted without changing terminal state. A worker checkpoint that discovers a terminal cancellation raises `JOB_CLAIM_LOST` before notification delivery, pre-claim redeliveries do not release or fail another attempt's claim, and terminal redeliveries reconcile unsent callbacks before acknowledgement. Status-filtered Firestore list queries are bounded server-side before the worker reconciliation scan.
- Telegram commands: async `createJob()` rejections must stay inside the command `try/catch` so `replyValidationError()` can return clear command feedback instead of producing unhandled promise rejections.
- Telegram `/analisis` and `/scanner` (`createTradingViewJobCommand`) check `tradingViewMcpService.getStatus()` before `createJob()`; when readiness is `degraded`, they send a Spanish warning (`⚠️ TradingView MCP está degradado (último error: <label>). El job se creará pero puede fallar.`) and still create the job (user choice). `ready` and `unknown` produce no warning; readiness probes that throw are caught and fail open so the job is still created. The warning covers the same categories surfaced via `/api/status` (`http_5xx`, `http_4xx`, `timeout`, `invalid_response`, `request_failed`, `circuit_breaker_open`). The existing market scanner HTTP readiness check (issue #632) already follows this pattern; this is the Telegram parity.
- Eviction: terminal jobs (`completed`, `failed`, `cancelled`, `timed_out`) older than 1 hour are deleted from memory/Firestore and return `404 Not Found`; active jobs are preserved.
- Durable retention: `JobRepository.save()` writes `expiresAt = createdAt + 1 hour` only for terminal Firestore jobs. `ops/configure-firestore-alert-retention.sh` backfills legacy terminal `tradingviewJobs` records and enables the native Firestore TTL policy; active jobs are skipped and TTL deletion remains eventually consistent while API reads filter expired jobs.
- Background failures: if the worker runs into unexpected exceptions or timeouts, the job is marked `failed` and reported to Sentry.
- Market-scanner jobs preserve `ranked` and `includeMultiTimeframe` in request metadata and apply the same higher-timeframe confluence enrichment as the synchronous scanner endpoint. Enrichment is fail-open; if the job deadline aborts after a scan completes, that scan is retained and only remaining scans are marked `timeout`.
- Completed ranked market-scanner job status and terminal callback payloads expose `scanResults[].scores[]` with the same score, reason, and optional `trendConfluence` fields as the synchronous endpoint.
- Async Callbacks: If `callbackUrl` is provided, callbacks are dispatched for configured `callbackEvents` (`processing`, `completed`, `failed`, `cancelled`, `timed_out`). Each HTTP delivery includes `x-callback-timestamp`, `x-callback-event`, and a UUID `x-callback-delivery-id`; when a secret is configured, `x-callback-signature` is HMAC-SHA256 over those headers plus the raw JSON body joined with newlines. Retries generate a new delivery ID and signature per attempt. Durable callback events are claimed transactionally as `in_flight` before sending; active claims suppress non-awaited duplicate redeliveries, awaited terminal redeliveries surface `JOB_CALLBACK_DELIVERY_IN_FLIGHT` so BullMQ retries after the 60-second lease, processing claims are suppressed after the durable job reaches a terminal state, and expired claims can be taken over. Worker-owned saves merge current durable callback metadata instead of replacing it with a stale snapshot. Callback-claim/status storage failures fail open for non-awaited web callbacks but propagate from awaited worker terminal callbacks so BullMQ can retry; stale delivery-token updates remain confirmed no-ops. The callback process otherwise fails open, writing log events and updating job metadata (`callbackStatus`) without affecting the core job status. `callbackStatus.attempts` remains the compatibility log, and `callbackStatus.events[event]` tracks per-event in-flight/success/failure state so a successful `processing` callback does not suppress a later terminal callback. Durable callback metadata is merged transactionally from the current job snapshot so it cannot replay a claimed worker document.
- Render Blueprint worker wiring mirrors Telegram, WhatsApp, Discord, Firebase, TradingView, callback signing/validation overrides, and all Sentry controls from the web service so queued deliveries, callback policy, and monitoring work in worker mode.

**Where to look first when extending or debugging**:
- `src/services/jobs/JobService.js` for background processing and state transitions.
- `src/controllers/webhooks/handlers/jobs/jobs.js` for parameters parsing.
- Tests in `tests/unit/job-service.test.js`, `tests/unit/jobs-controller.test.js`, and `tests/integration/jobs-endpoint.test.js`.

## Service Status and Capabilities API

The system provides status and capability querying endpoints to verify service configuration and dependency readiness.

**Endpoints**:
- `GET /api/status` — Checks feature gates, enabled notification channels, and dependency states (e.g., testing Firestore connection and verifying TradingView MCP connection).
- `GET /api/capabilities` — Alias of `/api/status`, returning identical JSON data.

**Core Components**:
- `src/controllers/status.js` — Compiles the capabilities payload with feature flags, notification channels, and active integrations.
- `src/routes/index.js` — Registers the routes behind the `validateApiKey` middleware.
- `src/services/notification/DeliveryMetricsService.js` — In-memory per-channel delivery SLA counters (`success`, `failure`, `successRate`, `averageDeliveryMs`, `window`) tracked from `NotificationManager.sendToAll`/`sendToChannels` and exposed on `/api/status`/`/api/capabilities` as the optional `deliveryMetrics` section (omitted when nothing has been recorded).
- `src/services/storage/FirestoreWriteMetricsService.js` — In-memory per-domain Firestore write attempt, success, failure, and successRate counters exposed under `dependencies.firestoreWriteMetrics` when non-null.

**Failure and Edge Case Behavior**:
- The API gates checks behind the `validateApiKey` middleware.
- Dependency checking (like querying the TradingView MCP or testing Firestore credentials) is done safely and returns detailed state status (`ready`, `error`, `unconfigured`) in a clean JSON format.
- `deliveryMetrics` is fail-open: `NotificationManager._recordDeliveryMetrics()` substitutes the total dispatch duration when a channel result's `durationMs` is missing or not a finite number, so those deliveries still count toward the latency averages rather than being excluded; only a duration that is still not a finite, non-negative number when it reaches `DeliveryMetricsService.record()` is left out of the average, and neither layer blocks delivery. Counters reset on process restart (acceptable for operational monitoring) and never return values for channels that have not recorded any deliveries.
- `firestoreWriteMetrics` is fail-open: increments are wrapped in try/catch and never throw; counters reset on process restart and the `dependencies.firestoreWriteMetrics` object is omitted entirely until at least one write has been attempted.

## Alert Delivery SLA & Error Budget Metrics (GH-687)

`GET /api/status` and `/api/capabilities` now expose an optional `deliveryMetrics` section reporting in-memory per-channel delivery success/failure counts, success rate, and average delivery latency aggregated across the current process lifetime. The section is omitted entirely until at least one channel records a delivery; counters reset on process restart.

**Core Components**:
- `src/services/notification/DeliveryMetricsService.js` — Window-based in-memory counters with fail-open `record()` (malformed payloads logged as warnings, never thrown).
- `src/services/notification/NotificationManager.js` — `_recordDeliveryMetrics()` hook runs after both `sendToAll` and `sendToChannels`, falling back to total dispatch duration when an individual channel does not report `durationMs`.
- `src/controllers/status.js` — Adds the `deliveryMetrics` key only when the snapshot is non-null.
- `src/openapi/openapi.json` — New `DeliveryMetrics` and `DeliveryChannelMetrics` schemas documented.
- `CabrosBot.postman_collection.json` — Adds a "Get Status - delivery SLA" request with the populated payload example.

**Coverage**:
- `tests/unit/delivery-metrics-service.test.js` — Counter increment, successRate math, latency average, malformed-input rejection, and reset behavior.
- `tests/integration/status-endpoint.test.js` — `deliveryMetrics` omitted when empty, populated per-channel after records, and surfaced on `/api/capabilities`.

No new environment variable, endpoint, Remote Config key, or notification contract was added; this is a non-secret operational status addition.

## Firestore Write Observability & Persistence Metrics (GH-695)

`GET /api/status` and `/api/capabilities` now expose an optional `dependencies.firestoreWriteMetrics` section reporting in-memory write metrics (`window`, `writesAttempted`, `writesSucceeded`, `writesFailed`, `successRate`, and per-domain breakdowns under `byDomain`). The section is omitted entirely until at least one write has been attempted; counters reset on process restart.

**Core Components**:
- `src/services/storage/FirestoreWriteMetricsService.js` — In-memory window-based counters with fail-open `recordWriteSuccess(domain)` and `recordWriteFailure(domain)` (silently ignores invalid input, never throws).
- `src/services/storage/AlertStorageService.js` — Records write successes and failures for `alerts` and `alertReplays` domains, including early failures when Firestore client initialization returns null while storage is enabled.
- `src/services/jobs/JobRepository.js` — Records write successes and failures for the `jobs` domain during durable job state persistence.
- `src/controllers/status.js` — Conditionally spreads `dependencies.firestoreWriteMetrics` when `firestoreWriteMetricsService.getSnapshot()` returns non-null.
- `src/openapi/openapi.json` — Schemas for `FirestoreWriteMetrics` and `FirestoreWriteDomainMetrics`.
- `CabrosBot.postman_collection.json` — Adds a "Get Status - firestore write metrics" request with populated, omitted, and 401 unauthorized response examples.

**Coverage**:
- `tests/unit/firestore-write-metrics-service.test.js` — Verifies snapshot null before writes, success/failure counting, domain breakdown, success rate calculation, fail-open error handling, and test reset.
- `tests/integration/status-endpoint.test.js` — Verifies omission before writes, populated payload after alert/job persistence, and alias support on `/api/capabilities`.
- `tests/unit/postman-collection.test.js` — Verifies Postman status examples for populated, omitted, and unauthorized write metrics variants.

No new environment variable, endpoint, Remote Config key, or notification contract was added; this is a non-secret operational status addition.

## External Uptime Monitoring (Issue #1107)

Production liveness is detected from **outside** the deployment. On 2026-08-31 the hosting platform removed the production deployment platform-side (trial expiry); the public URL answered `404 {"status":"error","code":404,"message":"Application not found"}` and nothing detected it for six days, because every check that lived inside the deployment — including the self-reported `/healthcheck` and the in-repo smoke probe — was structurally blind to it.

- `ops/external-uptime-monitor.js` — dependency-free Node CLI that probes the public `GET /healthcheck` (and optionally `/docs`) with native `fetch` + `AbortController` bounds and prints one line of JSON. `.github/workflows/external-uptime-monitor.yml` runs it every 5 minutes; `.github/workflows/external-uptime-watchdog.yml` asserts the monitor is still being scheduled.
- **The monitor is secretless by design and must stay that way.** `/healthcheck` is mounted in `app.js` before `validateApiKey` and before the rate limiter, so no API key is required. The in-repo smoke probe (`ops/production-smoke-probe.sh`) is the *authenticated* layer and needs `WEBHOOK_API_KEY`; keeping the two separate is what stops an unset secret from hollowing the external detector (the #971 failure class).
- **A `200` that is not the application is a failure.** `HEALTHCHECK_BODY_UNEXPECTED` (exit `4`) fires when the body does not carry the `uptime` field, so a proxy placeholder, CDN interstitial, or platform removal page can never read as healthy. Exit codes are a closed enum: `0 UP`, `3 HEALTHCHECK_UNREACHABLE`, `4 HEALTHCHECK_BODY_UNEXPECTED`, `5 DOCS_UNREACHABLE`, `6 BASE_URL_INVALID`, `7 MONITOR_INTERNAL_ERROR`. `7` exists so a broken monitor reports DOWN; it must never exit `0`.
- **Alert routing.** A non-zero exit fails the scheduled job, which is GitHub's own zero-configuration notification. The optional Telegram page is fail-open, fires only on a DOWN transition and on recovery (never once per interval during a continuing outage), and is driven by the previous run's conclusion read from the Actions API. A `workflow_dispatch` run does not page unless `force_page` is set.
- **Not an application-owned environment variable.** `UPTIME_MONITOR_BASE_URL`, `UPTIME_MONITOR_CHECK_DOCS`, `UPTIME_MONITOR_TIMEOUT_MS` and `UPTIME_WATCHDOG_MAX_AGE_MINUTES` are GitHub **repository variables**, and the two Telegram values are repository **secrets**. Nothing was added to `.env.example`, `RemoteConfigService`, `firebase-remote-config-template.json`, `src/openapi/openapi.json` or `CabrosBot.postman_collection.json`: no application runtime, endpoint, flag, or response shape changed, and no secret is committed.
- **Coverage**: `tests/unit/external-uptime-monitor.test.js` (exit-code enum, body-contract honesty, timeout, base-URL sanitization, `shouldPage` truth table, fail-open secret-free paging, plus process-level CLI tests that would have caught an entrypoint ignoring `argv`) and `tests/unit/external-uptime-workflows.test.js` (pinned `actions/checkout` + `persist-credentials: false`, no `continue-on-error` / `|| true` on the probe step, no `WEBHOOK_API_KEY`, watchdog cron phase distinct from the monitor's, exit codes and variables documented).
- **Platform changes are a checklist, not a code change.** Updating `UPTIME_MONITOR_BASE_URL`, the third-party provider monitor, and the documented origins is a required step of any migration — see the re-activation checklist in `docs/monitoring.md`.

## Multi-Channel Notification Architecture (002-whatsapp-alerts)

The alert delivery system now supports parallel delivery to multiple channels (Telegram, WhatsApp) without blocking. Key patterns:

**Service Layer** (`src/services/notification/`):
- `NotificationChannel.js` — Abstract base class defining send(alert), validate(), isEnabled() contract
- `TelegramService.js` — Wraps Telegraf bot.telegram.sendMessage() with MarkdownV2 parsing
- `WhatsAppService.js` — GreenAPI integration with chunked delivery for payloads above the 20K char limit, 10s timeout, retry logic
- `NotificationManager.js` — Orchestrates: validateAll() at startup, sendToAll() in parallel via Promise.allSettled()

**Formatting** (`src/services/notification/formatters/`):
- `MarkdownV2Formatter.js` — Escapes special chars (_ * [ ] ( ) ~ ` > # + - = | { } . !) for Telegram; preserves link URLs
- `WhatsAppMarkdownFormatter.js` — Strips unsupported syntax (links → plain text, underline removed); logs conversions

**Retry Logic** (`src/lib/retryHelper.js`):
- sendWithRetry(sendFn, maxRetries=3, logger) with exponential backoff (1s, 2s, 4s) + ±10% jitter
- Per-channel retry (one channel failure doesn't block others)
- Returns SendResult { success, channel, messageId?, error?, attemptCount, durationMs }

**Alert Flow**:
1. Webhook receives text (plain or JSON)
2. Optional Gemini enrichment (stored in alert.enriched) — single call, reused across channels
3. notificationManager.sendToAll(alert) fires in parallel
4. Returns 200 OK with per-channel results (fail-open pattern)

**Configuration**:
- WhatsApp disabled by default (ENABLE_WHATSAPP_ALERTS=false for backward compat)
- Requires: WHATSAPP_API_URL, WHATSAPP_API_KEY, WHATSAPP_CHAT_ID (format: 120363xxxxx@g.us)
- Telegram requires existing: BOT_TOKEN, TELEGRAM_CHAT_ID. Inline Replay callbacks additionally require the comma-separated environment-only `TELEGRAM_ACTION_OPERATOR_USER_IDS` allowlist; it is a security control excluded from Firebase Remote Config.

**Extending**:
- Add new channel: Create class extending NotificationChannel, implement send(), validate(), isEnabled()
- Register in NotificationManager constructor
- Create tests in tests/unit/ and tests/integration/

Where to look first when extending or debugging
- `index.js` for lifecycle and bot wiring (initializes services before bot launch and registers the process shutdown coordinator)
- `src/controllers/webhooks/handlers/alert/alert.js` for webhook flow and notificationManager.sendToAll()
- `src/services/notification/NotificationManager.js` for parallel send orchestration
- `src/services/notification/WhatsAppService.js` for retry logic, GreenAPI integration, and chunked delivery
- `src/lib/retryHelper.js` for exponential backoff timing
- Tests in `tests/integration/` for multi-channel scenarios (dual-channel, config validation, graceful degradation)

If anything in this file is unclear or you want more examples (tests, extra command patterns, or a CI/dev workflow), tell me which area to expand and I'll iterate.

## News Monitoring with Sentiment Analysis (003-news-monitor)

The system provides an HTTP endpoint (`/api/news-monitor`) that analyzes financial news and market sentiment for crypto and stock symbols, detects significant trading events, and delivers alerts via configured channels.

**Core Components** (`src/controllers/webhooks/handlers/newsMonitor/`):
- `newsMonitor.js` — Main HTTP endpoint handler (POST/GET at `/api/news-monitor`)
- `analyzer.js` — Symbol analysis orchestrator; handles parallel processing and timeouts
- `enrichment.js` — Optional secondary LLM enrichment service (via Azure AI Inference)
- `cache.js` — In-memory deduplication cache with TTL (default: 6 hours per symbol/event-category pair)
- `urlShortener.js` — URL shortening utility for WhatsApp citations (uses native fetch for supported services with fallback to direct API calls)

**Grounding Service Integration** (`src/services/grounding/`):
- Reuses existing Gemini GoogleSearch grounding for **both** market sentiment analysis (`analyzeNewsForSymbol`) and price fetching (`fetchGeminiPrice`)
- **News Analysis** (`analyzeNewsForSymbol`): Fetches `"${symbol} news market sentiment events today"` → returns structured `{ event_category, event_significance, sentiment_score, sources }` (preferred) or unstructured text with fallback parsing
- **Price Fetching** (`fetchGeminiPrice`): Fetches `"current price of ${symbol} today"` → extracts numeric price and 24h change % from grounded search snippets using regex patterns; parses price (pattern: `$123.45` or `123.45 USD`), change (pattern: `+5.2% 24h`), and gracefully returns null/empty context if parsing fails
- Supports event categories: `price_surge` (bullish), `price_decline` (bearish), `public_figure` (mentions), `regulatory` (official statements)
- Graceful degradation: If Gemini search fails or timeout exceeded, system returns analysis/price without market context (alerts still sent based on news sentiment alone)

**Optional Binance Integration**:
- When `ENABLE_BINANCE_PRICE_CHECK=true`, fetches precise crypto prices from Binance API (~5s timeout)
- Falls back to Gemini GoogleSearch for price context if Binance unavailable or symbol is not crypto
- Does not validate symbol classification; requester responsible for correct crypto/stocks separation

**Alert Flow**:
1. Endpoint receives request with crypto and stock symbol arrays (or defaults from `NEWS_SYMBOLS_CRYPTO`/`NEWS_SYMBOLS_STOCKS` env vars)
2. Symbols analyzed in parallel; each symbol has 30s timeout budget. `NEWS_GEMINI_CONCURRENCY` can cap concurrent Gemini-backed symbol analyses to reduce provider quota bursts; unset preserves legacy full fan-out.
3. Gemini extracts market context and sentiment; confidence score calculated: `confidence = (0.6 × event_significance + 0.4 × |sentiment|)`
4. Optional LLM enrichment (if `ENABLE_LLM_ALERT_ENRICHMENT=true`) refines confidence using conservative strategy: `min(gemini_confidence, llm_confidence)`
5. Alerts filtered by `NEWS_ALERT_THRESHOLD` (default: 0.7)
6. Deduplicated: cache key is `(symbol, event_category)`. Same category within TTL prevents duplicate alerts; different categories generate separate alerts
7. **URL shortening applied to WhatsApp citations** (if `URL_SHORTENER_SERVICE` configured): Uses native fetch for supported services (`picsee`, `tinyurl`, `cuttly`); preserves original URLs if shortening fails
8. Filtered alerts sent to all enabled channels (Telegram, WhatsApp) via existing NotificationManager in parallel
9. Returns 200 OK with per-symbol results: status (analyzed/cached/timeout/error), detected alerts, delivery results, metadata (totalDurationMs, cached, requestId), and summary counters including `quota_exhausted` for exhausted Gemini 429 retries.

**Dry-run request mode:** Add `dryRun=true` to GET or POST `/api/news-monitor` (query parameter; POST also accepts the boolean body field) to run validation and analysis without notification delivery, deduplication cache reads/claims/writes, or signal-outcome persistence. The response includes `dryRun: true`, generated alerts, intended `requestedChannels`, and an empty `deliveredChannels` array. Dry runs bypass cached results so operators inspect fresh analysis output.

### News Monitor Domain-Quality Confidence Penalty (Issue #1230)

`calibrateNewsConfidence()` in `src/services/grounding/gemini.js` now applies a bounded **multiplicative** domain-quality penalty on top of the existing additive source-count, freshness, and authority penalties.

Previously the `domainQuality` tier classifier (`src/services/grounding/domainQuality.js`, `src/services/grounding/qualityTiers.js`) leaked out of the module without feeding back into confidence: three blog-spam sources scored identically to three reputable financial sources, so a weak signal could clear `NEWS_ALERT_THRESHOLD` on source count alone.

**Penalty pipeline** (in order):
1. `baseConfidence = 0.6 × event_significance + 0.4 × |sentiment_score|`
2. Additive penalties (source count, freshness, authority, uncertainty, invalidation hint) → `penaltyAdjustedConfidence`
3. Multiplicative quality-tier penalty → `qualityPenalty`
4. Clamp into `[0, 1]`

**Tier multipliers** — the *weakest* (most penalty-bearing) tier present in the source set wins, so one blog-spam source cannot be masked by reputable ones:

| Tier | Multiplier | Rationale |
|---|---|---|
| `high` | `×1` | Reputable wire/financial press, regulators, exchange disclosures — baseline, no penalty |
| `medium` | `×0.95` | Recognizable finance/crypto outlets |
| `low` | `×0.85` | Aggregator/UGC platforms and low-editorial-control TLDs (`.blog`, `.buzz`, `.xyz`, …) |
| `unknown` | `×1` (no penalty) | Domain absent from the classification lists (~56 domains total) — unclassified, not judged weak |

**Safety properties** (all covered by tests):
- **Monotonicity**: every multiplier is `<= 1`, so the calibrated result is **non-increasing** vs. the pre-#1230 value for every input. This is a false-positive *reduction* feature; it can never inflate a score. `tests/unit/event-detection.test.js` asserts this against a fixed matrix of pre-change oracle values.
- **Fail open**: a missing, blank, or malformed tier is a **no-op** (no penalty, no crash). A throwing `domainQuality` classifier is caught, logged at `warn`, and discarded — calibration falls back to model-emitted metadata exactly as before.
- **No double-penalty on empty grounding**: when grounding returns zero sources the source-count penalty (`-0.3`) already applies, so the quality step is skipped and `qualityTier` stays `null`.
- **No threshold change**: `NEWS_ALERT_THRESHOLD` keeps its `0.7` default. The multiplier is applied *before* the threshold comparison, so the effective bar rises for weak-source signals while the configured default is untouched.

**Observability**: `calibration.qualityTier` and `calibration.qualityPenalty` are always present (issue #1230) so an operator can audit *why* an alert cleared the threshold. The resolved tier is also surfaced as `alert.sourceQualityTier` and rendered as a `Source Quality: <tier> (x<multiplier>)` line in the delivered Telegram/WhatsApp message, and as `confidence_reason` text.

**Where to look first**:
- `src/services/grounding/gemini.js` — `QUALITY_TIER_PENALTIES`, `resolveWeakestQualityTier()`, and the penalty step in `calibrateNewsConfidence()`
- `src/services/grounding/domainQuality.js` / `qualityTiers.js` — tier classification inputs
- `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` — `buildAlert()` and `formatAlertMessage()` tier surfacing
- `tests/unit/event-detection.test.js` — tier-penalty, monotonicity, and fail-open coverage
- `tests/unit/analyzer.test.js` — alert-payload and message surfacing coverage

**Configuration**:
- `ENABLE_NEWS_MONITOR` — Feature flag (default: false for safe rollout)
- `ENABLE_NEWS_MONITOR_TEST_MODE` — Expose news monitor test-mode state in `/api/status` and `/api/capabilities` (default: false)
- `ENABLE_NEWS_MONITOR_CLASSIFIER` — Optional classifier.dev second pass when Gemini returns `none` (default: false); only recognized categories at or above `NEWS_ALERT_THRESHOLD` are promoted, and request failures preserve `none`. Because it sends the asset symbol and generated headline to an external provider, keep it environment-only and exclude it from Firebase Remote Config. `/api/status` reports its state as `featureFlags.newsMonitorClassifier`.
- `NEWS_SYMBOLS_CRYPTO` — Default crypto symbols if not provided in request (comma-separated, e.g., "BTCUSDT,ETHUSD")
- `NEWS_SYMBOLS_STOCKS` — Default stock symbols if not provided in request (comma-separated)
- `NEWS_ALERT_THRESHOLD` — Confidence score threshold (default: 0.7, range 0.0-1.0). Unchanged by #1230; the domain-quality multiplier is applied *before* this comparison, so the effective bar rises for weak-source signals without moving the configured default.
- `NEWS_CACHE_TTL_HOURS` — Cache time-to-live (default: 6 hours)
- `NEWS_CACHE_MAX_ENTRIES` — Maximum in-memory news-cache entries before LRU eviction (default: `5000`, range `1`-`1000000`; Remote Config supported)
- `NEWS_DELIVERY_LOCK_MAX_ENTRIES` — Maximum in-memory channel delivery leases (default: `1000`, range `1`-`100000`; active leases are preserved)
- `NEWS_TIMEOUT_MS` — Per-symbol analysis timeout (default: 30000 ms)
- `NEWS_GEMINI_CONCURRENCY` — Max concurrent Gemini-backed symbol analyses. Production policy is `3`; leave unset only for backward-compatible legacy full fan-out.
- `NEWS_GEMINI_QUOTA_MAX_RETRIES` — Per-symbol retry count for Gemini `429 RESOURCE_EXHAUSTED` errors (default: 2)
- `NEWS_GEMINI_QUOTA_RETRY_BASE_MS` — Base exponential backoff in milliseconds when provider retry metadata is absent (default: 1000)
- `NEWS_MAX_ALERTS_PER_BATCH` — Maximum alerts delivered per request (default: 10, bounds: 1-50; Remote Config supported)
- `NEWS_MAX_ALERTS_PER_WINDOW` — Maximum alerts delivered by the current process during the sliding window (default: 20, bounds: 1-200; Remote Config supported)
- `NEWS_MAX_ALERTS_PER_WINDOW_MS` — Sliding volume-window duration in milliseconds (default: 300000, bounds: 1000-3600000; Remote Config supported)
- `ENABLE_BINANCE_PRICE_CHECK` — Enable Binance crypto price fetching (default: false)
- `ENABLE_LLM_ALERT_ENRICHMENT` — Enable optional secondary LLM enrichment (default: false)
- `URL_SHORTENER_SERVICE` — URL shortening service for WhatsApp citations (default: `picsee`; options: `picsee`, `tinyurl`, `cuttly`)
- `URL_SHORTENER_CACHE_MAX_ENTRIES` — Maximum in-memory URL-shortener cache entries before LRU eviction (default: `1000`, range `1`-`100000`; Remote Config supported)
- `URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES` — Maximum tracked URL-shortener providers (default: `32`, range `1`-`1024`; effective minimum is the number of configured providers)
- Service-specific tokens: `PICSEE_API_KEY` and `CUTTLY_API_KEY`; TinyURL requires no token. Bitly, reurl, and Pixnet0rz.tw are unavailable.
- Azure AI Inference (if enrichment enabled): `AZURE_LLM_ENDPOINT`, `AZURE_LLM_KEY`, `AZURE_LLM_MODEL`

**Timeout Strategy**:
- Binance fetch: ~5s timeout (aggressive)
- Gemini/GoogleSearch: ~20s timeout (generous fallback)
- Optional LLM enrichment: ~10s timeout per symbol
- URL shortening: ~5s timeout per call (with 3 retries)
- Per-symbol total: 30s (accounts for worst-case retry scenarios with exponential backoff)
- Batch response: waits up to 30s total; returns partial results if some symbols timeout

**Retry Logic**:
- Binance: 3 retries with exponential backoff (1s, 2s, 4s) + ±10% jitter
- Gemini news analysis: retries `429 RESOURCE_EXHAUSTED` per symbol inside `NEWS_TIMEOUT_MS`, honoring provider retry delay metadata when present and returning `GEMINI_QUOTA_EXHAUSTED` when exhausted
- Optional LLM enrichment: 3 retries (independent from analysis; failure doesn't block alert)
- URL shortening: 3 retries with exponential backoff (independent; failure preserves original URLs)
- Telegram/WhatsApp: 3 retries (reuse existing notification retry logic)

**Cache Deduplication**:
- In-memory Map cache; key is JSON stringified `(symbol, event_category)` tuple
- Value: `{ alert, timestamp, enrichment_data (if applicable) }`
- TTL enforced on read; expired entries evicted automatically
- Different event categories for same symbol bypass cache (separate alerts per category)
- Cached partial delivery replays only missing or failed channels, refreshes persistent state before retry decisions, preserves finalized local state over an older remote `claiming` sentinel, waits for claimed retry deltas to persist before releasing leases, scopes local and persistent merges to claimed-channel deltas without extending the original TTL, preserves Firestore expiry metadata when warming local state, compares effective default destinations, stores only Discord webhook fingerprints, binds persistent leases to owner tokens, aborts/fences each retry channel after proven ownership loss, treats renewal storage errors as indeterminate fail-open, evicts released expired locks, filters historical/lease-denied results, preserves explicit channel/destination metadata, and skips writes after local expiry/eviction.

**Extending**:
- Add new event category: Update Gemini prompt in `analyzer.js` to detect and tag new category
- Add new LLM model for enrichment: Create new service in `src/services/inference/` extending pattern from `enrichmentService.js`
- Add new URL shortening service: Extend `urlShortener.js` to support new service via native fetch
- Add new notification channel: Extend NotificationChannel in `src/services/notification/` and register in NotificationManager (existing pattern)

**Where to look first when extending or debugging**:
- `index.js` for lifecycle (initializes the news-monitor cache before bot startup when `ENABLE_NEWS_MONITOR=true`, then uses the shared process shutdown coordinator)
- `src/routes/index.js` for `/api/news-monitor` route registration
- `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` for Gemini prompts, confidence formula, and timeout orchestration
- `src/controllers/webhooks/handlers/newsMonitor/cache.js` for deduplication logic and TTL management
- `src/controllers/webhooks/handlers/newsMonitor/urlShortener.js` for URL shortening logic and cache
- `src/services/inference/enrichmentService.js` for secondary LLM enrichment and conservative confidence selection
- Tests in `tests/integration/news-monitor-*.test.js` for endpoint behavior, caching, enrichment fallback
- Tests in `tests/unit/analyzer.test.js`, `tests/unit/cache.test.js`, `tests/unit/url-shortener.test.js` for core logic

## Active Technologies
- Node.js 24.x (from `.node-version` and package.json engines) + Express 4.17+, telegraf 4.3+; NO new HTTP client (use native fetch)
- GreenAPI for WhatsApp (REST API integration via native fetch with AbortController timeout)
- Google Gemini for optional alert enrichment (existing integration in grounding service) and news sentiment analysis (003-news-monitor)
- Azure AI Inference REST client for optional secondary LLM enrichment (003-news-monitor, disabled by default)
- Native fetch for URL shortening in WhatsApp citations (003-news-monitor, with fallback to original URLs)
- In-memory Map cache for news deduplication with TTL (003-news-monitor, no external storage)
- Binance API client for precise crypto prices (003-news-monitor, optional fallback to Gemini GoogleSearch)
- TradingView MCP remote Streamable HTTP server for technical `coin_analysis` report generation (`POST /api/webhook/expanded-analysis-alert`)
- Sentry SDK for Node (`@sentry/node` v10.53.1) for backend runtime error monitoring and warn/error console log capture (005-sentry-runtime-errors; no tracing by default)
- Cloud Firestore via `firebase-admin` v12.x for server-side alert document persistence and optional server-side Remote Config loading (006-firestore-alert-storage; fail-open)
- Firebase Local Emulator Suite via pinned `firebase-tools` for opt-in Firestore integration tests (CB-124 / Issue #302; never used by the default test command)

## Firestore Alert Storage (006-firestore-alert-storage)

Every successful `POST /api/webhook/alert` request is persisted as a document in the `alerts` Firestore collection after the HTTP response has been sent.

**Core Components**:
- `src/services/storage/AlertStorageService.js` — lazy `firebase-admin` singleton, `saveAlert()` wrapper, read/export helpers (`listAlerts()`, `exportAlerts()`, `getAlertById()`), fail-open write handling
- `src/controllers/alerts/alerts.js` — HTTP controller for stored alert list/export/detail endpoints

**Data Model** (collection: `alerts`, document ID: auto-generated):

| Field | Type | Description |
|---|---|---|
| `receivedAt` | Timestamp | Server-side timestamp (FieldValue.serverTimestamp()) |
| `text` | string | Original alert text (max 20,000 chars) |
| `enriched` | boolean | Whether enrichment ran |
| `enrichmentData` | map \| null | Full `alert.enriched` object from Gemini/TradingView |
| `tokenUsage` | map \| null | `tokenUsage.toJSON()` result including `formattedSummary` |
| `deliveryResults` | array | Per-channel `SendResult` objects from `notificationManager.sendToAll()` |
| `source` | string | Originating flow: `"webhook"` or `"news-monitor"` |
| `useTradingViewData` | boolean | Whether `?useTradingViewData=true` was set on the request |
| `tradingViewEnrichmentApplied` | boolean | Whether a TradingView MCP result was successfully applied |
| `eventCategory` | string \| undefined | News-monitor records only: detected event category (e.g. `price_surge`) |
| `confidence` | number \| undefined | News-monitor records only: alert confidence score |
| `sentimentScore` | number \| undefined | News-monitor records only: Gemini sentiment score |
| `dedupStatus` | string \| undefined | News-monitor records only: `fresh` for new analyses, `cached` for successful redeliveries |
| `expiresAt` | timestamp | `receivedAt` plus `ALERT_STORAGE_RETENTION_DAYS`; configured as a Firestore TTL field |

## Firebase Credential Fail-Fast at Startup (Issue #1128)

`src/services/storage/firebaseAdminCredentials.js` separates **unconfigured** from **invalid** so storage callers can reject a misconfiguration at startup instead of discovering it inside the SDK.

- `resolveFirebaseAdminCredentials()` returns `status: 'configured' | 'unconfigured' | 'invalid'` plus `appOptions`, which is **`null` only for `invalid`**. A single `null` for both cases is what previously let callers call `admin.initializeApp({})` after a failed credential check.
- `initializeFirebaseAdminApp()` is the shared storage bootstrap. It returns `ok: false` **without touching the SDK** when credentials are configured but invalid, and the caller falls back to memory immediately. Initializing with `{}` would enter the SDK default-auth path, where the first read or write pays for authentication and network round-trips and then fails.
- `loadFirebaseAdminCredentialsOrNull()` keeps its ambiguous `null` and its warn-once behavior for existing callers. `buildFirebaseAppOptions()` is deprecated for the same reason — it still returns `{}` for both cases and is unused in `src/`.

Callers routed through it: `IdempotencyStorageService`, `NewsDedupStorageService`, `AlertStorageService`, and `ChatPreferenceService`. Each logs a service-tagged warning carrying the error `code`. `adminAuth.js` is deliberately unchanged — its throwing loader already fails closed without reaching `initializeApp`.

Preserved behavior:

- **No credential source configured** still calls `initializeApp({})`, so Application Default Credentials (managed runtimes, `FIREBASE_PROJECT_ID`-only) keep working.
- **`FIREBASE_CREDENTIALS_UNSUPPORTED_TYPE` (issue #1127) now also skips initialization.** An inline `authorized_user` / `external_account` document is refused by the loader because ADC resolves a file, never an inline value. Under #1128 that refusal is reported as `invalid`, so storage callers fall back to memory instead of calling `initializeApp({})` — authenticating with a *different* credential than the operator configured. `resolveFirebaseAdminCredentials()` still never calls `credential.applicationDefault()` for it.
- The well-known `gcloud` ADC file remains an **optional probe**: a malformed one still falls through to `unconfigured` rather than failing the process.
- `isFirestoreConfigured()` (`firestoreConfig.js`) remains the independent credential-*shape* check behind `dependencies.firestore.configured`, so a deployment can still report `configured: true` and fail here — shape validation does not prove the SDK can use the document.

Coverage: `tests/unit/firebase-admin-credentials.test.js` (three statuses, `initializeApp` never called for `invalid`, ADC path retained) and `tests/unit/firebase-credential-failure-init.test.js` (each storage service returns `null`/memory for malformed inline JSON, a missing credential path, and a malformed credential document). Operator runbook: `docs/troubleshooting.md`.

No environment variable, Remote Config key, endpoint, or OpenAPI contract changed.

**Credential Configuration** (choose one):
- **Option A** — `GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json` (file path, good for local dev)
- **Option B** — `FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}` (inline JSON string, preferred for Render.com secrets)

**Configuration**:
- `ENABLE_FIRESTORE_ALERT_STORAGE` — Feature flag (default: false)
- `ALERT_STORAGE_RETENTION_DAYS` — Validated alert/replay retention window in days (`1`-`3650`, default: `90`); expired records are filtered before reads and new records carry `expiresAt`
- `FIREBASE_PROJECT_ID` — Optional project ID override (usually embedded in the service account JSON)

**Failure Behavior** (fail-open):
- `saveAlert()` never throws — all Firestore errors are caught and logged as `console.warn`
- Storage is fire-and-forget: `res.json()` is sent **before** the Firestore write is awaited
- If `ENABLE_FIRESTORE_ALERT_STORAGE` is not `'true'`, `getFirestore()` returns `null` immediately
- If `firebase-admin` initialization fails (bad credentials, wrong project), `db` is set to `null` and a warning is logged; subsequent calls are no-ops

**Read API**:
- `GET /api/alerts` returns stored alerts ordered by `receivedAt` descending with `limit`, `before`, `source`, `enriched`, and `include` query support (`include=enrichment_summary` projects a sanitized, bounded `enrichmentSummary` object and sanitized `enrichmentData` on each alert item, eliminating N+1 detail calls for analysis).
- `GET /api/alerts/export` returns bounded JSONL or CSV (`format=jsonl|csv`) for stored alerts. It requires both `from` and `to`, caps `limit` at 1000, caps the window at 31 days, supports `source`, `enriched`, `includeText=true`, and `includeEnrichment=true`, and only includes safe export fields. Raw alert text is excluded by default and truncated to 1000 chars when included; safe bounded enrichmentData is excluded unless `includeEnrichment=true`. CSV prefixes direct or tab/LF/CR-prefixed formula-leading string fields with an apostrophe for spreadsheet safety while leaving finite numeric strings unchanged; JSONL is unchanged.
- `GET /api/alerts/summary` returns bounded JSON-only analytics for stored alerts, with `from`, `to`, and `limit` query support capped to a 31-day window and 1000 documents.
- `GET /api/alerts/:alertId` returns a single formatted alert document by Firestore document ID.
- `POST /api/alerts/:alertId/replay` reloads an immutable stored alert, rebuilds the current notification payload, dispatches it to requested channels (`telegram`, `whatsapp`, or both by default), and records the replay attempt in the separate `alertReplays` Firestore collection. It requires API-key auth and an idempotency key (`idempotency-key` header or `idempotencyKey` body/query field).
- `listAlerts()`, `summarizeAlerts()`, `exportAlerts()`, and `getAlertById()` in `src/services/storage/AlertStorageService.js` format Firestore documents into API-safe JSON with the following fields:
  - `id`
  - `receivedAt`
  - `text`
  - `enriched`
  - `enrichmentData`
  - `tokenUsage`
  - `deliveryResults`
  - `source` (`webhook` or `news-monitor`)
  - `useTradingViewData`
  - `tradingViewEnrichmentApplied`
  - optional news-monitor metadata when present: `eventCategory`, `confidence`, `sentimentScore`, `dedupStatus`
- Read filtering for `source` and `enriched` is applied in memory after `receivedAt`-ordered batches to avoid introducing new composite Firestore index requirements.
- Retention filtering is also applied in memory because Firestore TTL deletion is eventual. Run `bash ops/configure-firestore-alert-retention.sh` to backfill legacy documents from `receivedAt` or `replayedAt` before enabling TTL deletion for both collection groups; the script shortens existing expiries when the configured deadline is earlier, hashes and removes legacy raw replay keys, reports counts, and fails on records without a usable timestamp.
- Read endpoints must map Firestore initialization/read failures to `503 STORAGE_UNAVAILABLE` instead of a generic `500`.
- Replay attempts must not mutate the original `alerts` document. Use `saveReplayAttempt()` to write each attempt with a unique document ID based on `alertId`, a SHA-256 idempotency-key hash, timestamp, and UUID in `alertReplays`; only the hash is stored, alongside the same `expiresAt` retention policy. The HTTP Idempotency-Replay contract remains upstream in the idempotency middleware.
- Export responses must not expose API keys, service-account data, webhook secrets, raw provider credentials, full `enrichmentData`, or raw provider responses. Keep delivery status compact (`channel`, `success`, `messageId`, `errorCode`, `statusCode`) and token usage numeric-only.
- When extending the alerts read API, preserve `receivedAt` as the primary sort key but encode `nextBefore` with a deterministic tie-breaker (document ID) so paginated reads do not skip same-timestamp alerts, and preserve API-key protection on both list and detail routes.

**Alert Flow Integration** (`src/controllers/webhooks/handlers/alert/alert.js`):
```
Webhook → validate → enrich → sendToAll → res.json() → saveAlert() [fire-and-forget]
```
Storage happens **after** the HTTP response; the caller is never blocked.

**Where to look first when extending or debugging**:
- `src/services/storage/AlertStorageService.js` — initialization, credential parsing, `saveAlert()`, `listAlerts()`, `exportAlerts()`, and `getAlertById()` logic
- `src/controllers/alerts/alerts.js` — list/export/detail request validation and response shaping
- `src/controllers/webhooks/handlers/alert/alert.js` — fire-and-forget call site (after `res.json()`)
- Tests in `tests/unit/alert-storage-service.test.js` and `tests/integration/alerts-endpoint.test.js`
- Firebase Console → Firestore → `alerts` collection for live document inspection

## Firestore Emulator Integration Tests (CB-124 / Issue #302)

The opt-in `pnpm test:firebase` command runs a separate Jest configuration against the Firestore emulator using the `demo-cabros` project ID. It removes production Firebase credential variables, sets `FIRESTORE_EMULATOR_HOST`, `GCLOUD_PROJECT`, and `FIREBASE_PROJECT_ID`, and delegates lifecycle cleanup to `firebase emulators:exec`.

**Coverage**:
- `tests/firebase/firestore-emulator.test.js` uses the real Admin SDK for alert storage, idempotency transactions, async job persistence, scanner presets, and signal-outcome reads/writes.
- The same suite uses `@firebase/rules-unit-testing` to assert unauthenticated client reads and writes remain denied by `firestore.rules`.
- Emulator data is cleared before each test; the default `pnpm test` stays mock-based and does not require Java, Firebase CLI downloads, or network access.

**Tooling**:
- `firebase-tools` and `firebase` are pinned in `package.json` for reproducible local/CI setup.
- `.github/workflows/node.js.yml` installs JDK 21, caches emulator binaries, runs `pnpm test:firebase`, then runs the existing full Jest suite.

## Terminology Guide: Grounding vs Enrichment

The system uses two complementary terms with specific meanings:

### **Grounding** (Technical Term)
- Refers to **Google's Grounding Tools API** and GoogleSearch integration
- Used in internal service architecture: `/src/services/grounding/`
- Implementation detail: how we fetch verified sources and context
- Example: `ENABLE_GEMINI_GROUNDING` env var, `groundingService.enrich()` method

### **Enrichment** (User-Facing Term)
- Refers to the **user value delivered**: alerts enhanced with context and sources
- Used in alerts, documentation, and user messaging
- Business concept: traders receive enriched data for better decisions
- Example: `alert.enriched` data structure, "enriched alerts" in README

### Key Mapping

| Feature | Technical Service | User Benefit | Env Var |
|---------|-------------------|--------------|---------|
| 001 | Grounding (Gemini) | Enriched alerts with sources | ENABLE_GEMINI_GROUNDING |
| 002 | NotificationManager | Enriched alerts on WhatsApp | ENABLE_WHATSAPP_ALERTS |
| 003 | News analysis + Grounding | Enriched news alerts | ENABLE_NEWS_MONITOR |
| 004 | Webhook alert output enrichment | Structured sentiment/insights/levels for `/api/webhook/alert` | ENABLE_GEMINI_GROUNDING |
| 005 | Runtime error monitoring | Capture unexpected runtime errors (side-effect only) | ENABLE_SENTRY |
| 007 | TradingView Volume Confirmation | Volume confirmation check for Webhook alerts | ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION |
| 009 | TradingView Confluence Enrichment | `combined_analysis` and optional multi-timeframe context for webhook alerts | ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT |

### Usage Guidelines

**When documenting or adding features:**
- Use **"grounding"** when describing technical implementation details
- Use **"enrichment"** when describing user-facing features or data structures
- Keep `ENABLE_GEMINI_GROUNDING` as-is (Gemini-specific flag name)
- Use `alert.enriched` for all enrichment data (agnostic to method)

**For new services (e.g., Feature 004):**
- Don't create new grounding service unless using Google's Grounding Tools API
- All enrichment methods contribute to the same `alert.enriched` data
- This approach allows switching enrichment providers without breaking alerts

See `/specs/TERMINOLOGY_GUIDE.md` for extended discussion and examples.


- GH-401 / CB-163: `src/admin/admin.js` validates both the `backend` query parameter and `cabros_backend_origin` localStorage override against an exact HTTPS origin allowlist before using them for API requests. Firebase Hosting defaults to `https://openclaw.tail5e4271.ts.net`; the OpenClaw origin and `https://cabros-bot-production.up.railway.app` remain the only allowed overrides. Arbitrary origins, wildcards, HTTP URLs, and malformed values fall back to the same-origin or Firebase-hosted default. `tests/unit/admin-client.test.js` covers rejection of an attacker-controlled override, and the generated Firebase Hosting asset must stay synchronized with `pnpm run build:hosting`. The allowlist code itself is unchanged by the Issue #1294 deep-link work, which added sibling query-string state on the same URL; `buildConsoleUrl()` preserves `backend` across every view write and canonicalisation, with explicit regression coverage in `tests/unit/admin-client.test.js`.
- GH-402 / CB-164: the hosted admin console `loadAuthConfig()` fetch is now bounded by an 8-second `AbortController` timeout; an aborted or stalled `/admin/auth-config` request resolves through the existing `{ enabled: true, configured: false }` fallback so the console renders "Firebase sign-in is unavailable" instead of hanging on "Checking authentication…". The vm-based admin client test harness provides controllable timers and a fake `AbortController`, with regression coverage for the stall-then-timeout path in `tests/unit/admin-client.test.js`.
- GH-366 / CB-150: durable TradingView jobs now receive a one-hour `expiresAt` on terminal Firestore writes; the shared Firestore retention backfill/configuration covers legacy terminal `tradingviewJobs` documents while leaving active jobs untouched. Unit and Firebase Emulator coverage verify terminal expiry and active-job preservation.
- GH-533 / CB-236: operational Firestore retention now enables native TTL and backfills legacy `notificationDeadLetters` documents using `NOTIFICATION_REDRIVE_MAX_AGE_MS`; existing idempotency and news-dedup retention behavior remains unchanged. Unit coverage verifies the collection mapping.
- GH-313 / CB-128: grounding asset-context parsing now preserves slash-delimited crypto pairs such as `BTC/USDT`; the fallback no longer truncates a symbol before `/`, while explicit exchange and TradingView signal parsing remain unchanged. Regression coverage is in `tests/unit/tradingview-signal-parser.test.js`.
- GH-291 / CB-112: hardened Render-worker job acceptance and recovery. Indeterminate enqueue responses preserve a replayable idempotency result with the durable `jobId`; the worker periodically reconciles durable queued rows and expired claims after Redis recovery, retries retained failed BullMQ jobs, terminal checkpoint races abort before notification delivery, status-filtered list queries preserve recent-first ordering while bounding Firestore scans, and terminal BullMQ failure handling retries pending callbacks even after the terminal job state was already committed. Production worker/Key Value provisioning remains payment-gated.
- GH-284 / CB-118: Production Gemini quota recurrence was traced to an unset `NEWS_GEMINI_CONCURRENCY` with a Sentry `POST /api/news-monitor` dry-run carrying 28 symbols. Production uses the existing scheduler with `NEWS_GEMINI_CONCURRENCY=3`; analysis now runs inside the Sentry span so `summary.quota_exhausted` plus the `news.quota_exhausted` and `news.error_count` attributes remain correlated operational signals. Sentry measured 61 quota events through 2026-07-28T13:44:03Z against a Gemini free-tier limit of 15 requests/minute for the affected model; no current percentile or complete request-count measurement is inferred from that error window.
- GH-287 / CB-119: Added opt-in Twelve Data equity market-data evaluation for `BATS`, `NASDAQ`, `NYSE`, `AMEX`, and `NYSE ARCA` signals. Entry prices use `/quote`; bounded historical `/time_series` bars calculate return, MFE, and MAE across existing windows. Provider failures remain unavailable/fail-open, metrics expose exchange/provider coverage, and `/api/status`, README, OpenAPI, Postman, and `.env.example` document readiness without secrets. Production remains disabled until plan/licensing and live-provider validation are completed.
- GH-292 / CB-122: added an opt-in Render Background Worker entrypoint for signal-outcome evaluation, role-gated web/worker scheduling, graceful dedicated-worker drain, safe heartbeat counters, and paid-worker Blueprint wiring. Production cutover is now a role change: `ENABLE_SIGNAL_OUTCOME_TRACKING` is pinned `true` on the web service with `SIGNAL_OUTCOME_WORKER_ROLE=web`, and the `signalOutcomeLocks` lease (GH-1110) keeps exactly one evaluator while both are configured, so moving the sweep to the paid worker no longer requires a lock-step reconfiguration.
- GH-318 / CB-130: propagated the existing opt-in `ENABLE_SENTRY` and `SENTRY_DSN` settings to the signal-outcome worker Blueprint as manual values; the worker stays monitoring-disabled when either value is absent.
- GH-320 / CB-132: TradingView signal parsing and alert-storage extraction now preserve underscore-delimited exchange identifiers such as `FX_IDC:USDCLP(D)`; known non-equity venues (`FX_IDC`, `CME_MINI`, `CBOT_MINI`) stay neutral even when symbols resemble crypto suffixes, while unlisted equity exchanges retain the stock default. Known symbol, timeframe, auth, delivery, and fail-open behavior remain unchanged; focused parser/storage regressions cover recovered exchange, symbol, non-equity precedence, futures, and unlisted-equity metadata.
- GH-319 / CB-131: added a static parity guard for application-owned environment reads and documented the audited controls in `.env.example`, README, and `agents.md`. Platform-injected, test-only, and deprecated aliases are explicitly classified; runtime defaults remain unchanged.
- GH-314 / CB-129: added idempotent HTTP/process shutdown coordination with a bounded `SHUTDOWN_TIMEOUT_MS` deadline, news-monitor startup/cache cleanup ownership, active `JobService` and callback drain, Telegram polling/handler drain, final Sentry flush, and forced connection close fallback. Existing feature gates and notification behavior remain unchanged.
- GH-329 / CB-133: webhook alert persistence now records a bounded non-negative `processingTimeMs` before the response, preserves legacy latency fields in summary aggregation, and keeps Firestore storage fail-open; no public API or notification contract changed.
- 001-gemini-grounding-alert (improvements with PR #21, #20, #19): Added Gemini GoogleSearch grounding integration for alert enrichment; added Brave Search fallback/override; introduced provider routing (Gemini/Azure/OpenRouter); added token usage + cost estimation surfaced in notifications; graceful degradation on API failure; single grounding call reused across channels.
- 002-whatsapp-alerts: Added multi-channel notification system with TelegramService, WhatsAppService, NotificationManager; exponential backoff retry logic; MarkdownV2 and WhatsApp markdown formatters; comprehensive integration tests for parallel delivery, config validation, graceful degradation.
- issue #91 / branch `codex/fix-91-whatsapp-truncation`: WhatsApp delivery now splits GreenAPI payloads above the provider limit into sequential chunks instead of silently truncating with an ellipsis; regression coverage added for long alert payloads.
- 003-news-monitor (improvement with PR #18; CB-34): Added `/api/news-monitor` endpoint for financial news analysis and sentiment-based alerts; Gemini GoogleSearch integration for market context; optional secondary LLM enrichment via Azure AI Inference (migrated to `@azure-rest/ai-inference`); in-memory deduplication cache; optional Binance price integration; parallel symbol analysis with timeout management; configurable Gemini concurrency and quota-exhaustion retries; configurable event detection; URL shortening for WhatsApp citations.
- 004-enrich-alert-output: Enriched `/api/webhook/alert` output with structured fields (sentiment, insights, technical levels, and optional risk parameters) using the existing grounding pipeline; Telegram/WhatsApp formatters render structured enrichment when present.
- 005-sentry-runtime-errors (PR #16): Added runtime error monitoring via `SentryService` + early initialization in `instrument.js`, plus Express error handler wiring; monitoring is gated by `ENABLE_SENTRY` + `SENTRY_DSN`.
- 006-firestore-alert-storage: Added Cloud Firestore persistence for every `/api/webhook/alert` payload; `firebase-admin` singleton initialized from `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`; fire-and-forget after `res.json()` so storage never blocks delivery (fail-open).
- GH-800 / CB-?: Added `POST /api/alerts/feedback` (👍/👎 trader verdicts) and `GET /api/alerts/feedback/summary` (per-source/per-symbol/per-exchange aggregates with SHA-256 chat-hash privacy). The `/api/alerts/summary` response now always includes a `feedback` block alongside `enrichment`/`delivery`/`latency`; `/api/status` exposes `featureFlags.alertFeedback` and `dependencies.alertFeedback`. Backed by a new `alertFeedback` Firestore collection (opt-in via `ENABLE_FIRESTORE_ALERT_FEEDBACK=true`, retention via `ALERT_FEEDBACK_RETENTION_DAYS`, both bounded `1`-`3650`); re-clicks with the same `(alertId, chatId)` tuple update the verdict instead of appending. Raw chat ids are never returned by the summary surface; Firestore outage falls back to a process-local in-memory store (fail-open, same `STORAGE_UNAVAILABLE` semantics). `AlertStorageService.canInitializeFirestore` includes the new flag so `firebase-admin` initializes when only feedback storage is enabled. Documentation in README, OpenAPI, Postman, and `.env.example`; unit + integration coverage in `tests/unit/alert-feedback-storage-service.test.js` and `tests/integration/alert-feedback-endpoint.test.js`.
- GH-302 / CB-124: Added the opt-in Firestore emulator integration suite and CI gate with a pinned Firebase CLI, demo project isolation, Admin SDK coverage for existing Firestore-backed services, and deny-by-default client rules assertions.
- 007-volume-breakout-alerts: Added TradingView volume confirmation check to the webhook alert enrichment flow (POST /api/webhook/alert?useTradingViewData=true) using the `volume_confirmation_analysis` tool from the TradingView MCP server. Configured via `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION`.
- GH-173 / CB-69: `/api/status` and `/api/capabilities` expose `featureFlags.tradingViewVolumeConfirmation` plus `dependencies.tradingViewVolumeConfirmation` readiness, including the parent MCP enrichment gate, without changing the existing volume-confirmation gate.
- GH-174 / CB-70: `/api/status` and `/api/capabilities` expose `featureFlags.firestoreJobStorage` plus `dependencies.firestoreJobStorage` readiness for the dedicated job-storage gate and the legacy alert-storage gate, without changing runtime persistence behavior.
- GH-176 / CB-72: `/api/status` and `/api/capabilities` expose `featureFlags.newsMonitorTestMode` from `ENABLE_NEWS_MONITOR_TEST_MODE`, without changing existing test-mode behavior.
- GH-177 / CB-73: `/api/status` and `/api/capabilities` expose `featureFlags.cloudflareAig` from `ENABLE_CLOUDFLARE_AIG`, alongside the existing Cloudflare AI Gateway dependency readiness.
- 009-tradingview-confluence-alerts (CB-44 / Issue #131): Added optional confluence enrichment for POST /api/webhook/alert?useTradingViewData=true. `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true` calls `combined_analysis` within the same enrichment budget, annotates/downgrades contradictory confluence, and returns `confluenceData` in dry-run/stored enrichment payloads. `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true` also calls `multi_timeframe_analysis` and returns `multiTimeframeData`.
- GH-293 / CB-125: Repointed the default TradingView MCP endpoint to the active Render host, added process-local runtime readiness (`unknown`/`ready`/`degraded`) with sanitized error categories and counters, and exposed `tradingViewEnrichmentApplied` plus `byFeatureFlag.tradingViewDataApplied` so requested and successfully applied MCP data are distinguishable.
- 008-async-job-callbacks (CB-28, CB-52 / Issue #150 follow-up): Added support for asynchronous job completion callbacks in TradingView analysis and market scanner jobs. Clients can specify callbackUrl, callbackSecret, and callbackEvents in POST /api/jobs/tradingview-analysis requests. The server signs the payloads with an HMAC-SHA256 signature, validates parameters (with node-only URL validation), and executes retries with exponential backoff on transient network failures, failing open without affecting the core job status. Callback delivery is tracked per event in `callbackStatus.events` while preserving the aggregate `callbackStatus.attempts` log.
- GH-188 / CB-80: Added timestamp, event, and per-delivery UUID headers to async callbacks. HMAC signatures now bind the anti-replay metadata and raw body; retries receive unique delivery IDs, and callback attempt records retain each ID.
- async-job-terminal-eviction (CB-54 / Issue #151): `JobService` now uses one terminal-status set for cleanup and terminal checks, so expired `cancelled` and `timed_out` jobs are evicted like `completed` and `failed` jobs while `processing` jobs remain available.
- news-monitor-persistent-dedup (CB-38 / Issue #120): Added optional Firestore-backed persistent deduplication store for news monitor alerts; converted cache operations to asynchronous; added fail-open fallback to in-memory mode; exposed active dedup mode/backend readiness in `/api/status`.
- shadow-mode-outcome-tracking (CB-42 / Issue #129): Added shadow-mode outcome tracking for alert-producing surfaces (webhook alerts, market scanner breakouts/gains/losses, expanded-analysis, news alerts). Normalizes signal metadata (requestId, source, symbol, exchange, timeframe, setupType, score, side, price, etc.) and periodically evaluates outcomes over +1h, +4h, +1D, and +1W windows using Binance historical candlestick data. Exposes aggregated metrics under `shadowModeMetrics` inside `GET /api/alerts/summary` and in custom header `X-Shadow-Mode-Metrics` inside `GET /api/alerts/export`.
- GH-593 / CB-? (win metrics contract alignment): Documented the `shadowModeMetrics` payload (per-window `hitRatePercent`, `targetHitRatePercent`, `stopHitRatePercent`, `expectancyR`, return/MFE/MAE averages, drawdown proxy, latency/cost metadata) and the `X-Shadow-Mode-Metrics` export header in `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, README (Win metrics semantics), and agents.md. Added a dedicated `ShadowModeMetrics` schema that distinguishes the string sentinel `"No measurements found"` from the full `OutcomesSummary` object form. Win-rate field semantics: `hitRatePercent` counts evaluated window outcomes with `return > 0`; `targetHitRatePercent`/`stopHitRatePercent` count explicit target/stop hits (including `firstHit` fallbacks) over barrier-eligible denominators only; `expectancyR` averages finite `rMultiple` over evaluated windows. Cross-reference #550 for the TP/SL divergence discussion. No runtime behavior change.
- GH-178 / CB-74: `ENABLE_SIGNAL_OUTCOME_TRACKING` was established as the canonical signal-outcome gate; the `ENABLE_SHADOW_MODE_OUTCOME_TRACKING` compatibility alias was retained for one release and is now retired in GH-451 / CB-198.
- GH-182 / CB-77: malformed or no-domain grounding sources count toward the declared UNKNOWN `0.5` quality tier instead of contributing zero; regression coverage lives in `tests/unit/event-detection.test.js`.
- GH-187 / CB-79: added authenticated `GET /api/jobs` with bounded `status`, `type`, and `limit` filters; `JobRepository.list()` merges Firestore and memory records, while `JobService.listJobs()` omits expired terminal jobs and returns metadata-only summaries.
- GH-239 / CB-96: job creation, retry, and retry-failed endpoints now use the shared bounded in-memory idempotency middleware, replay matching responses, and reject fingerprint conflicts with `409 IDEMPOTENCY_CONFLICT`; OpenAPI, README, Postman, and integration coverage were updated.
- GH-241 / CB-98: `/api/news-monitor` supports opt-in dry-run analysis for GET and POST requests; it returns generated alerts and intended routing while skipping notification delivery, deduplication cache mutation, and signal-outcome persistence. OpenAPI, README, Postman, and integration coverage were updated.
- GH-183 / CB-78: Azure, OpenRouter, and Cloudflare `llmCallv2()` results now return normalized token usage for downstream `tokenUsage` aggregation; the shared normalizer accepts OpenAI-compatible `prompt_tokens`, `completion_tokens`, and `total_tokens` fields.
- GH-199 / CB-83: `detect-unused-features` derives disabled flags, status mappings, indirect env lookups, `.env.example` gaps, and Sentry profiling findings from the fresh protected capabilities response and current repository files; dated snapshots are guidance-free and a healthy-data dry run guards against stale issues.

## Architectural Patterns & Extension Guide

### Multi-Channel Notification Pattern (002)

**Core Pattern**: Abstract channel + concrete implementations + manager orchestrator

```
NotificationChannel (abstract)
├── TelegramService (concrete)
├── WhatsAppService (concrete)
└── [Future channels]

NotificationManager
├── validateAll() at startup
└── sendToAll() in parallel
```

**To add a new channel**:
1. Create class extending `NotificationChannel` in `src/services/notification/`
2. Implement: `send(alert)`, `validate()`, `isEnabled()`
3. Create formatter in `src/services/notification/formatters/` if needed
4. Register in `NotificationManager` constructor
5. Add env vars for configuration
6. Add unit tests in `tests/unit/`
7. Add integration tests in `tests/integration/`

**Example: SMS Channel**:
```javascript
class SMSService extends NotificationChannel {
  send(alert) { /* Use AWS SNS or Twilio */ }
  validate() { /* Check credentials */ }
  isEnabled() { return process.env.ENABLE_SMS_ALERTS === 'true'; }
}
```

### Grounding Service Pattern (001, 003)

**Core Pattern**: Reusable Gemini + GoogleSearch orchestrator with graceful degradation

**Usage locations**:
- Alert enrichment (001): Single call per webhook
- News sentiment analysis (003): Single call per symbol

**To extend**:
1. **New prompt strategy**: Update `src/services/grounding/gemini.js` system prompt
2. **New response format**: Modify parser in `src/services/grounding/grounding.js`
3. **New use case**: Reuse `grounding.js` via existing `genaiClient.js` wrapper

**Key design principles**:
- Single API call (cost-efficient, results reused across channels)
- Graceful fallback to original text (never blocks delivery)
- Structured response parsing with unstructured fallback
- Timeout budgets strictly enforced (~8s for alerts, ~20s for news)

### Event Detection Pattern (003)

**Core Pattern**: Gemini prompt → confidence scoring → threshold filtering → caching → delivery

**Event categories**: `price_surge`, `price_decline`, `public_figure`, `regulatory`

**To add new category**:
1. Update Gemini prompt in `src/controllers/webhooks/handlers/newsMonitor/analyzer.js`
2. Extend event detection logic to tag new category
3. Update confidence scoring if different weight needed: `confidence = (0.6 × significance + 0.4 × |sentiment|)`
4. Update cache key generation (includes event_category)
5. Add tests for new category detection

**Confidence Formula**:
```
confidence = (0.6 × event_significance + 0.4 × |sentiment|)
```
- Conservative: favors precision (lower threshold for delivery)
- Adjustable: Modify weights or thresholds via `NEWS_ALERT_THRESHOLD` env var

### In-Memory Cache Pattern (003)

**Core Pattern**: Map-based cache with TTL enforcement and key deduplication

**Cache key strategy**: `(symbol, event_category)` tuple
- Same category = deduplicated
- Different categories = separate entries
- Efficient: O(1) lookup, manual TTL cleanup

**To extend**:
1. Add new cache dimensions: Modify key generation in `src/controllers/webhooks/handlers/newsMonitor/cache.js`
2. Persistent cache (Phase 2): Replace Map with Redis/MongoDB while keeping same interface
3. Cache metrics: Add tracking for hit/miss rates (debug only)

### Retry Logic Pattern (All features)

**Core Pattern**: Exponential backoff with jitter via `src/lib/retryHelper.js`

```javascript
retryHelper.sendWithRetry(
  async () => { /* API call */ },
  maxRetries = 3,
  logger = console
)
```

**Returns**: `{ success, channel, messageId?, error?, attemptCount, durationMs }`

**To extend**:
1. **New retry strategy**: Update `retryHelper.js` backoff calculation
2. **Adaptive timeout**: Modify per-call timeout based on external API health
3. **Metrics integration**: Add duration tracking (already included in response)

**Current backoff**: 1s → 2s → 4s ± 10% jitter

### Parallel Processing Pattern (003)

**Core Pattern**: Promise.allSettled() for independent symbol analysis

**Key design**:
- Each symbol has independent timeout (30s default)
- Partial failure is acceptable (return both completed and timeout results)
- No cascading: One symbol timeout doesn't affect others

**To extend**:
1. **Concurrency limits**: Add semaphore pattern if needed (currently unbounded)
2. **Priority queue**: Prioritize high-confidence symbols first
3. **Streaming responses**: Return results as they complete (requires WebSocket/SSE)

### Feature Flag Pattern (All features)

**Core Pattern**: Environment-driven feature gating

```
ENABLE_GEMINI_GROUNDING (001)
ENABLE_WHATSAPP_ALERTS (002)
ENABLE_NEWS_MONITOR (003)
ENABLE_BINANCE_PRICE_CHECK (003)
ENABLE_LLM_ALERT_ENRICHMENT (003)
ENABLE_SENTRY (005)
ENABLE_FIRESTORE_ALERT_STORAGE (006)
ENABLE_FIRESTORE_SCANNER_PRESETS (scanner preset persistence)
```

**To add new feature**:
1. Create `ENABLE_FEATURE_NAME=false` env var
2. Validate at startup in `index.js` initialization
3. Gate feature behind conditional: `if (process.env.ENABLE_FEATURE_NAME === 'true')`
4. Update `agents.md` with new feature guidelines and flags

### Error Handling Pattern (All features)

**Patterns**:
- Graceful degradation: Enrichment failure ≠ alert failure
- Partial success: Return mixed results (some channels fail, others succeed)
- Logging: Use existing `console.*` methods; the centralized logger formats every emitted log as structured JSON.
- Admin notifications: Optional `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` for failures

### Notification delivery failure paging

- `NotificationManager.sendToAll()` and `sendToChannels()` send one compact failure page to `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` after any requested channel exhausts delivery retries.
- The page lists failed/succeeded channels, provider errors, status/attempt metadata when available, and the request/correlation ID when present on the alert.
- Admin paging calls `TelegramService.send()` directly instead of re-entering `NotificationManager`, so Telegram/admin delivery failures are logged but cannot recurse or change the original delivery results.

### Zero-channel paging and operator-intent configuration (GH-713 / PR #1191)

A zero-channel broadcast is a silent total loss of alerting: no channel is reachable, so nothing is delivered and nothing is reported. The zero-channel guard is built on an explicit **operator intent** concept, kept separate from runtime reachability.

- `NotificationChannel.isConfigured()` — base returns `false`. Each concrete channel overrides it to mean "the operator deliberately set this up" (enable flag **plus** the required credentials/chat id/webhook). `TelegramService.isConfigured()` requires `ENABLE_TELEGRAM_BOT`, `BOT_TOKEN`, and `TELEGRAM_CHAT_ID`; `WhatsAppService`/`DiscordService` follow the same flag-plus-credentials rule.
- `NotificationManager.isChannelConfigured(channel)` — resolves a channel's intent with three fallbacks in order: an `isConfigured()` method, a boolean `isConfigured` property, then `isEnabled()` for real `NotificationChannel` instances. A plain mock with none of those defaults to `true` so existing unit tests and non-subclass channels keep their prior behavior.
- `NotificationManager.getConfiguredChannels()` / `getUnconfiguredChannels()` — partition the registered channels by intent. The zero-channel dead-letter branch queues synthetic dead-letters **only** for configured channels, so an operator who never configured WhatsApp gets no phantom dead-letters and no false exhaustion alarm. When nothing is configured, no dead-letters are queued at all.
- `TelegramService.isAdminDeliveryEligible()` and `NotificationManager.isTelegramAdminDeliveryEligible()` — admin paging deliberately does **not** require the broadcast chat id, so `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` still receives the page when user-facing broadcasts are misconfigured. The admin chat id itself is still validated before any send.
- The zero-channel page reports both channel sets (`Configured channels (failing validation or disabled at runtime): …` and `Not configured: …`, or `No notification channels are configured (operator intent).`) so the page is self-diagnosing, and the redrive line is only present when dead-letters were actually queued.
- `/api/status` and `/api/capabilities` expose `notificationChannelIntent: { configured, unconfigured }` with channel **names only** — never tokens, webhook URLs, or chat IDs. It mirrors `isConfigured()` (enable flag **plus** required credentials, i.e. the `ready` semantics `dependencyStatus` already uses), so a channel with credentials present but its enable flag off reports as **not** configured. This must stay derived from the same predicate the page calls: deriving it from `dependencies.*.configured` (credentials only, ignoring the flag) would report a disabled channel with a webhook URL as "configured" and directly contradict the page that called it unconfigured. This is what lets an operator reconcile an alert from the page and the status response without inspecting credentials.

**Core components**: `src/services/notification/NotificationManager.js`, `src/services/notification/NotificationChannel.js`, `src/services/notification/{TelegramService,WhatsAppService,DiscordService}.js`, `src/controllers/status.js`, and the `NotificationChannelIntent` schema in `src/openapi/openapi.json`.

**Coverage**: `tests/unit/notification-manager.test.js` (page diagnostic context, distinct no-channel-configured message), `tests/unit/{notification-channel,telegram-service,whatsapp-service,discord-service,notification-redrive-service}.test.js`, and `tests/integration/status-endpoint.test.js` (intent vs. runtime readiness).

No new environment variable, Remote Config key, feature flag, or route was added; the behavior is unconditional and fail-open.

**To extend**:
1. **Discord integration**: Add in `src/services/notification/DiscordService.js`
2. **Error aggregation**: Track error rates in memory for metrics
3. **Sentry reporting (005-sentry-runtime-errors)**: Use a thin monitoring service (`src/services/monitoring/SentryService.js`) that wraps `@sentry/node` for runtime errors, optional tracing/spans, and Sentry Logs capture of configured console levels. Gated by `ENABLE_SENTRY` and `SENTRY_DSN`; MUST NOT change HTTP responses or notification fallbacks and SHOULD be stubbed/mocked in tests (no real Sentry traffic by default).
4. **Telegram admin alerts**: Send critical errors to admin chat if configured

## Runtime Error Monitoring with Sentry (005-sentry-runtime-errors)

This feature introduces backend runtime error monitoring using Sentry's Node SDK (`@sentry/node`) with a strong focus on **non-intrusive** instrumentation.

**Scope and goals**
- Capture unexpected runtime errors in core flows:
  - HTTP webhooks: `/api/webhook/alert`, `/api/news-monitor`.
  - Notification channels: Telegram and WhatsApp when internal retries are exhausted.
  - Process-level failures: `uncaughtException` and `unhandledRejection` via the SDK's built-in integrations.
- Capture configured console levels as searchable Sentry Logs when monitoring is enabled.
- Do **not** change public API contracts or user-visible behavior; monitoring is a side-effect only.

**Core components**
- `src/services/monitoring/SentryService.js`:
  - Initializes `@sentry/node` once at startup (called from `index.js`).
  - Resolves configuration from env (see below) and exposes helpers like `captureRuntimeError(...)` and `captureExternalFailure(...)`.
  - Applies tags (`channel`, `feature`, `environment`) and structured contexts (`http`, `external`, `alert`, `news`) as defined in `specs/005-sentry-runtime-errors/data-model.md`.
  - Enables Sentry Logs with `enableLogs: true` and `Sentry.consoleLoggingIntegration({ levels })`, where `levels` comes from `SENTRY_CONSOLE_LOG_LEVELS`.
- Existing handlers/services will call `SentryService` instead of importing `@sentry/node` directly:
  - `src/controllers/webhooks/handlers/alert/alert.js`
  - `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`
  - `src/services/notification/NotificationManager.js` and channel services when retries are exhausted.

**Configuration (env vars)**
- `ENABLE_SENTRY` (`'true'` to enable monitoring; otherwise no-op)
- `SENTRY_DSN` (server-side DSN from Sentry project; required when `ENABLE_SENTRY==='true'` in environments where we want events)
- `SENTRY_SEND_ALERT_CONTENT` (default: true; controls whether alert/news text is included in event payloads)
- `SENTRY_SAMPLE_RATE_ERRORS` (default: 1.0; error sampling rate 0.0-1.0)
- `SENTRY_TRACES_SAMPLE_RATE` (optional; trace sampling rate 0.0-1.0. Leave unset to disable tracing/spans entirely)
- `SENTRY_CONSOLE_LOG_LEVELS` (default: `warn,error`; comma-separated levels captured as Sentry Logs; allowed values: `debug`, `info`, `warn`, `error`, `log`, `assert`, `trace`)
- Optional overrides (otherwise derived from existing deployment vars):
  - `SENTRY_ENVIRONMENT` (e.g., `production`, `preview`, `development`)
  - `SENTRY_RELEASE` (e.g., `cabros-bot@1.2.3+<git-sha>`)
- Derivation rules (conceptual, see spec for details):
  - If `SENTRY_ENVIRONMENT` is set, use it.
  - Else if `RENDER==='true' && IS_PULL_REQUEST==='true'` or `VERCEL_ENV==='preview'` → `environment='preview'`.
  - Else if `NODE_ENV==='production'`, `RENDER==='true'`, or `VERCEL_ENV==='production'` → `environment='production'`.
  - Else → `environment='development'`.

**Instrumentation rules for AI agents**
- Use **only** the monitoring service (`SentryService`) for new Sentry instrumentation; do **not** scatter direct `@sentry/node.captureException` calls across handlers.
- Treat monitoring as a best-effort side-effect:
  - Sentry failures (bad DSN, network issues) MUST NOT introduce new 5xx responses or break existing fallbacks.
  - Purely expected flows (feature flags disabling behavior, validation 4xx responses) MUST NOT be reported as errors.
- When extending handlers:
  - Capture **unexpected** runtime failures (5xx paths, exhausted retries) with appropriate `channel`/`feature` tags.
  - Avoid instrumenting predictable, controlled logic errors (e.g., user input validation that returns 400/403 as per spec).

**Testing guidance**
- Unit tests for the monitoring service SHOULD mock `@sentry/node` so no network calls are made.
- Integration tests MAY assert that monitoring helpers are called in error paths but MUST keep HTTP responses and notification behavior identical with Sentry enabled vs disabled.
- Default for Jest and local dev is to run with Sentry disabled (`ENABLE_SENTRY=false` or no `SENTRY_DSN`), unless a test explicitly enables it with a fake DSN.

## Deterministic Sentry External Failure Fingerprints (CB-182 / Issue #419)

`SentryService.captureExternalFailure()` sends external provider exceptions with a deterministic fingerprint made from the event type, notification channel, provider, and last provider error code. Repeated failures with the same tuple group together in Sentry even when attempt counts or sanitized provider messages differ; missing error codes use `error`. This is monitoring-only and does not alter delivery, HTTP responses, or existing fail-safe behavior.

**Coverage**:
- `tests/unit/sentry-service.test.js` verifies the fingerprint passed to `Sentry.captureException` for an external Telegram failure.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config contract changed.

## Webhook Ingest Rate-Limit Separation (CB-239 / Issue #532)

The global rate limiter keeps its existing per-IP `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` bucket for ordinary routes. Core `POST /api/webhook/alert` and `POST /api/webhook/message` requests use an isolated finite 1,000-request bucket per IP and the same window, with URL normalization matching Express's case-insensitive, non-strict routing. This prevents normal TradingView bursts from consuming the ordinary bucket while preserving downstream API-key validation. No new environment variable, Remote Config parameter, endpoint, OpenAPI, or Postman contract was added; the fixed cap remains a bounded security control.

**Coverage**:
- `src/lib/rateLimiter.js` — Selects the isolated webhook bucket by exact request path and preserves bounded cleanup/fallback behavior.
- `tests/unit/rateLimiter.test.js` and `tests/integration/rate-limiter-webhook.test.js` — Cover webhook burst headroom, bucket isolation, and the ordinary 429 boundary.

## Gemini Evidence-Based Sentiment Calibration (CB-238 / Issue #530)

Gemini alert enrichment now passes grounded source results into the response parser. When grounding returns zero sources, directional sentiment magnitude above `0.55` is capped while the original signed value is retained as `sentiment_score_raw` only when adjusted; sourced scores and TradingView MCP scoring remain unchanged. The local alert-enrichment prompt includes an evidence calibration rubric, and Langfuse alert-enrichment prompts expose schema drift when the rubric markers are absent. Alert storage already deep-strips undefined fields, so the optional raw score remains Firestore-safe.

**Coverage**:
- `src/services/grounding/gemini.js` and `tests/unit/gemini-client.test.js` — Zero-source cap, signed raw-score audit field, and sourced-score preservation.
- `src/services/prompts/PromptService.js`, `src/services/prompts/defaults/alert-enrichment.user.txt`, and `tests/unit/prompt-service.test.js` — Local rubric and Langfuse calibration-drift detection.
- `src/openapi/openapi.json` and `CabrosBot.postman_collection.json` — Document the optional raw score in enriched payload examples.

No new environment variable or Remote Config key was added; the fixed cap is an application safety boundary, not operator tuning.

## Reference-Calibrated Sentiment Anchors & Saturation Guard (Issue #1031)

Production sent 87.6% of enriched `sentiment_score` magnitudes at or above 0.75 (85 of 97 in the reported histogram), producing only 7 distinct values. A near-constant score cannot rank alerts, tune thresholds, or compare signal quality over time, so it was actively harmful to outcome-informed gating (#587), the outcomes leaderboard (#826), and the feedback loop (#704).

**Two rules, not one.** The issue proposed a single `p90 - p10 < 0.1` spread guard, but the histogram it publishes has `p90 - p10 = 0.15` — above that floor. A spread-only guard stays silent on the exact incident it was filed for, because the pathology is upward bunching, not a narrow total range. `src/services/grounding/sentimentDistribution.js` therefore applies both:
- `spread_collapse` — `p90 - p10` below the floor. The "everything reads 0.8" signature.
- `top_band_concentration` — at least 75% of samples at or above `0.75`.

Spread collapse is evaluated first and reported first because it is the more severe diagnosis. `distinctValueCount` and `bucketCount` are **diagnostics, never triggers**: anchoring the prompt to score bands intentionally concentrates output onto band centres, so a low distinct-value count measures anchor adherence, not calibration failure. Do not "fix" a low distinct count by adding it as a trigger.

**Sample floor is load-bearing.** `minSamples` (default 20) is what keeps a cold process from declaring saturation, since the in-process window is cleared on restart. `insufficient_sample` and `no_samples` are reported as non-verdicts rather than as healthy, so a small window is never mistaken for a healthy one.

**Observe the effective score, not the raw one.** The rolling window records the post-cap value. Recording `sentiment_score_raw` would make a burst of zero-source alerts look saturated at 0.9 while storage holds 0.55, and would contradict `enrichment.sentimentCalibration`.

**Prompt contract.** `src/services/prompts/defaults/alert-enrichment.user.txt` scores against five reference anchors (`0.90` multi-source major catalyst, `0.75` corroborated, `0.60` partial, `0.45` routine, `0.30` negligible) and requires a `sentiment_score_evidence` line naming the anchor and its observation. That replaced the old `0.9+ / 0.6-0.8 / corroborating sources` marker triple in `REQUIRED_ALERT_ENRICHMENT_CALIBRATION_GUIDANCE`. **Consequence:** a Langfuse prompt not republished after #1031 reports `schemaDriftDetected: true` with the new markers in `missingCalibrationGuidance`. That is the intended rollout signal, not a regression — `resolveLocalPrompt` runs the same inspection, so the two surfaces stay in lockstep. Use the `langfuse-prompt-sync` skill to publish.

**Read the cap's liveness from the summary.** `enrichment.sentimentCalibration.rawScoreCapCount` counts alerts that also stored `sentiment_score_raw`, i.e. alerts the CB-238 zero-source cap rewrote. Non-zero proves the cap is live in the queried deployment; zero means either no capped alerts in the window or a stale build. This is the verification path for #970's Railway cutover.

**CB-238 is unchanged.** The zero-source cap, the signed `sentiment_score_raw` audit field, and sourced-score preservation all still hold and are still covered. `sentiment_score_evidence` is additive and bounded to 240 characters.

**Fail-open.** The detector is pure and returns an empty report on malformed input; the warning path cannot throw and cannot gate enrichment or notification delivery.

**Core components**:
- `src/services/grounding/sentimentDistribution.js` — pure analyzer plus bounded, age-limited rolling window.
- `src/services/grounding/gemini.js` — parses/bounds `sentiment_score_evidence`, records the effective score, emits one structured saturation warning per hour plus a recovery line.
- `src/services/storage/AlertStorageService.js` — `readStoredSentimentScore()` and `buildSentimentCalibration()` populate `summary.enrichment.sentimentCalibration`.
- `src/services/prompts/defaults/alert-enrichment.user.txt`, `src/services/prompts/PromptService.js`, `src/services/grounding/types.ts` — prompt anchors, drift markers, and the typed field.

**Coverage**: `tests/unit/sentiment-distribution.test.js` (both rules, sample floor, malformed input, bucket boundaries, window eviction/bounds/snapshot-safety, and the exact #1031 histogram), `tests/unit/gemini-client.test.js` (evidence pass-through/omission/bounding, CB-238 raw-field preservation, post-cap observation, single warning, recovery, telemetry never breaks parsing), `tests/unit/alert-storage-service.test.js`, `tests/unit/prompt-service.test.js`, `tests/integration/alerts-endpoint.test.js`.

No new environment variable, Remote Config key, endpoint, feature gate, or auth change was added. Detection thresholds are fixed application safety boundaries, not operator tuning.

## TradingView MCP Alert-Path Health (CB-241 / Issue #536)

TradingView alert enrichment now exposes an in-process rolling 24-hour `dependencies.tradingViewMcp.enrichment.alertPath` snapshot with total, applied, failed, and percentage counters. The existing MCP circuit-breaker paging remains the single deduplicated admin outage page and continues to fail open. Stored-alert summaries expose `enrichment.tradingViewStatusCounts` with `full`, `partial`, `failed`, `not_applicable`, and `unrecorded`; requested legacy records without a persisted outcome are counted as `unrecorded`.

TradingView MCP suspension responses and terminal upstream tool errors are classified as `provider_unavailable`, preserve `lastHttpStatusCode` in `/api/status`, and stop same-operation retries while retaining fail-open delivery. Transient HTTP and protocol failures keep the existing retry behavior.

Issue #630 validation confirmed the configured TradingView MCP endpoint is live; no environment variable or Remote Config key was added.

**Coverage**:
- `src/services/tradingview/TradingViewMcpService.js` — Rolling alert-path outcome window and status projection, isolated from volume-confirmation runtime state.
- `src/services/storage/AlertStorageService.js` — Explicit stored outcome buckets with legacy requested-record accounting.
- `tests/unit/tradingview-mcp-service.test.js`, `tests/unit/alert-storage-service.test.js`, and `tests/integration/status-endpoint.test.js` — Rate, bucket, and protected status contract coverage.
- `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, and `README.md` — Additive status/summary contract examples.

No new environment variable or Remote Config key was added; the 24-hour window is a fixed operational reporting boundary and existing circuit-breaker controls already provide deduplicated paging.

## TradingView MCP Exchange Alias Resolution (Issue #591)

`resolveMcpExchange()` in `src/services/tradingview/parseTradingViewSignal.js` maps an alert's exchange prefix to a venue the TradingView MCP server actually serves. It runs inside `TradingViewMcpService.enrichFromSignal()` before `coin_analysis` and is a **closed, probe-verified lookup table** with higher priority than suffix-shape inference — never a broadened fuzzy regex, which would remap venues that already work.

- `MCP_EXCHANGE_ALIASES` — `BATS → NASDAQ`, `NASDAQ_DLY → NASDAQ`. Each entry was confirmed live: the source prefix answers `No data found for <SYMBOL> on KUCOIN` while the target returns a full indicator payload.
- `MCP_UNSUPPORTED_EXCHANGES` — `FX_IDC` and `SPCFD` are deliberately **not** aliased. Every candidate venue was probed and all returned the same KUCOIN miss, so aliasing would fabricate a market. They keep the original prefix and degrade through the normal fail-open path.
- `MCP_SUPPORTED_EXCHANGES` — The server's advertised venue list, used to flag an unknown-but-unsupported prefix for debug logging only.

**Outbound only.** Alias resolution never rewrites stored metadata. The parsed signal, `deriveAssetContext()` classification (including the GH-320 `FX_IDC`/futures neutrality), and every persisted `exchange` keep the venue the screener sent. The enrichment payload adds `exchange`, `requestedExchange` (both the original) and `requestedExchangeMappedTo` (alias target, omitted when no alias applied).

**Fast-fail.** `isDeterministicNoDataError()` classifies a `no data`/`symbol not found` MCP response as terminal for that attempt, and `sendWithRetry()` gained a `shouldRetry(result)` hook so the base analysis stops after one attempt instead of burning the remaining `TRADINGVIEW_MCP_MAX_RETRIES` backoff. Transport errors, timeouts, HTTP 5xx, and circuit-breaker semantics are unchanged.

**Failure mode addressed.** This change fixes **symbol/exchange resolution**, not transport. A healthy MCP host still returned `No data found for TSLA on KUCOIN` because the exchange argument was unresolvable. See #630 for the complementary MCP handshake defect. Probe evidence (2026-09-28): `BATS:TSLA`/`NASDAQ:TSLA` → fails/succeeds respectively; `GLD:AMEX` and `SPY:NYSEARCA` succeed while `SPY:NASDAQ` does not, confirming the miss is venue-scoped and not a blanket symbol gap.

**Coverage**:
- `tests/unit/tradingview-signal-parser.test.js` — Alias table, case/padding normalization, supported-venue passthrough, unresolvable-venue degradation, non-string safety, and the guarantee that stored/parsed exchanges are untouched.
- `tests/unit/tradingview-mcp-service.test.js` — Outbound argument mapping with original-exchange reporting, byte-for-byte pass-through for supported venues, single-attempt spend on a deterministic miss, retry preservation for transport errors, and graceful degradation.
- `tests/unit/retry-helper.test.js` — `shouldRetry` terminal-result, terminal-from-first-attempt, and default-behavior regression.
- `docs/tradingview-mcp.md`, `src/openapi/openapi.json`, and `CabrosBot.postman_collection.json` — Contract documentation and dry-run examples.

No new environment variable or Remote Config key was added: the alias table is a code-level contract, not runtime tuning.

### Testing Patterns

**Test locations**:
- `tests/unit/`: Core logic (parsers, formatters, helpers, cache)
- `tests/integration/`: End-to-end flows (webhook → delivery, news → alerts)
- No TDD mandate: Write tests after implementation (tests for critical paths + regressions)

**Test structure**:
```javascript
// Unit: Test single function/class
describe('analyzer', () => {
  it('calculates confidence correctly', () => { ... })
})

// Integration: Test feature end-to-end
describe('news-monitor', () => {
  it('sends alert when confidence exceeds threshold', () => { ... })
})
```

## Common Implementation Tasks

### Add new Telegram command (extend existing pattern):
- Edit `src/controllers/commands.js` to add handler
- Wire in `index.js` with `bot.command()`
- Example: `/precio BTCUSDT` → calls Binance → replies

### Add new news event category (extend 003):
- Update Gemini prompt in `analyzer.js`
- Add to event detection logic
- Update tests to verify detection
- Example: `security_breach` category for exchange hacks

### Add new notification channel (extend 002):
- Create class extending `NotificationChannel`
- Implement send(), validate(), isEnabled()
- Register in NotificationManager
- Add tests and env vars

### Add new API endpoint (create new feature):
- Create controller in `src/controllers/webhooks/handlers/`
- Register route in `src/routes/index.js`
- Add env vars and validation
- Create integration tests
- Document in README
- Add request + response examples to `CabrosBot.postman_collection.json` (include valid inputs, error/edge-case variants, and structured response examples)

### Add new external API client (extend services):
- Create service in `src/services/`
- Use native fetch (no new HTTP client dependencies)
- Implement retry with retryHelper
- Add timeout handling
- Example: `src/services/inference/azureAiClient.js`

## Persistent News Monitor Deduplication (CB-38 / Issue #120)

This feature introduces an optional persistent/shared backend (Firestore) for the news monitor cache (`NewsCache`) to ensure duplicate suppression survives restarts and scales across replicas.

**Core Components**:
- `src/services/storage/NewsDedupStorageService.js` — Firestore storage helper to check, set, and delete deduplication cache entries in the `news-monitor-dedup` collection.
- `src/controllers/webhooks/handlers/newsMonitor/cache.js` — Updated `NewsCache` that integrates with `NewsDedupStorageService`. All `get` and `set` methods are now **asynchronous** and return Promises.
- `/api/status` — Surfaces active deduplication mode (`persistent` or `in-memory`) and backend information.

**Configuration**:
- `ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP` — Set to `'true'` to enable persistent Firestore-backed deduplication. Defaults to `'false'` (falls back to process-local in-memory cache).

**Behavior & Fail-Open**:
- Reads query the local memory cache first. On hit, they return immediately. On miss, they check Firestore. If found in Firestore, the local cache is populated.
- Writes update the local memory cache, and if persistent mode is active, also save to Firestore.
- Fail-open strategy: any Firestore errors (permissions, timeouts, missing collection) are logged as warnings and the cache gracefully falls back to local in-memory operation.

**Where to look first when extending or debugging**:
- `src/controllers/webhooks/handlers/newsMonitor/cache.js` for cache lookup and eviction rules.
- `src/services/storage/NewsDedupStorageService.js` for Firestore interactions.
- `src/controllers/status.js` for deduplication mode reporting.
- `tests/unit/news-monitor-persistent-dedup.test.js` for unit coverage of the persistent cache.
- `tests/integration/status-endpoint.test.js` for integration status tests.

## OpenAI SDK using Cloudflare AI Gateway (CB-46 / Issue #137)

This feature introduces integration of the official `openai` SDK to interact with LLMs routed through Cloudflare AI Gateway.

**Core Components**:
- `src/services/inference/cloudflareAiClient.js` — OpenAI SDK wrapper that initializes `new OpenAI()` with `CF_AIG_TOKEN` as the API key and a custom `baseURL` targeting Cloudflare AI Gateway compatibility endpoints.
- `src/services/grounding/genaiClient.js` — Normalizes client provider routing to delegate to `CloudflareAiClient` when `MODEL_PROVIDER=cloudflare` is specified.
- `src/services/grounding/config.js` — Exports Cloudflare AI Gateway variables (`CF_AIG_TOKEN`, `CF_AIG_BASE_URL`, `CF_AIG_MODEL`).
- `src/controllers/status.js` — Exposes the configuration status for `cloudflareAig` and `newsMonitorLlm` via `/api/status`, correctly supporting fallback to the default model `google-ai-studio/gemini-2.5-flash` when the `CF_AIG_MODEL` env var is omitted.

**Configuration**:
- `MODEL_PROVIDER=cloudflare` — Selects Cloudflare AI Gateway for runtime LLM routing when credentials validate.
- `ENABLE_CLOUDFLARE_AIG` — Set to `'true'` only to expose Cloudflare readiness in `/api/status` and `/api/capabilities`; it does not select the runtime provider.
- `CF_AIG_TOKEN` — Cloudflare API Gateway access token.
- `CF_AIG_BASE_URL` — Cloudflare gateway compatibility base URL.
- `CF_AIG_MODEL` — The gateway target model (e.g., `google-ai-studio/gemini-2.5-flash`). Falls back to `google-ai-studio/gemini-2.5-flash` for status reporting and runtime configuration checks.

**Testing**:
- Unit coverage in `tests/unit/cloudflare-client.test.js`.
- Integration coverage in `tests/integration/status-endpoint.test.js`.

## Private Network SSRF Protection for Job Callbacks (CB-55 / Issue #152)

This feature introduces validation of callback URLs to prevent Server-Side Request Forgery (SSRF) by blocking private-network, loopback, link-local, RFC1918, multicast, and metadata-service ranges during both callback URL acceptance (creation) and delivery (sending).

**Core Components**:
- `src/services/jobs/JobService.js` — Contains `isPrivateIp` IP range checks and `isValidCallbackUrl` async validation. Validates URL protocol, normalizes bracketed IPv6 literals, rejects a hostname when any DNS answer is private, revalidates before every delivery attempt, and disables automatic redirects.
- `tests/unit/job-service.test.js` — Unit tests covering loopback, link-local, RFC1918, multicast, metadata-service (e.g. `169.254.169.254`), mixed public/private DNS answers, public IPv6 literals, redirect policy, and DNS changes between retries.
- `tests/integration/jobs-endpoint.test.js` — Endpoint verification tests checking HTTP 400 Bad Request responses for private callback URLs.

**Configuration**:
- `ALLOW_PRIVATE_CALLBACKS` — Set to `'true'` to bypass private-network/SSRF blocking on callback URLs (e.g. for local developer testing of private targets). Defaults to `'false'`.
- `ALLOW_HTTP_CALLBACKS` — Existing flag to permit plain HTTP callbacks (restricted to localhost unless `NODE_ENV=test` or set to `'true'`).
- `JOB_CALLBACK_RETRY_DELAY_MS` — Async callback retry backoff in milliseconds (default: `1000`).
- `JOB_CALLBACK_SIGNING_SECRET` — Optional server-side HMAC secret for callback signatures; never commit or expose it.

**Testing**:
- Unit coverage: `pnpm test -- tests/unit/job-service.test.js`
- Integration coverage: `pnpm test -- tests/integration/jobs-endpoint.test.js`

## Message Footer Metadata Capability Flag (CB-71 / Issue #175)

`/api/status` and its `/api/capabilities` alias expose `featureFlags.messageFooterMetadata`, matching the alert grounding and TradingView MCP footer behavior. The flag is `true` unless `ENABLE_MESSAGE_FOOTER_METADATA=false`; standalone, combined, and MCP-only alert enrichment all suppress metadata footers when disabled.

**Core Components**:
- `src/controllers/status.js` — Reports the effective message-footer metadata flag.
- `src/controllers/webhooks/handlers/alert/grounding.js` and `src/services/tradingview/TradingViewMcpService.js` — Apply the flag to Gemini, combined, and MCP-only enrichment footers.
- `tests/integration/status-endpoint.test.js`, `tests/unit/alert-handler.test.js`, and `tests/unit/tradingview-mcp-service.test.js` — Cover the default-enabled and explicit-disabled states.
- `README.md`, `src/openapi/openapi.json`, and `CabrosBot.postman_collection.json` — Document the response field and default.

## Callback DNS Pinning Against Rebinding (CB-110 / Issue #278)

Async job callback delivery now retains the complete DNS answer set that passed private-address validation and supplies it to an Undici dispatcher lookup. The callback URL hostname remains unchanged for HTTP Host and HTTPS TLS/SNI validation, while the socket can connect only to one of the addresses validated for that attempt. `ALLOW_PRIVATE_CALLBACKS=true` still permits private answers but pins delivery to the current validated set; redirects remain rejected and each retry revalidates DNS.

**Core Components**:
- `src/services/jobs/JobService.js` — Returns validated address records, creates the per-attempt pinned dispatcher, uses the Fetch API with `AbortController`, and closes the dispatcher after response-body cancellation.
- `tests/unit/job-service.test.js` — Covers real local callback delivery through the pinned lookup and preserves existing private-network, retry, HMAC, timeout, and redirect coverage.
- `undici@6.28.0` — Official Fetch-compatible dispatcher dependency selected for the Node 24 runtime range; it is used only to control native Fetch connection lookup, not as a separate application HTTP client.
- `README.md`, `src/openapi/openapi.json`, and `CabrosBot.postman_collection.json` — Document the connection-time DNS pinning guarantee and explicit private-callback override.

## Higher-Timeframe Market Scanner Alignment (CB-86 / Issue #217)

The market scanner accepts optional `includeMultiTimeframe` enrichment. When enabled, each valid scanner candidate is queried through the existing TradingView MCP `multi_timeframe_analysis` tool; failures remain fail-open and preserve the base scan result. Ranked scoring normalizes bullish/bearish alignment against the candidate direction, applies configurable `+10` aligned or `-10` counter-trend modifiers by default, and exposes `trendConfluence` in structured scores. Reports render `🔥 HTF ALIGNED` for confidence at or above 70% and `⚠️ HTF COUNTER-TREND` for opposing alignment.

**Core Components**:
- `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` — Opt-in candidate enrichment and fail-open orchestration.
- `src/services/tradingview/marketScannerScoring.js` — Direction normalization and configurable confluence scoring.
- `src/services/tradingview/marketScannerReport.js` — Request parsing and Telegram/WhatsApp report markers.
- `tests/unit/market-scanner-scoring.test.js`, `tests/unit/market-scanner-report.test.js`, `tests/unit/market-scanner.test.js`, and `tests/integration/market-scanner-endpoint.test.js` — Scoring, rendering, fail-open, and endpoint coverage.

## Durable Scanner Preset Storage (CB-88 / Issue #219)

Scanner presets support an independent `ENABLE_FIRESTORE_SCANNER_PRESETS=true` gate. `ScannerPresetService` reuses the lazy Firestore singleton, persists across service instances when available, and falls back to the in-memory `Map` on disabled, initialization, or write failure. Every scanner-preset CRUD success response exposes a non-sensitive `storage` object; `/api/status` and `/api/capabilities` expose the same effective state under `dependencies.scannerPresetStorage`, with `mode: durable|ephemeral` and `backend: firestore|memory`.

**Core Components**:
- `src/services/storage/AlertStorageService.js` — Allows scanner-preset initialization without enabling alert, job, or outcome storage.
- `src/services/storage/firestoreConfig.js` — Centralizes non-secret Firestore credential/runtime readiness checks used by status and scanner-preset storage reporting.
- `src/services/scannerPresets/ScannerPresetService.js` — Tracks effective storage health and reports the fail-open fallback accurately.
- `src/controllers/status.js` and `src/controllers/webhooks/handlers/scannerPresets/scannerPresets.js` — Expose storage capability metadata without credentials.
- `tests/unit/scanner-preset-service.test.js`, `tests/integration/scanner-presets-endpoint.test.js`, and `tests/integration/status-endpoint.test.js` — Cover independent persistence, restart simulation, disabled fallback, and Firestore write failure.
- `README.md`, `.env.example`, `src/openapi/openapi.json`, and `CabrosBot.postman_collection.json` — Document configuration and response contracts.

**Production enablement (Issue #1114).** `render.yaml` now declares `ENABLE_FIRESTORE_SCANNER_PRESETS: true` on the **web service only**, so configured scan schedules survive a redeploy instead of resetting to ephemeral. Three deliberate boundaries:

- **Web service only.** `scannerPresets` is imported solely by `src/controllers/status.js`, `src/controllers/webhooks/handlers/scannerPresets/scannerPresets.js`, and the scheduler bootstrap in `index.js`. `worker.js` never touches it, so the worker keeps the ephemeral default rather than opening a second writer against the same collection.
- **Previews stay off** (`previewValue: false`), matching `ENABLE_FIRESTORE_JOB_STORAGE`. A PR preview sharing the production preset collection would let a throwaway environment mutate real schedules.
- **No composite index is required, and none is declared.** Every durable query is a point read (`.doc(id)`), a single-field equality (`.where('nameKey','==',key)`, `.where('schedule.enabled','==',true)`), or a single-field sort (`.orderBy('createdAt','desc')`) — all served by Firestore's automatic single-field indexes. Firestore does **not** merge single-field indexes, so this property is one query edit away from the #1285 outage class, and neither the unit double nor `pnpm test:firebase` can observe it because the double makes `orderBy` a no-op. `tests/unit/scanner-preset-service.test.js` therefore asserts the durable query shape at the source level: no chain may combine a filter with a sort, none may sort `__name__` descending, and `firestore.indexes.json` must declare no `scannerPresets` composite until a query actually needs one.

The flag is environment-only for Remote Config parity: it is a process-startup gate that changes where a collection lives, not a runtime tuning knob.

**Scanner-preset durability is proven, not inferred (issue #1342).** `ScannerPresetService.getStorageStatus()` previously derived `mode`, `backend`, `configured`, `ready`, and `status` from **one** conjunction that included a sticky `firestoreUnavailable` latch and the three module-level pending maps. Production reported `mode: "ephemeral"`, `backend: "memory"`, `status: "misconfigured"` while `firestore.ready` was `true` and `idempotencyStorage` was `durable` in the same process. `misconfigured` sent the operator to check credentials that were demonstrably valid, and `/api/status` observed the latch without ever performing a read, so it could never heal it. This is the repo's "shape is not readiness" rule again — after `firebaseRemoteConfig.ready` (#598), Firestore `readHealth` (#1285), `equityMarketData.ready` (#1116), and `idempotencyStorage.ready` (#1111); do not fold readiness back into `configured`.

Five invariants to preserve:

- **`mode` and `backend` are intent-derived** (`enabled && credentials present`). They must not flip to `memory` while the flag is on, for the same reason #1111 requires it for idempotency: an operator reading `memory` concludes the feature is off, which is the opposite of the truth.
- **`status` separates the three causes an operator acts on differently**: `disabled` (gate off), `misconfigured` (credentials genuinely absent or rejected — the only case meaning "fix credentials"), and `degraded` (a durable operation failed and nothing has answered since). `unverified` means no evidence yet, which is neither healthy nor broken.
- **Readiness is computed from observed counters, never credential shape.** `consecutiveFailures > 0` → `degraded`, else `operationsSucceeded > 0` → `verified`, else `unverified`. It self-heals on the next success, so one transient error never permanently downgrades the verdict and no restart is needed to recover.
- **The status path performs the bounded read it asserts.** `probeStorageReadiness()` issues the same `orderBy('createdAt','desc')` query `listPresets()` uses, bounded to one document, and is single-flight and rate-limited to one probe per `PROBE_MIN_INTERVAL_MS` so an operator polling `/api/status` cannot turn it into a Firestore read amplifier. It needs no composite index beyond the single-field sort the list already requires. `getApiStatus()` awaits it fail-open beside its other telemetry syncs. **A readiness probe must issue the operation whose availability it is asserting, not a cheaper proxy.**
- **The pending maps are workload, not verdict.** `pendingFirestorePresets` / `inFlightFirestorePresets` / `pendingFirestoreDeletes` are reported as `pendingWrites` / `inFlightWrites` / `pendingDeletes` plus `oldestPendingWriteAt`, and are **kept out of the durability verdict entirely**. One entry left behind by a failed write used to pin the process to `ephemeral` for its lifetime. `oldestPendingWriteAt` is derived from `preset.updatedAt` in the buckets themselves rather than a new side map, which would be its own unbounded state to wedge.

`lastErrorReason` is constrained to a closed enum (`firestore_not_initialized`, `firestore_unavailable`, `firestore_probe_timeout`) because a Firestore error message embeds the fully-qualified project/database path. `failOpen` is always `true` and is reported rather than implied: a `degraded` verdict still serves preset CRUD from the in-memory mirror. `firestoreUnavailable` now means strictly "the last durable operation failed" — it used to be set by a non-empty pending map, which conflated an unsynced local record with an unreachable store.

**Coverage**: `tests/unit/scanner-preset-service.test.js` — probe-proves-readiness with no prior write, probe rate-limiting, transient-failure-then-success recovery, probe timeout classified as `degraded` and never as a credential fault, a status-only call performing no read and neither latching nor clearing a failure, and wedged pending-write and pending-delete overlays keeping `durable`; `tests/integration/status-endpoint.test.js` — all three causes from `/api/status`, with the durable gate's `ready` proven by the probe; `tests/integration/scanner-presets-endpoint.test.js` — a failed write reporting `degraded` + `pendingWrites` rather than `misconfigured` + `memory`.

Counters are process-local and reset on restart, so `unverified` is the normal state right after every deploy. No environment variable, Remote Config key, endpoint, or feature gate was added; the probe bounds are fixed application safety deadlines, not operator tuning.

## Firebase Remote Config Safe Runtime Tuning (CB-116 / Issue #303)

`ENABLE_FIREBASE_REMOTE_CONFIG=true` enables the Firebase Admin server-side Remote Config Preview loader. The repository template is published by `scripts/deploy-server-remote-config.js` to the `firebase-server` namespace and loaded by `admin.remoteConfig().initServerTemplate()`; it is not a Firebase Web/Client SDK configuration. `RemoteConfigService` reuses the existing lazy Firebase Admin/Firestore initialization, loads once after startup, and refreshes on a bounded interval; alert paths only read the in-process cache and never fetch per alert.

The allow-list is limited to news thresholds/concurrency/retries, news volume caps/window duration, TradingView timeouts/retries, `SIGNAL_OUTCOME_RETENTION_DAYS` (retention in days between `1` and `3650`, default `365`), `ENABLE_MESSAGE_FOOTER_METADATA`, and `ENABLE_MAINTENANCE_MODE` (an operational incident-response kill switch). Values are validated against finite, integer, positive, boolean, and range constraints. TradingView MCP timeout and enrichment-budget values are bounded to `1000`-`120000` milliseconds, and retry counts to `1`-`5`; the environment fallback uses the same schema as Remote Config. `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS` is intentionally environment-only because the worker timer is created during process startup; it is excluded from both the allow-list and the template. Credentials, API keys, webhook authentication, permanent security controls, and notification destinations are excluded. Disabled, unavailable, timed-out, stale, malformed, or invalid values fall back to environment/default values without blocking startup or alert delivery.

`/api/status` and `/api/capabilities` expose only `enabled`, `configured`, `ready` (true only after a successful, fresh template load), `status` (`ready`, `degraded`, `unknown`, `misconfigured`, or `disabled`), `source`, template version, last successful load, last error category, consecutive failures, and bounded loader settings under `dependencies.firebaseRemoteConfig`; remote values and secrets are never returned.

**Production rollout is two-step, and the gate must be uniform across services (issue #1113).** `render.yaml` declares `ENABLE_FIREBASE_REMOTE_CONFIG: value: true`, `previewValue: false` on **every** compute service — `cabros-crypto-bot-telegram-iac`, `cabros-crypto-bot-telegram-worker`, and `cabros-crypto-bot-signal-outcome-worker`. Two invariants make that non-optional:

- **`start()` no-ops when the gate is off.** `start()` returns `false` immediately unless the gate is `true`, so a service that omits the key never loads a template and keeps evaluating environment values while reporting `enabled: false`. The gate belongs on any process that calls `remoteConfigService.start()` — that is all three (`index.js`, `worker.js`, `src/workers/signalOutcomeWorker.js`).
- **A per-service gate splits the effective config.** `getRuntimeConfig()` merges `remoteOverrides` only where the gate is on, so two processes reading the same published template with different gate values resolve *different* values for the same key. `SIGNAL_OUTCOME_RETENTION_DAYS` is the concrete failure: the web service stamps `expiresAt` on outcome documents while the signal-outcome worker applies the same window when evaluating them, so a split gate makes the two processes disagree about document lifecycle. Do not move the key back to `sync: false`; `tests/unit/render-blueprint.test.js` asserts both properties per service.

**Merging the gate is not the same as activating remote tuning.** The deploy lands first, reporting `status: "degraded"` with `lastErrorCategory: "template_not_published"` until the **Deploy Firebase Remote Config Server Template** workflow is run (`workflow_dispatch`, ref `master`) against a green deployment. That window is the documented inert state, not a regression: `ready` stays `false`, `source` stays `environment`, and every value still comes from `process.env`.

**After first publish, `firebase-remote-config-template.json` outranks `render.yaml`.** The Admin SDK reports a fetched parameter's `defaultValue` with source `remote`, and `getRemoteValue()` accepts it, so **every parameter present in the template becomes an override that beats `process.env`** — the entries look like defaults but are not. Editing an allow-listed key in `render.yaml` or the Render dashboard therefore has no effect once a template exists; the change must be made in `firebase-remote-config-template.json` and republished. `ready: true` will still be reported when a stale template loads cleanly, so template freshness is an operator responsibility, not something the status flag detects.

**Core Components**:
- `src/services/remoteConfig/RemoteConfigService.js` — Bounded loader, allow-list validation, cache expiry, and safe status metadata.
- `src/services/storage/AlertStorageService.js` — Reuses the existing Firebase Admin singleton for the independent Remote Config gate.
- `src/controllers/status.js` and `index.js` — Expose status metadata and start/stop the background refresh lifecycle.
- `tests/unit/remote-config-service.test.js`, `tests/unit/analyzer.test.js`, `tests/unit/tradingview-mcp-service.test.js`, and `tests/integration/status-endpoint.test.js` — Cover disabled behavior, valid/invalid values, timeout, stale cache, runtime consumers, and redacted status metadata.
- `README.md`, `.env.example`, `src/openapi/openapi.json`, and `CabrosBot.postman_collection.json` — Document the Preview rollout, quota/error monitoring, configuration, and response contract.

## Generic Message Idempotency (CB-97 / Issue #240)

`POST /api/webhook/message` now uses the shared `idempotencyMiddleware` before dispatching notifications. Requests with the same key and identical message/routing payload replay the cached response, including `idempotencyReplayed: true` and the `Idempotency-Replay: true` header, while payload changes return `409 IDEMPOTENCY_CONFLICT`. Supplied idempotency keys must be non-empty strings; invalid key types return `400 INVALID_REQUEST`. Requests without a key retain the existing delivery behavior.

**Accepted key forms**:
- `idempotency-key` header (recommended)
- `idempotencyKey` or `idempotency_key` JSON body field
- `idempotencyKey` or `idempotency_key` query parameter

**Coverage and contracts**:
- `tests/integration/generic-message-webhook.test.js` covers sequential and concurrent replay, single dispatch across Telegram/WhatsApp/Discord, message/channel/destination conflicts, and legacy no-key behavior.
- `src/openapi/openapi.json` and `CabrosBot.postman_collection.json` document key locations, replay output, invalid key handling, and the message-specific conflict response without overriding the shared async-job conflict component.

## Alert Replay Dry-Run Mode (Issue #680)

`POST /api/alerts/:alertId/replay` accepts an optional `dryRun` flag (boolean body field or `dryRun=true` query string). When enabled, the controller fetches the stored alert, builds the exact replay payload (text + enrichmentData + per-channel routing including the resolved Telegram `message_thread_id` and effective service defaults / `TELEGRAM_TOPIC_ROUTES` when the stored alert lacks explicit overrides), and returns it inside `payloadPreview` without dispatching to any notification channel and without persisting a `alertReplays` audit document. The dry-run response returns the 12-character SHA-256 hash prefix `idempotencyKeyHashPrefix` without leaking the raw key into upstream caches; live replays never return it (only the SHA-256 hash prefix is exposed via `GET /api/alerts/replays`).

**Behavior**:
- Gated by the same `ENABLE_FIRESTORE_ALERT_STORAGE=true` requirement as the live replay; the existing `400 INVALID_REQUEST` and `404 NOT_FOUND` mappings apply unchanged.
- `dryRun: false` (or omitted) preserves the existing replay behavior byte-for-byte: `sendToChannels()` runs, `saveReplayAttempt()` persists, and the response shape is `{ success, alertId, replayId, results }`.
- A dry-run request that fails the `getAlertById` lookup still returns `404 NOT_FOUND` — we never run a no-op replay on a missing alert.
- Notification-manager initialization is skipped on dry-run, so the dry-run path never lazy-starts Telegram/WhatsApp/Discord services when no actual delivery is requested.
- MarkdownV2 rendering, idempotency contract, channel routing, and feature gates are untouched.

**Coverage and contracts**:
- `tests/integration/alerts-endpoint.test.js` adds focused tests: dryRun via body returns `payloadPreview` and skips `sendToChannels`/`saveReplayAttempt`; dryRun via query string returns the same shape; effective channel routing and topic routes are resolved from environment defaults; custom chats preserve their destination without applying global topic routes; explicit `dryRun: false` preserves the live path; missing alert returns `404 NOT_FOUND` in dry-run mode without dispatching.
- `src/openapi/openapi.json` adds `dryRun` to the `Replay` request body schema and `payloadPreview` / `channels` / `idempotencyKeyHashPrefix` / `replayId` to the `DeliveryResult` response schema.
- `CabrosBot.postman_collection.json` adds a `POST Replay Alert (dry-run)` request variant with success and not-found response examples.
- `README.md` documents the dry-run section under the alerts replay endpoint.

## Durable Idempotency Claim Tokens (CB-127 / Issue #311)

## Durable Idempotency Claim Tokens (CB-127 / Issue #311)

Firestore-backed idempotency reservations carry a unique `claimToken` for the current pending owner. `reserveEntry()` returns the token for fresh claims; `IdempotencyService` serializes local durable reservations per key, retries the waiting request's own durable lookup after a predecessor payload conflict, retains the token only for that owner, and passes it to completion/release operations. `setEntry()` and `releaseEntry()` use Firestore transactions that require the stored token, payload hash, and pending state to match, so a stale replica cannot overwrite or delete a newer reservation after stale-claim recovery. Records without a token fail closed, while disabled/unavailable Firestore continues to use the existing in-memory fallback.

`tests/unit/idempotency-storage-service.test.js` covers token issuance, transactional completion, and late completion/release after reclaim. `tests/unit/idempotency.test.js` verifies token propagation and preserves local fresh/completed results when concurrent pending, fail-open fallback, or poller responses resolve later; no public API, OpenAPI, or Postman contract changed.

## Discord 429 Attempt Telemetry (CB-102 / Issue #254)

Terminal Discord HTTP 429 results preserve the cumulative number of webhook requests actually made in `attemptCount`, including requests for earlier successful message chunks, retry exhaustion, and retry-budget aborts. `NotificationManager` forwards that value to Sentry and the Telegram admin failure message through both `sendToAll` and `sendToChannels`, while retaining fail-open channel isolation.

**Coverage**:
- `tests/unit/discord-service.test.js` verifies exhausted retries return `attemptCount: 3`, budget-aborted retries return the count actually made, and later chunk failures include earlier chunk requests.
- `tests/unit/notification-manager.test.js` verifies Sentry and admin failure telemetry for both notification dispatch paths.

## Alert Risk-Metadata Coverage and Prompt Provenance (CB-100 / Issue #243 / Issue #444)

Stored enriched alerts now carry sanitized `promptProvenance` metadata when the alert-enrichment prompt resolves: `name`, `source` (`langfuse` or `local`), `label`, numeric `version`, and `schemaDriftDetected`; prompt content and unknown provenance fields are not persisted. `GET /api/alerts/summary` exposes `enrichment.riskMetadataCoverage` with the enriched-alert denominator, populated counts/percentages for each optional risk field (`invalidation_level`, `target_level`, `setup_type`, `risk_reward_ratio`), and provenance-grouped coverage including `schemaDriftDetected`. Legacy enriched records without provenance are grouped under `provenance: null`. Invalid or absent optional risk values count as unavailable data, and the existing fail-open delivery/authentication/feature gates are unchanged.

**Rollout check**: validate provenance and zero-safe coverage in preview, align the remote production `alert-enrichment` prompt with the local optional-risk schema, then observe a bounded shadow window before using risk metadata in downstream triage. No trading outcome or risk value is inferred from zero coverage.

**Coverage**:
- `tests/unit/gemini-client.test.js`, `tests/unit/prompt-service.test.js`, and `tests/unit/alert-storage-service.test.js` cover local/Langfuse provenance, schema drift inspection, safe persistence, missing/invalid values, and mixed coverage.
- `tests/integration/alerts-endpoint.test.js` covers the protected summary response contract.
- `README.md`, `src/openapi/openapi.json`, and `CabrosBot.postman_collection.json` document the response, schemaDriftDetected flag, and bounded rollout check.


## Crypto Suffix Grounding Guard (CB-109 / Issue #271)

The grounding asset-context fallback no longer classifies lowercase ordinary prose words that merely end in ambiguous crypto suffixes, such as `aerosol` (`SOL`) or `teeth` (`ETH`), as crypto symbols. Unqualified pairs with `USDT`, `BUSD`, or `USDC` remain case-insensitive, while pairs quoted in ambiguous `BTC`, `ETH`, `SOL`, or `PERP` suffixes and exact bare symbols require uppercase evidence; lowercase bare words are preserved as prose while later valid candidates are still scanned, Unicode letters/marks cannot terminate a symbol match, and explicit exchange-prefixed and TradingView signal forms retain their existing normalization.

**Core Components**:
- `src/services/tradingview/parseTradingViewSignal.js` — Restricts the unqualified suffix fallback while preserving explicit exchange and TradingView parsing.
- `tests/unit/tradingview-signal-parser.test.js` — Covers suffix collisions, generic-query preservation, unqualified pairs, and exact bare symbols.

**Testing**:
- `pnpm test -- tests/unit/tradingview-signal-parser.test.js`
- `pnpm test -- tests/unit/grounding.test.js`
- `pnpm test -- tests/unit/ --testTimeout=5000`

## Deterministic Symbol Extraction (Issue #222)

Stored alerts are now indexed by a validated symbol captured at **write time** by `saveAlert()`, so new documents no longer fall back to `unknown` for ordinary TradingView alert text. Production analytics over a 72h window showed 7 of 10 alerts (70%) bucketed as `unknown` plus a bare integer `"53"` and the parse artifact `MASTER` — the integer in particular could have been made "worse-looking-but-better" by loosening extraction, which would have silently corrupted the same `bySymbol` surface this work exists to fix.

- `parseSymbolFromText()` reuses the hardened `deriveAssetContext()` from `src/services/tradingview/parseTradingViewSignal.js` first, rather than adding a parallel regex, so the `aerosol` / `teeth` lowercase-prose guards and `BTC/USDT` slash-pair preservation stay in one place. Because `deriveAssetContext()` intentionally returns null for non-crypto shapes it does not own (a bare `EXCHANGE:SYMBOL`, a 2-character ticker), the pre-existing TradingView patterns are retained as a second, now-validated pass so coverage is not reduced. `deriveAssetContext()`'s own explicit-exchange pattern was widened to `[A-Z_]+` so underscore venues (`FX_IDC`, `CME_MINI`, `CBOT_MINI`) resolve through that shared path instead of the extra regex.
- `isValidExtractedSymbol()` is the single guard applied to every candidate from every source (`symbol`, `ticker`, `enrichmentData.*`, and text parsing). It rejects non-strings, the `unknown` sentinel, values under 2 characters, numeric-only values, whitespace, backslashes, and malformed slash usage. A single well-formed slash pair (`BTC/USDT`, both sides ≥2 chars) is allowed.
- An invalid explicit property no longer short-circuits: `extractSymbolAndExchange()` falls through to the remaining sources, so `{ symbol: '53', text: 'BINANCE:ETHUSDT(D)…' }` still yields `ETHUSDT`/`BINANCE`.
- Extraction never throws — `parseSymbolFromText()` wraps `deriveAssetContext()` in try/catch and returns the unknown sentinel, preserving the fail-open storage path so persistence can never block alert delivery.
- `unknown` remains the honest fallback for genuinely unparseable text. A symbol is never invented, and a numeric-only or single-character value is never emitted.

**No contract change**: no new environment variable, Remote Config key, endpoint, OpenAPI schema, or Postman variant. Read filtering (`source`, `symbol`, `exchange`, `eventCategory`, `signalClass`) still runs in memory after `receivedAt`-ordered batches, so no new composite Firestore index requirement is introduced. Historical `unknown` documents stay `unknown` — there is no retroactive backfill.

**Coverage**:
- `tests/unit/alert-storage-service.test.js` — Rejects bare integers, single characters, and numeric-only `EXCHANGE:SYMBOL` values; asserts write-time capture of the symbol; asserts a numeric-only symbol is never persisted; asserts no regression for 2-character tickers, `BTC/USDT`, `aerosol`, and `teeth`; asserts the `bySymbol` summary no longer indexes numeric-only or single-character keys.
- `tests/unit/tradingview-signal-parser.test.js` — Unchanged and still green; the shared normalizer was not modified.

**Testing**:
- `pnpm test -- tests/unit/alert-storage-service.test.js tests/integration/alerts-endpoint.test.js --testTimeout=10000`

## Admin Recent Job Discovery (CB-117 / Issue #283)

The in-app `/admin` Jobs view consumes the existing protected `GET /api/jobs` endpoint with contract-derived status/type filters and the bounded `limit` range. It renders only safe summary fields with DOM text nodes, keeps the API key in the existing `x-api-key` header path, and lets operators pre-fill the existing job-status workflow without bypassing its cancel/retry confirmations.

**Core Components**:
- `src/admin/admin.js` — Recent-job list form, safe summary rendering, and selected-job handoff to the status form.
- `tests/unit/admin-client.test.js` — Covers query construction, header-only authentication, safe rendering, status navigation, stale-list clearing, and pending-response invalidation.

Job-list, status, and cancel/retry responses use monotonic request versions and pass activity guards into `sendRequest`, so responses from obsolete filters or job IDs cannot overwrite current state, hold shared forms disabled, or render stale actions.

This is a UI-only consumer change: job persistence, lifecycle semantics, OpenAPI, and Postman contracts remain unchanged.

## Admin Console Fetch Deadlines (CB-164 / Issue #402)

The hosted admin console now bounds browser fetches: `/admin/auth-config` keeps its existing 8-second fallback, `/openapi.json` uses an 8-second contract-load deadline, ordinary protected API requests use 30 seconds, synchronous analysis/news-monitor/market-scanner/scanner-preset/direct-alert/message/replay reports use a 990-second client budget derived from their 120-second analysis and notification-delivery ceilings, volume confirmation uses 390 seconds for its three sequential 120-second MCP calls, and symbol analysis uses 150 seconds. A shared `fetchWithTimeout()` helper keeps response-body parsing inside the abortable operation, clears timers on success/failure, and preserves contract retry plus request error/finally behavior.

**Symbol analysis is 150s, not 390s (Issue #1138).** `/api/webhook/symbol-analysis` used to share the volume-confirmation budget, which multiplied `TRADINGVIEW_MCP_MAX_TIMEOUT_MS` by three sequential MCP calls. It does not have three: `postSymbolAnalysis()` builds **one** `createDeadline()` signal, and that single budget covers the base `analyzeSymbolIdentifier` call *and* the optional `multi_timeframe_analysis` / `multi_agent_debate` calls. The worst case is therefore `min(EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS, 120000)`, plus 30 seconds of ingress and transport overhead. Reusing the volume-confirmation budget left a stalled request freezing the console form for 6.5 minutes after the backend had already given up.

**The two budget copies are not one source of truth, and the drift guard is a test.** `src/admin/admin-request.js` owns the derivation, but `src/admin/admin.js` re-derives every constant inline for the path where the shared helper script has not loaded. The browser harness in `tests/unit/admin-client.test.js` *always* injects `window.CabrosAdminRequest`, so that fallback copy has no behavioural coverage at all. `tests/unit/admin-request.test.js` therefore pins the fallback input literals and asserts the derived totals combine the same operands in both files. **Change a budget constant and update both copies, or the parity test fails.**

**Coverage**:
- `src/admin/admin.js` and generated `public/admin/admin.js` — shared browser deadline helper for auth config, OpenAPI contract, and API requests.
- `tests/unit/admin-client.test.js` — proves stalled contract and protected requests abort, settle through existing error UI, clear timers, and cover every synchronous long-running console route.
- `tests/unit/admin-request.test.js` — derives every budget from its operands, asserts the per-route assignment (including the dedicated 150s symbol-analysis budget), and pins the `admin.js` inline fallback to this module.
- `tests/integration/openapi-docs.test.js` — keeps the public admin asset contract check aligned with the deadline helper.

No new environment variable, endpoint, OpenAPI, Postman, or Remote Config change was needed.

## Admin Playground Request History Records Actual Outcomes (Issue #1163)

A Playground request can end **without an HTTP response at all**, and each way it can end is a distinct operator-facing result. The request history must name that result; it must never synthesize a status for a request that got no response.

**The bug.** `sendRequest` returns `undefined` on every no-response path (authorization refusal, sign-in refresh failure, request construction failure, declined confirmation, superseded request, transport failure). The history callback only tested whether `responseStatus` was set and otherwise fell back to a literal `'200 OK'`, so a declined or failed mutation was recorded as `HTTP 200` — a false success an operator could act on during incident diagnosis.

**The contract.** An HTTP status is assigned **only** after `captureResponseStatus` receives a real response. Every other end is an explicit token from the closed `REQUEST_OUTCOMES` map, reported through the new `captureOutcome` callback and rendered by `describeRequestOutcome()`:

| Outcome | History label | Trigger |
|---|---|---|
| `authorization_denied` | `Not authorized` | Firebase admin auth enabled and the role cannot perform the operation |
| `sign_in_expired` | `Sign-in expired` | `getIdToken()` rejected |
| `invalid_request` | `Invalid request` | `createRequest` threw (bad path/query) |
| `cancelled` | `Cancelled` | Operator dismissed the confirmation dialog; nothing was sent |
| `superseded` | `Superseded` | `isCurrent()` was false before dispatch; nothing was sent |
| `timed_out` | `Timed out` | Client deadline exceeded (`AbortError` from `fetchWithTimeout`) |
| `network_error` | `Network error` | Any other transport failure |
| *(unknown token)* | `No response` | Defensive default; still `ok: false` |

**Invariants**:
- **A no-response outcome is never `ok: true`.** The history entry uses `ok: responseOk`, and `responseOk` is initialized to `false` and set only by `captureResponseStatus`/`captureResponseData`. The previous `responseOk !== false` form happened to coincide because the initializer was already `false`; the bare `responseOk` states the dependency directly, so a future initializer change cannot silently turn a no-response entry into a success.
- **`captureOutcome` fires only where no response exists.** Every call site is inside an early `return` or the `catch` — never on the success path — so a real response can never be overwritten by a later outcome token. `classifyRequestFailure()` reads `error.name === 'AbortError'` to separate an exceeded client budget from a transport failure, because `fetchWithTimeout` aborts through `AbortController` and the request may still have reached the server.
- **`sendRequest` still swallows its own errors.** The `.catch` arm on the Playground handler remains a backstop for a throw outside `sendRequest`'s `try`; it uses the same `describeRequestOutcome()` helper, so it also degrades to `No response` with `ok: false` rather than inventing a status.
- **`showError()` and history stay separate.** The error banner and the history badge are the same fact rendered for two audiences; the history badge is never derived from the banner text.

**Coverage**: `tests/unit/admin-client.test.js`, `describe('request history records the actual outcome')` — network failure, `AbortError` timeout, declined confirmation, authorization refusal, real HTTP 4xx, real HTTP 2xx. The 4xx/2xx cases assert the tone (`status-danger` / `status-ready`) as well as the label, so a label change that keeps the wrong tone still fails.

**Verified in a real browser** at 1440px and 375px: `Cancelled`, `Network error`, `HTTP 400` render in the danger tone (`rgb(180, 45, 66)` on `rgb(255, 240, 241)`) and `HTTP 200` in the ready tone (`rgb(21, 107, 73)` on `rgb(234, 246, 238)`), with no page-level horizontal overflow and every badge and Restore control inside the viewport.

No new environment variable, endpoint, Remote Config key, OpenAPI schema, or Postman variant was added: this is a browser-console rendering fix over existing responses.

## Admin Console Deep Links and Filter State (Issue #1294)

The `/admin` console keeps its active view and its report filters in the URL, so an operator can paste a link to a colleague, and Back/Forward move between views without reloading the page.

**URL shape.** `?view=<name>` selects the view. Filters are namespaced per form as `<scope>.<field>`, e.g. `?view=alerts&alerts.summary.from=2026-08-01T00:00&alerts.summary.limit=500`. The scope prefix exists because `addAlertReportFilters()` is instantiated separately inside `createAlertSummaryForm()` and `createAlertExportForm()`: they are two forms with two default sets, and a single unprefixed `from` would silently couple them. Scopes are declared in the closed `FILTER_SCOPE_VIEWS` map (`alerts.list`, `alerts.summary`, `alerts.export`, `outcomes.list`, `outcomes.summary`, `outcomes.calibration`); a scope outside that map is not deep-linkable, so adding a new report form means adding it there too.

**History semantics.** A nav click is a `pushState` (a real history entry); a filter edit is a `replaceState` (typing must not fill the Back button); `popstate` re-navigates with `history: 'none'`, which renders without writing the URL.

**Invariants**:
- **An unknown or malformed `view` must never render a blank workspace.** `resolveConsoleView()` validates against the closed `CONSOLE_VIEW_NAMES` set and `canonicaliseConsoleUrl()` `replaceState`s the canonical `?view=overview`, so the operator sees the workspace and a shareable URL instead of an empty page.
- **A deep link respects auth and fires no API request before sign-in.** `navigateToView()` still short-circuits to `showSignedOutState()` while `authState.enabled && !authState.user`, and the Firebase path returns from `DOMContentLoaded` before any `renderView`, so a deep link lands on the sign-in card with no `/openapi.json` or `/api/*` traffic. Post-sign-in navigation uses the requested view and otherwise keeps the pre-existing `status` landing view (`FIREBASE_SIGN_IN_LANDING_VIEW`) — honouring the deep link must not silently change the default landing view.
- **URL rewrites never drop the `backend` origin.** `buildConsoleUrl()` copies through every parameter that is neither `view` nor a known filter scope, so the GH-401/CB-163 `ALLOWED_BACKEND_ORIGINS` allowlist and its query-string handling keep working unchanged while the view is added, removed, or canonicalised.
- **The live region is on the small element that changes, not the workspace.** `aria-live` was removed from `#view` in `src/admin/index.html` and moved to a dedicated `#view-status` element that `setViewTitle()` updates. `moveFocusToView()` still moves focus to `#view` on navigation, and `aria-current="page"` still marks exactly one nav button.

**Coverage**: `tests/unit/admin-client.test.js` — URL write on navigation, filter serialise/restore round-trip for both alerts and outcomes (including "the restored form requests the same query"), summary/export scope independence, unknown-view fallback and rewrite, Back/Forward via `popstate`, no-request-before-sign-in on a deep link, `aria-live` placement, and the backend-origin allowlist regression with and without deep-link state. The harness gained a mutable `window.location`, a fake `window.history` that rewrites it, and a `dispatchPopState()` helper.

**Core components**: `src/admin/admin.js` (`resolveConsoleView`, `readConsoleUrlState`, `buildConsoleUrl`, `writeConsoleUrl`, `registerFilterScope`, `collectFilterParams`, `applyFilterParams`, `canonicaliseConsoleUrl`, `handleConsolePopState`, `markActiveView`), `src/admin/index.html` (`#view-status`), and the generated `public/admin/` output — keep it in sync with `pnpm run build:hosting`.

No new endpoint, environment variable, Remote Config key, OpenAPI schema, or Postman variant was added: the OpenAPI contract origin and both allowed backend origins are unaffected because only browser-side navigation state changed.

## Admin Alert Analytics and Export Workflows (CB-120 / Issue #288)

The in-app `/admin` Alerts view now consumes the existing protected `GET /api/alerts/summary` and `GET /api/alerts/export` operations through dedicated bounded report forms. Summary windows default to the latest 24 hours and render returned aggregate data readably; exports require `from`/`to`, support JSONL and CSV, and download the response blob using its content type. Source/enriched filters are applied before bounded summary aggregation with raw Firestore cursors; filtered reports omit shadow-mode metrics because that service has no matching filters.

Raw alert text remains disabled by default and requires an explicit checkbox. The API key stays in session storage and the `x-api-key` header; filenames and query strings never contain it. No route, request, OpenAPI, Postman, or Playground contract changed.

**Coverage**:
- `src/admin/admin.js` — Report filters, summary rendering, safe export downloads, and protected error handling.
- `tests/unit/admin-client.test.js` — Safe defaults, query construction, readable analytics, JSONL/CSV downloads, content types, API-key placement, validation, and errors.

## News Monitor Default Symbol Validation (CB-144 / Issue #361)

`POST` and `GET /api/news-monitor` now resolve configured `NEWS_SYMBOLS_CRYPTO` and `NEWS_SYMBOLS_STOCKS` defaults before applying the existing symbol validator. Invalid syntax and lists over 100 symbols return the existing `400 INVALID_REQUEST` response before analysis; valid defaults retain their crypto/stock asset-class mapping. Explicit request symbols, notification routing, cache behavior, provider selection, and public contracts remain unchanged.

**Coverage**:
- `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js` — Resolves defaults before the shared validation boundary.
- `tests/integration/news-monitor-alerts.test.js` — Covers invalid and oversized defaults before analysis and valid default asset-class propagation.

## TradingView MCP Environment Validation (CB-145 / Issue #362)

`RemoteConfigService.getEnvironmentConfig()` applies the existing `PARAMETER_SCHEMA` to `TRADINGVIEW_MCP_TIMEOUT_MS`, `TRADINGVIEW_MCP_MAX_RETRIES`, and `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS` before `TradingViewMcpService` consumes them. Malformed, non-finite, non-positive, and out-of-range values fall back to defaults (`12000`, `3`, and `12000`); valid values, including documented boundaries, remain unchanged. No provider, feature gate, fail-open, API, OpenAPI, or Postman contract changed.

**Coverage**:
- `tests/unit/remote-config-service.test.js` — Covers malformed, non-finite, negative, zero, out-of-range, valid, and boundary environment values.
- `tests/unit/tradingview-mcp-service.test.js` — Verifies runtime MCP timing values remain finite and positive.

## TradingView MCP Enrichment Budget Retries (CB-183 / Issue #422)

`TradingViewMcpService.enrichFromSignal()` keeps the existing total enrichment deadline and gives base analysis the full budget when optional enrichment is disabled; otherwise it reserves a bounded base-analysis sub-budget. Each `coin_analysis` attempt receives its own remaining-time abort signal, and retry delays are capped to the available base deadline, so retries cannot outlive the total envelope. Volume, confluence, and multi-timeframe calls combine their per-call signal with the remaining total budget; optional timeout/failure preserves successful base enrichment and marks the result `tradingViewEnrichmentStatus: "partial"`. Base failures remain fail-open and are recorded as `"failed"` in sanitized runtime and Firestore alert telemetry. CSV exports include the allow-listed enrichment status.

**Coverage**:
- `src/services/tradingview/TradingViewMcpService.js` — Bounded base retry sub-budget, remaining-budget abort propagation, optional fail-open handling, and full/partial/failed runtime counters.
- `tests/unit/tradingview-mcp-service.test.js` — Covers full-budget base analysis, capped retry delays, optional timeout preserving base data, failed status accounting, the budget-arithmetic guard against a retry collapsing to 1ms (GH-630), and budget-exhaustion classification via the structural `mcpBudgetExhausted` marker rather than message text.
- `src/services/storage/AlertStorageService.js` — Persists only the allow-listed enrichment outcome status.

`TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS`, `TRADINGVIEW_MCP_TIMEOUT_MS`, and `TRADINGVIEW_MCP_MAX_RETRIES` remain the existing environment/Remote Config controls; no new environment variable was added.

## News Monitor Cached No-Event Analyses (CB-146 / Issue #363)

News monitor cache reads now include `EventCategory.NONE`, so a cached no-event analysis returns `AnalysisStatus.CACHED` during its existing TTL without repeating market-context or Gemini provider calls. Event-category cache keys remain independent and the existing dry-run, routing, delivery, TTL, and fail-open behavior is unchanged.

**Coverage**:
- `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` — Reads the existing no-event cache entry at the shared cache boundary.
- `tests/integration/news-monitor-cache.test.js` — Verifies no-event cache hits return no alert and avoid repeated Gemini/market-context provider calls.

No endpoint or response contract changed; Postman and OpenAPI remain unchanged.

## Remote Config Environment Boundaries (CB-169 / Issue #405)

`RemoteConfigService.getEnvironmentConfig()` preserves positive integer environment values for `WEBHOOK_IDEMPOTENCY_TTL_MS` and `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS` even when they exceed the ceilings used to validate Firebase Remote Config overrides. Out-of-range remote values remain rejected and fail open to the environment value; the other environment parameters retain their existing bounded parsing.

**Coverage**:
- `src/services/remoteConfig/RemoteConfigService.js` — Separates environment parsing from bounded remote override parsing for the two affected runtime controls.
- `tests/unit/remote-config-service.test.js` — Covers high environment values and invalid remote overrides for both controls.

No endpoint, OpenAPI, Postman, Firebase template, or environment-variable name changed.

## Analyzer Cooldown Test Module Isolation (CB-168 / Issue #404)

The analyzer cooldown regression test loads `geminiQuotaManager` and `NewsAnalyzer` inside one `jest.isolateModules()` registry after an explicit module reset. This keeps the cooldown state configured by the test attached to the same singleton instance cached by `NewsAnalyzer`, preventing order-dependent false `analyzed` results.

**Coverage**:
- `tests/unit/analyzer.test.js` — Verifies the existing cooldown-timeout regression uses the isolated manager and produces the expected timeout after cooldown waiting.

This is test-only hardening; runtime code, endpoints, OpenAPI, Postman, and environment configuration remain unchanged.

## TradingView MCP Risk Metadata (CB-175 / Issue #412)

TradingView MCP alert enrichment derives optional directional invalidation, target, setup, and risk/reward metadata from the MCP analysis. Numeric and numeric-string ATR values are normalized before validation. ATR-derived levels are emitted only when the supplied ATR and every resulting level are finite, positive, and on the correct side of entry; a rejected supplied ATR still suppresses the entire numeric risk block instead of falling back to a synthetic ATR stop (Issue #1229 then supplies a separate, provenance-tagged secondary heuristic plan — see below). Setup metadata remains independently optional, uses explicit/inferred evidence only, and mean-reversion inference must align Bollinger position with signal direction. When Gemini and MCP enrichment are combined, invalidation, target, and risk/reward are selected atomically from one complete provider block to prevent inconsistent ratios.

**Coverage**:
- `src/services/tradingview/TradingViewMcpService.js` — MCP risk derivation, ATR rejection, standalone setup metadata, and side-aware setup inference.
- `src/controllers/webhooks/handlers/alert/grounding.js` — Atomic Gemini/MCP risk-block selection.
- `tests/unit/tradingview-mcp-service.test.js` and `tests/unit/alert-handler.test.js` — Directional calculations, invalid ATR/fallback suppression, setup inference, and provider merge invariants.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config contract changed; existing optional response fields and formatter support remain in place.

## Secondary Fallback Trade Plan for Rejected ATR (Issue #1229)

`TradingViewMcpService._toEnrichedAlert()` now calls `calculateFallbackRiskLevels()` from `src/services/tradingview/fallbackTradePlan.js` as a **secondary** source of risk metadata. Previously that module was dead code inside the MCP path.

**Contract**:
- The fallback runs **only** when `hasValidRiskMetadata` is false — i.e. the ATR-derived block was rejected because ATR was `0`, non-finite, or a resulting level failed the side/positivity check — **and** MCP supplied a usable `current_price`.
- A valid ATR-derived block always wins. A real ATR level is never downgraded to a heuristic one, and `levelsSource` is omitted on that path exactly as before.
- The ATR block itself is still suppressed: an invalid ATR never produces a synthetic ATR stop. The fallback is an additional source, not a relaxation of the ATR validation rules.
- When the fallback supplies the levels they are tagged `levelsSource: 'fallback-trade-plan'` so dashboards and the stored-alert summary can distinguish heuristic levels from ATR-derived ones. The OpenAPI `levelsSource` enum and `EnrichedAlert.levelsSource` in `src/services/grounding/types.ts` were extended with the new value; `mergeEnrichmentData()` in `src/controllers/webhooks/handlers/alert/grounding.js` propagates the tag without ever overriding a `gemini-grounding` source.
- `getRiskRewardRatio()` recomputes the ratio from the fallback stop/target so a fallback level is never paired with a stale ATR ratio. The fallback levels are re-validated with `isValidRiskLevel()` before use, and any failure stays fail-open (alert delivery is never blocked).
- `setup_type` is unchanged: the fallback does not inject `trend_continuation` on its own, so setup evidence remains explicit or MCP-inferred only.

**Sanity-checked risk map** (`TIMEFRAME_RISK_MAP`, nominal R:R 2.0): 5m/15m stop 1.5% / target 3%, 1h/4h stop 2.5% / target 5%, 1D/1W/1M stop 5% / target 10%, unknown timeframe falls back to the 1h defaults. Stops widen with the analysis horizon and stay strictly on the correct side of entry for both BUY and SELL.

The **emitted** `risk_reward_ratio` is recomputed from the rounded levels that actually ship, so it is only *approximately* 2.0 (observed drift up to ~0.01 on non-round prices, e.g. `2.0095`). That recomputation is deliberate: it guarantees the ratio always matches the displayed stop and target rather than a stale plan constant. Consumers must not treat exactly `2` as an invariant.

**Coverage**:
- `tests/unit/tradingview-mcp-service.test.js` — Zero ATR and non-finite ATR each produce a `fallback-trade-plan` block (BUY and SELL), a valid ATR block is never downgraded, and no usable MCP price means no fallback at all.

No new environment variable or Remote Config key was added. Post-merge this path sees no traffic until #630/#591 restore MCP enrichment in production; that is an independent fix and this change is correct to land first.

## Telegram Delivery Retry and Telemetry (CB-178 / Issue #415)

`TelegramService.send()` retries only definitive Telegram `429` responses with the provider's `retry_after` delay; transport and `5xx` failures are not retried because Telegram has no `sendMessage` idempotency key and the request may already have been accepted. Each Telegraf API attempt has a bounded 10-second deadline, while retry waits have a 5-second per-delay cap and a shared 10-second budget across all message chunks. MarkdownV2 remains the primary delivery mode; parse failures use a plain-text retry with every MarkdownV2 formatter escape removed. Every result reports `statusCode`, `category`, `attemptCount`, and `durationMs`, including zero-attempt, partial chunk, and aborted/configuration paths, so `NotificationManager` preserves exact attempt telemetry for Sentry and admin alerts.

**Coverage**:
- `tests/unit/telegram-service.test.js` — Covers parse fallback unescaping, `429` retry-after handling, ambiguous transport failures, shared retry budgets, retry-budget aborts, and delivery telemetry.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config contract changed.

## Standalone Worker Sentry Shutdown Flush (CB-179 / Issue #416)

The dedicated BullMQ worker and signal-outcome worker now await the existing fail-safe `sentryService.flush(2000)` after draining work and before exiting on `SIGTERM`/`SIGINT`, including the BullMQ worker's nonzero-exit error path. This preserves shutdown telemetry without changing worker gates, drain bounds, or exit codes.

**Coverage**:
- `tests/unit/worker-sentry-shutdown.test.js` verifies drain, flush, and exit ordering for both standalone workers.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config change was required.

## Binance `/precio` Market Context (Issue #527)

Crypto `/precio` replies keep the existing average-price lookup and append Binance 24h change, high/low range, and quote-asset-labeled volume when the ticker payload is valid. Each ticker request applies the current `BINANCE_FETCH_TIMEOUT_MS` runtime value, logs a warning, and preserves the exact bare-price reply on provider failure or malformed data. No new endpoint, dependency, environment variable, or Remote Config key was added; the optional sparkline was intentionally skipped as outside the acceptance criteria.

**Coverage**:
- `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js` — Validates and formats 24h ticker context with fail-open fallback and Sentry span instrumentation.
- `tests/unit/fetch-symbol-price.test.js` — Covers enriched output, ticker failure, and malformed payload fallback.

## Fail-Open Configuration Doctor (CB-240 / Issue #535)

`scripts/validate-env.js` provides `pnpm run doctor` and a non-blocking startup preflight for development and production. It warns about malformed values, missing credentials for enabled features, and unavailable Firebase prerequisites without throwing or printing secret values. `pnpm start-dev` runs the quiet preflight before `nodemon`; `pnpm start` keeps the existing startup command and logs structured warnings once through `index.js`.

**Coverage**:
- `tests/unit/validate-env.test.js` — Validator rules, bounds, URL/chat/symbol formats, and secret-safe warning formatting.
- `tests/integration/config-doctor.test.js` — Doctor exit status and startup warning/gating behavior.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config change was required.

## News Monitor Indeterminate Lease Persistence (CB-189 / Issue #426)

Cached news-monitor retries now distinguish active delivery ownership from durable persistence ownership. Proven lease loss still aborts the retry and removes its result from the response; an indeterminate renewal (`null` or an exception) keeps a successful delivery result in the current response and local cache while skipping only the durable cache merge, preventing a stale replica from overwriting a newer result. Persistent refreshes preserve successful finalized local-only results per delivery channel instead of replacing them with older Firestore snapshots; failed indeterminate retries do not create a local overlay. Per-channel timer renewals are serialized, and in-flight/final renewals are bounded by the analysis deadline; only channels still unresolved at that deadline lose persistence ownership.

**Coverage**:
- `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` — Separates response ownership from persistence ownership during cached retry lease renewal, bounds renewal waits, preserves independently completed channels, and overlays only successful non-durable retries.
- `src/controllers/webhooks/handlers/newsMonitor/cache.js` — Allows local cache refreshes while suppressing an indeterminate durable write and protects per-channel finalized local-only results from stale persistent refreshes.
- `tests/integration/news-monitor-cache.test.js` and `tests/unit/news-monitor-persistent-dedup.test.js` — Verify successful indeterminate retries are retained locally, stalled renewals are bounded, completed channels keep durable persistence, and mixed-channel stale Firestore refreshes do not reintroduce failures.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config contract changed.

## Webhook Alert Repeat Suppression (CB-230 / Issue #522)

`/api/webhook/alert` supports opt-in same-signal repeat suppression. When `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION=true`, a signal whose `(exchange, symbol, timeframe, side)` key already fired within a cooldown window of `ALERT_SIGNAL_COOLDOWN_BARS` bars (default `1`, bounded `1`-`10`) skips channel delivery but still returns 200 with `suppressedRepeat: true` and remains persisted with the marker so replay and audit stay complete. Opposite-side flips always deliver because they produce a different key; unknown timeframes never suppress; dry-run requests bypass the cooldown entirely. The in-process store fails open on read/write errors, and both Remote Config keys (`ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION`, `ALERT_SIGNAL_COOLDOWN_BARS`) follow the parity workflow with template entries.

**Core Components**:
- `src/services/alerts/signalRepeatCooldown.js` — Key building, bar-window math, suppression counters, fail-open store semantics.
- `src/controllers/webhooks/handlers/alert/alert.js` — Post-enrichment gate before notification dispatch and persistence marker propagation.
- `src/services/storage/AlertStorageService.js` — Persists `suppressedRepeat: true` (with empty delivery results) and returns it on reads.
- `src/controllers/status.js` — `featureFlags.alertSignalRepeatSuppression` plus non-sensitive `dependencies.alertSignalRepeatSuppression` counters (`suppressedCount`, `lastSuppressedAt`, `activeTrackedSignals`).
- `tests/unit/signal-repeat-cooldown.test.js`, `tests/integration/alert-repeat-suppression.test.js`, `tests/integration/status-endpoint.test.js` — Window/flip/fail-open coverage, endpoint double-post behavior, and status exposure.

Disabled by default preserves existing webhook behavior byte-for-byte.

## CI Secret Scanning and Least-Privilege Workflows (CB-257 / Issue #556)

`.github/workflows/secret-scan.yml` runs the pinned Gitleaks Action on pushes to `master`, pull requests, and manual dispatch with full git history. It uses only the GitHub token and optional organization license secret; no application credentials are introduced. `.gitleaks.toml` narrowly allowlists the intentionally public Firebase browser key already tracked in `render.yaml`, without disabling other detections. `.github/workflows/node.js.yml` and `.github/workflows/env-drift-check.yml` now explicitly grant `contents: read` permissions. README documents secret storage and rotation for webhook, Binance, and Firebase service-account credentials.

This change is workflow/documentation-only: no application environment variable, Remote Config key, endpoint, OpenAPI, or Postman contract changed.

## Binance Market-Data Host Configuration (CB-244 / Issue #539)

Added an application-owned `BINANCE_DATA_BASE_URL` env var (default `https://api.binance.com`) that overrides the default Binance REST host for **all** market-data client construction paths. The new variable is forwarded as `MainClient` `baseUrl` (which `binance@2.15.22` honors via `BaseRestClient.options.baseUrl` → `requestUtils.getRestBaseUrl`), so Railway production can route around the `HTTP 451 Service unavailable from restricted location` reply from `api.binance.com` without touching the trading order client or hot-patching `node_modules`. Affected paths: `SignalOutcomeService` sweep + entry fallback, `BinanceOrderService` live client (testnet stays pinned to `https://testnet.binance.vision`), news-monitor price fallback, and the `/precio` Telegram command. Malformed values fall back to the default with a `console.warn`, so a typo never silently breaks evaluation.

Binance 451 / `restricted location` errors are now classified as `binance_region_blocked` on the entry-fallback path (persists `eligibilityReason` and keeps the signal `pending_entry_price` until the host becomes reachable) and as `market_data_region_blocked` on the sweep path (replaces the prior generic `market_data_unavailable` so dashboards can distinguish "expected closure" from "transient gap"; surfaced as `lastRunRegionBlockedCount` on the worker status). The pending retry path now writes `outcome.reason` so operators see the classification without forcing an unavailable terminal state.

**Core Components**:
- `src/services/storage/SignalOutcomeService.js` — `resolveBinanceBaseUrl()` + `isRegionBlockedError()`, `baseUrl` forwarding in `getBinanceClient()`, region-blocked entry + sweep classification, worker status counter.
- `src/services/trading/BinanceOrderService.js` — `resolveLiveBaseUrl()` + `https://`-only validation; preserves testnet override; live forwarding.
- `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` and `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js` — Honor `BINANCE_DATA_BASE_URL` for the price fallback and `/precio` client.
- `.env.example` — Documents the env var with default + valid-value guidance.
- `tests/unit/signal-outcome-service.test.js` and `tests/unit/binance-order-service.test.js` — `baseUrl` forwarding + 451 classification + fallback coverage.

**Configuration**:
- `BINANCE_DATA_BASE_URL` — Optional override for all Binance market-data REST calls. Default `https://api.binance.com` (preserves existing behavior when unset). Must be an http(s) URL; live trading also requires `https://`. Classified as **environment-only** for Remote Config parity (external destination; secrets/credentials/external-endpoint policy excludes it).

No endpoint, OpenAPI, Postman, or Remote Config contract changed; the new env var follows the standard `environment-only` classification.

## Global Request Deadline Middleware (GH-693)

`app.js` mounts `src/lib/requestDeadline.js` so every `/api` route inherits a server-side time budget and 408s instead of holding the connection open past the reverse-proxy timeout.

**Behavior**
- `REQUEST_TIMEOUT_MS` (default 30000 ms; integer 1000-120000) caps the response lifecycle. When exceeded, the middleware writes a structured `408 REQUEST_TIMEOUT` with `{ error, code, requestId, deadlineMs, durationMs }`, suppresses late downstream response writes, and logs a single `console.warn` with the route, method, duration, and request id.
- The middleware reuses a valid upstream `req.requestId` or `x-request-id` (when available) or mints a fresh `randomUUID()`, stamps `X-Request-Id` on every response, and exposes it via `req.requestId`.
- `/healthcheck`, `/ready`, `/openapi.json`, and `/docs` are always exempt. Operators can add more paths via `REQUEST_DEADLINE_EXEMPT_PATHS` (comma-separated, leading slash optional).
- If the handler finishes before the deadline, `res.once('finish' | 'close', finalize)` clears the timer so no double-send happens.
- Malformed, non-numeric, sub-minimum, or out-of-range `REQUEST_TIMEOUT_MS` values fall back to the documented default and log a single warning (no spam).
- Handlers that already enforce per-call timeouts (e.g. `/api/webhook/expanded-analysis-alert` with `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS`) keep their internal abort signal — the request deadline is the absolute backstop, not a replacement.

**Core components**
- `src/lib/requestDeadline.js` — bounded validation, request-id minting, deadline enforcement.
- `app.js` — middleware starts before body parsing so slow uploads are bounded; its post-parser guard prevents timed-out requests from entering route handlers, while probe paths remain exempt.
- `tests/unit/requestDeadline.test.js` — exempt-path pass-through, request-id reuse/mint, structured 408 payload, `REQUEST_DEADLINE_EXEMPT_PATHS` extension, malformed-value fallback, and integration via supertest + real `http.Server`.
- `.env.example` and `README.md` — documented the default, valid range, and opt-out behavior.

**Configuration**
- `REQUEST_TIMEOUT_MS` — Optional request-deadline ceiling (default 30000, integer 1000-120000; invalid values fall back to 30000 with a single warning). Classified as **remote-config eligible** and integrated into `RemoteConfigService` (`PARAMETER_SCHEMA`), `firebase-remote-config-template.json`, and dynamic runtime config overrides.
- `REQUEST_DEADLINE_EXEMPT_PATHS` — Optional comma-separated path list (defaults to `/healthcheck,/ready,/openapi.json,/docs`). Classified as **environment-only** for Remote Config parity (path allow-list is a route/security control, not a runtime tuning knob).

**API Contracts**
- The structured `408` timeout response (`RequestTimeoutError` schema and `RequestTimeout` response component) is formally specified in `src/openapi/openapi.json` for all non-exempt `/api` operation paths.
- Response examples for `Request Timeout (408)` are documented in `CabrosBot.postman_collection.json` across primary webhook and job ingest operations.

## Structured Request Logging Middleware (GH-665)

`app.js` mounts `src/lib/requestLogger.js` as the outermost middleware so every completed HTTP request emits exactly one structured JSON line with method, path, status code, duration, and correlation id.

**Behavior**
- One line per terminal outcome, at `console.info` for 2xx/3xx, `console.warn` for 4xx and client-aborted requests, and `console.error` for 5xx. Fields: `method`, `path`, `statusCode`, `durationMs`, `requestId`, `clientIp`, `aborted`, `outcome`.
- Mounted **before** CORS, body parsing, the request deadline, body-size limits, and the rate limiter, so parser `413`s, CORS rejections, deadline `408`s, rate-limit `429`s, and route handlers are all observed. The middleware only observes the response lifecycle and never writes a status, header, or body, so it cannot change any API contract.
- **Correlation ids are shared, not duplicated.** The logger resolves the id through `requestDeadline.resolveRequestId(req)`, which prefers `req.requestId` before the inbound `x-request-id`, and stamps `req.requestId` **before** the exemption check. Because the deadline runs later and reuses the header, the log line and the `408` payload always carry the same id — this is the reason the logger must not mint its own id. Stamping before the exemption return matters on its own: an operator can exempt an API route through `REQUEST_DEADLINE_EXEMPT_PATHS`, and `requestDeadline` skips that route without setting `X-Request-Id`, so the id is stamped here and stays in agreement with the `requestId` the handler still returns in its body. Note that the `X-Request-Id` **header** is still absent on an exempt route — that is pre-existing `requestDeadline` behaviour on `master`, not introduced here.
- `X-Request-Id` is declared as a reusable response-header component (`components.headers.XRequestIdResponseHeader`) and referenced from **the response components**, never beside a `$ref`. A response node holding `$ref` is a Reference Object, and OpenAPI 3.1 requires siblings other than `$ref`/`summary`/`description` to be ignored — `SwaggerParser` merges them anyway, so the document validates while conforming generators silently drop the header. Any handler echoing a `requestId` must source it from `req.requestId`, never a fresh UUID; `GET /api/selftest` and `POST /api/selftest/run` were the last holdouts.
- **Probe paths are skipped**, reusing the request-deadline exemption vocabulary via `requestDeadline.resolveExemptPaths()` **and** `requestDeadline.isExemptPath()`, which resolves `REQUEST_DEADLINE_EXEMPT_PATHS` plus its defaults (`/healthcheck`, `/ready`, `/openapi.json`, `/docs`). It is resolved **per request**, not frozen at module load, so a path an operator adds to that variable is exempt from both middlewares at once. Both `resolveExemptPaths` and `isExemptPath` were exported for this purpose; **do not fork the list or the predicate** — the logger previously kept a private `matchesExemptPath` copy, which let the two middlewares disagree about `/docs/*` assets. `normalizeExemptPath()` is the single rule applied to both the configured set and incoming requests: lower-case, then strip trailing slashes. Both halves matter, because they are silent failures otherwise — without lower-casing, `REQUEST_DEADLINE_EXEMPT_PATHS=/Internal/Ping` would never match, and without trailing-slash stripping `/api/slow/` would never match a request for `/api/slow`. `/docs` is treated as a **subtree** in `requestDeadline.isExemptPath`, since the Swagger UI page pulls `swagger-ui.css`, `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`, and `swagger-initializer.js` from the same router.
- Paths are normalized by stripping the query string and trailing slashes, so query secrets never reach the log line and `/api/x` and `/api/x/` group together. **Case is preserved** in the emitted path: Firestore document ids are mixed-case and case-sensitive, so lower-casing would make `/api/alerts/:alertId` unsearchable against the id an operator saw in a 404 body.
- The exemption set is matched through the shared `requestDeadline.isExemptPath`, which is **case-insensitive** and subtree-aware. Express routing is case-insensitive by default, so `/HEALTHCHECK` reaches the healthcheck handler and must not re-enter the logs as a bypass of the probe skip list. Matching and display are deliberately separate concerns.
- **Sensitive path segments are masked** via `SENSITIVE_PATH_SEGMENTS`, applied by `maskSensitivePathSegments` to the emitted value only. `/api/preferences/:channel/:chatId` carries a Telegram or WhatsApp chat identifier — a personal destination, and the one parameterized segment that is not an opaque document or job id. `logging.js` does not redact it, because the attribute is named `path` and numeric or `@g.us` values do not match its secret patterns. `alertId` (mixed-case Firestore doc id), `jobId` (UUID), and `scanner-presets/:id` stay intact so those paths remain searchable during triage. **Masking must run after exemption matching**: `normalizeRequestPath` returns the unmasked path, `isExemptPath` tests that, and only then is the logged value masked — otherwise an operator who configured `/api/preferences/telegram/123` as exempt would still see it logged, since `:redacted` cannot match the configured entry.
- `clientIp` is truncated to `a.b.c.x` for IPv4, and IPv6 is reported as `ipv6-redacted` rather than logged in full, keeping client addresses out of logs in usable form.
- **Event-stream closes are not aborts.** `GET /api/admin/events` is a server-sent-events response held open for the life of the subscription, so it never reaches `writableFinished` and its `close` is the normal end of stream. The admin console aborts its `EventSource` on teardown and on stream replacement (`src/admin/admin.js`), so classifying those as aborts would bury the real client-failure signal. `isSsePath()` matches the SSE route and records its close as `outcome: "completed"` at `info`; every other route keeps the abort semantics below.
- Client aborts are distinguished from completions via `res.on('finish')` vs. `res.on('close')` and recorded as `outcome: "aborted"` at `warn` — an aborted request is an operational signal, not a client error. The `close` branch reads **`res.writableFinished`, not `res.writableEnded`**: `writableEnded` flips the moment the handler calls `res.end()`, before the bytes reach the socket, so a client disconnecting in that window would otherwise be logged as a clean completion with an understated duration. `finish` always wins the race for a clean response, so `close` seeing `writableFinished === true` implies `finish` never fired.
- `statusCode` is `0` when `res.headersSent` is false. Node initializes `statusCode` to `200` even when nothing was ever written, so an early client disconnect would otherwise be logged as a phantom success and dashboards grouping by status would invent 200s.
- `emit()` is wrapped in `try/catch` inside `finalize`. `console.*` is globally replaceable and the listener runs from a Node event emitter outside Express's `try/catch`, so a throwing sink would otherwise crash the process from an observability path.

**Core components**
- `src/lib/requestLogger.js` — path normalization, id resolution, IP sanitization, level selection, and single-emission finalization.
- `app.js` — mounts the logger ahead of every other response-producing middleware.
- `tests/unit/requestLogger.test.js` and `tests/integration/request-logger.test.js` — unit coverage plus supertest coverage for parser rejections, header id reuse, 408/payload id agreement, exempt-path id stamping, address-family masking, and probe-path silence.

**Configuration**
- No new environment variable. The skip set is derived from `REQUEST_DEADLINE_EXEMPT_PATHS`, and the log level follows `LOG_LEVEL` through the existing `src/lib/logging.js` pipeline, which already applies secret redaction to every emitted line.

No endpoint, OpenAPI, Postman, or Remote Config contract changed.

## Admin Status Dependency Explorer (Issue #673)

The dedicated `/admin` Status view now renders the existing `/api/status` response as an operational dashboard: overview metrics, delivery-channel cards, expandable dependency cards, enabled-capability chips, and a collapsed raw JSON response with copy support. Dependency cards show safe timing, counters, configuration, provider, error-category, storage, scheduler, and worker fields using DOM text nodes only. Client-side status filters and search sort attention items ahead of healthy dependencies and provide a filtered empty state. The existing overview dashboard continues to use the shared status renderer.

**Coverage**:
- `tests/unit/admin-client.test.js` — Status explorer rendering, attention-first ordering, safe error text, search, tone filtering, refresh timeout/auth behavior, and redacted output.
- `src/admin/admin.js` / `src/admin/admin.css` — Dedicated explorer view, detail cards, filters, timestamp metadata, and responsive styling.
- `public/admin/admin.js` / `public/admin/admin.css` — Hosting build output synchronized with source assets.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config contract changed.

## Job Queue Broker Readiness (Issue #1117)

`JobQueue` runs a bounded, fail-open **broker readiness probe** at web startup when `JOB_EXECUTION_MODE=render-worker`, and projects the verdict onto `dependencies.jobExecutionQueue` as `brokerReachable` / `lastBrokerProbeAt` / `lastBrokerProbeErrorCode`, with `status` now one of `disabled`, `misconfigured`, `not_started`, `unreachable`, `ready`.

**`configured` is not health.** `isConfigured()` only string-checks `REDIS_URL`. Before this change, `ready` was set as a side effect of `_getQueue()`, which runs on the first `enqueue()`, so a correctly cut-over but completely idle deployment reported `not_started` — the exact state an operator would read as "the enablement failed" — and an unreachable broker reported an identical `enabled/configured/ready/status` tuple. This is the same class of defect #1285 fixed for Firestore read health: a readiness assertion must exercise the operation it claims to be available, not a cheaper proxy.

**`null` and `false` are different verdicts.** `brokerReachable` is `null` until a probe has actually run, and stays `null` whenever queue mode is disabled or unconfigured (there is no broker to have a verdict about). `false` means a probe ran and the broker did not answer. Collapsing the two reintroduces the exact ambiguity above. `getStatus()` also reports `unreachable` in preference to `not_started` once a probe has failed, because a known-bad broker must never read as an unstarted one.

**The probe is fail-open and bounded.** `probeBrokerReadiness()` is single-flight, bounded by `JOB_QUEUE_PROBE_TIMEOUT_MS` (default `5000`, malformed values fall back to the default), uses an `unref`'d timer so it cannot hold the process open, and never throws — a broker that accepts TCP but never completes the Redis handshake yields `unreachable` instead of stalling boot or a `/api/status` request. It warms the same queue the first `enqueue()` would create, so it does not double-connect. `close()` resets the probe verdict so a stale `reachable: true` cannot outlive the connection.

**The render-worker cutover stays an operator step.** `render.yaml` keeps the web service on `JOB_EXECUTION_MODE=local` while the jobs worker runs `render-worker`, because the Key Value broker is on a paid `starter` plan. Flipping the web service in the blueprint would make job creation fail closed with `503 JOB_QUEUE_UNAVAILABLE` on any deployment without a broker. The full queue contract (`JOB_QUEUE_*`) is now declared on **both** services at the in-code defaults, mirrored `fromService` web → worker, so it is dashboard-visible and cannot silently diverge between the two processes.

**Coverage**: `tests/unit/job-queue.test.js` (probe reachability, unreachable-vs-unprobed, `misconfigured` skip, bounded deadline, malformed-value default, single-flight, never-throws), `tests/integration/status-endpoint.test.js` (`ready`/`unreachable`/misconfigured projection and no broker-URL leak), `tests/unit/render-blueprint.test.js` (queue contract declared on both services and mirrored, web stays on `local`), `tests/unit/postman-collection.test.js` + `tests/integration/openapi-docs.test.js` (published contract).

**Remaining for the platform owner**: provisioning the paid `cabros-crypto-bot-telegram-queue` Key Value, deploying the jobs worker, and flipping web `JOB_EXECUTION_MODE=render-worker`. That is billing-gated deployment work, not an application code change.

## Async Job Backlog Depth & Operator Paging (Issue #578)

`JobBacklogService` reports durable async-job backlog depth on `/api/status` and `/api/capabilities` under `dependencies.jobExecutionQueue` and pages `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` when non-terminal queued jobs accumulate while workers are stalled or offline. Broker readiness cannot distinguish a *ready but undrained* queue from a healthy one, so depth is reported alongside readiness.

**Core components**: `src/services/jobs/JobBacklogService.js` (probe sweeps, cooldown dedup, fail-open paging), `JobRepository.getBacklogDepth()` (bounded durable scan) / `getMemoryBacklogDepth()`, `JobQueue.getJobCounts()` and `getStatus(backlog)`, `RemoteConfigService` (`JOB_BACKLOG_ALERT_THRESHOLD_MS`, `JOB_BACKLOG_PAGE_COOLDOWN_MS`, `JOB_BACKLOG_PROBE_INTERVAL_MS`).

**Invariants**:
- `durableQueuedCount` is a **lower bound**. The scan is bounded to `maxPages` (default 5) × `maxScan` (default 100) and sets `truncated` when it stops early. An unbounded `while(true)` here reads the whole collection every probe interval.
- **Rotation-cycle evidence accumulates, and is re-evaluated at close.** A collection larger than the page cap is tiled by consecutive capped windows, and `JobRepository` carries a cursor across probes so the cycle closes on whichever sweep first reaches the end from a cursor (`cycleComplete`). Proving recovery therefore needs *every* window in that cycle to be below threshold, not only the one immediately preceding the closing sweep: with three windows (aged front → quiet middle → closing tail), retaining just the last window forgets the aged front and emits a false all-clear while a stall is still queued in the unscanned head.
- **The cycle evidence is one number, not a per-window buffer.** `_cycleOldestQueuedCreatedAtMs` accumulates a monotonic minimum, which is equivalent to checking every window because "below threshold" is monotone in creation time — a window that observed no queued work proved its own prefix empty and contributes nothing, and among the rest only the oldest can be over the threshold. It cannot grow, cannot be truncated (an array cap that drops windows silently invalidates the tiling, and dropping the *oldest* drops exactly the evidence that blocks a false all-clear), and needs no storage. States: `null` = no cycle open, `+Infinity` = open cycle with no queued work observed, `-Infinity` = queued work whose age could not be read (holds the latch), otherwise a creation time.
- **Cycle evidence keys on whether the durable read *happened*, not on `durableProbeSucceeded`.** A capped sweep cannot report a *total* depth, so `isDurableResultConclusive()` returns `false` for it — yet it read its window completely and is conclusive about the region it read, which is exactly the evidence needed here. Keying on `durableProbeSucceeded` makes a drained collection larger than the page cap permanently unprovable: the latch never clears and the operator is re-paged every cooldown for an empty queue. `durableObserved` is that separate flag. A *memory-mirror* read is total and must set **both** flags, or a drained local-mode backlog reports `durableProbeSucceeded: false` next to a real count and can never clear.
- **A failed sweep is not evidence of a cursor reset.** `probeFailed` results also carry `truncated: false`, so the uncapped "reset" branch must exclude them, or a storage blip discards the evidence at the moment it is most valuable. Preserve it on failure; only a *successful* uncapped sweep resets it.
- The recorded `oldestCreatedAt` is re-evaluated at close, **not** a frozen `quiet` boolean. A window's "quiet" verdict is only true at the instant it was read — a job at 14m30s with a 15m threshold is quiet, and is aged by the time the tail sweep closes the cycle. `isCycleProven()` recomputes against the closing sweep's own `now` and the current `alertThresholdMs`; storing the age as a snapshot produces an all-clear followed by a re-page on the next front scan.
- **Queued work that cannot be dated is indeterminate, not drained.** `isDurableResultConclusive()` and `isSweepComplete()` must reject a result whose `durableQueuedCount > 0` but whose `oldestQueuedAgeMs` is not finite. `_evaluateAlert()` reads a null age as "below threshold", so without that guard a complete scan holding queued work with a missing/malformed `createdAt` clears the latch and sends a false all-clear.
- **A cycle closing is not a consistent snapshot, so the front is re-read.** `isQueuedExecution()` counts a `claimed`/`running` row whose lease has expired as queued, so a row in the already-scanned prefix can *become* queued while later windows are read. The cursor is cleared on completion, so nothing else re-reads that prefix. `JobRepository.getFrontBacklogDepth()` re-reads the oldest window before the recovery decision is taken, and `_revalidateCycleFront()` returns `true` for "could not confirm drained" — any failure, timeout, skip, absent capability, **or a `truncated` result**, because a row just past the re-read window can be a claim that expires after the window that read it. `truncated` there means the *boundary row is still a live claim*, **not** that the page filled: every queued job is also `status == 'processing'`, so `docs.length >= maxScan` would veto recovery permanently on any collection whose front window fills with ordinary finished jobs. Recovery stays reachable only when the re-read actually reports an empty prefix it fully covered.
- **The rotation cursor advances only for an accepted result.** A scan abandoned at `JOB_BACKLOG_PROBE_TIMEOUT_MS` still resolves and would move the shared cursor, skipping a window the service never folded into the cycle evidence — so the next sweep could close a cycle with a hole in it. `JobRepository` captures `_backlogScanEpoch` at scan start and commits the cursor only if it is unchanged, and the service calls `commitBacklogScan()` when it accepts a result.
- **`null` and absent are different in the queue projection.** `JobQueue.getStatus()` must default `durableQueuedCount` to `0` only when the field is *absent* (no backlog service ran). `?? 0` would collapse an explicit `null` — the deliberate "unknown depth" signal — into an apparently empty backlog published next to `durableProbeSucceeded: false`.
- `durableCycleComplete` is part of the **documented status contract** (`src/openapi/openapi.json` + both Postman success examples), so it must be projected through *both* `JobBacklogService.getStatus()` and `JobQueue.getStatus()`. Dropping it in either layer means the advertised field is never returned by `/api/status` or `/api/capabilities`.
- An **indeterminate durable probe is not evidence of recovery.** `getBacklogDepth()` returns `probeFailed: true` when it swallows a Firestore error, because a web replica's process-local map is empty and would otherwise read as a drained backlog. `probe()` folds that into `durableProbeSucceeded`; `_evaluateAlert` returns early on `false` so a storage blip cannot clear an active alert, emit a false all-clear, and then re-page. `oldestQueuedAgeMs === null` means *empty or unknown*, never *drained*.
- A timed-out probe is **abandoned, not cancelled**, so the underlying request may still be outstanding. `trackOutstanding()` keeps it registered until it genuinely settles, and the next sweep skips rather than stacking another call on it. Broker and durable probes use **separate** outstanding slots: a half-open broker connection must not blind the Firestore read, or backlog reporting and paging would stay dark for as long as the broker promise never settles.
- A **skipped** probe produced no result, so it stays indeterminate. The success assignment must stay *inside* the branch that actually returned data; letting it fall through to the zeroed default marks the skip as success and reads its `oldestQueuedAgeMs: null` as recovery. `isDurableResultConclusive()` encodes the two non-conclusive cases: `probeFailed`, and `truncated` with nothing observed — a scan that hit its page cap on actively leased documents can hide an aged backlog in the unscanned suffix, so `durableQueuedCount: 0` there is *unknown*, not empty. A truncated scan that *did* observe queued work is still conclusive evidence.
- Paging latches only after **confirmed delivery** (`{ success: false }` from Telegram is a failure). A failed page or failed all-clear is retried on the next probe rather than being marked delivered.
- Backlog pages are **admin notifications**, so delivery eligibility is `isAdminDeliveryEligible()`, not `isEnabled()`. An admin-only deployment with no `TELEGRAM_CHAT_ID` legitimately has the broadcast channel disabled.
- Each external probe is individually bounded (`JOB_BACKLOG_PROBE_TIMEOUT_MS`, default 10s) and timers are unref'd **at the rescheduling site**, so a half-open broker or stalled read cannot stop backlog reporting for the process lifetime and a rescheduled timer cannot hold the process open.
- `stop({ drain: true })` awaits the in-flight probe within the shutdown deadline; the plain `stop()` path only clears the timer.
- All probing and paging is **fail-open** — it must never block job intake or alert delivery.
- `backlogMonitorEnabled` / `backlogMonitorRunning` exist so a monitor switched off via `ENABLE_JOB_BACKLOG_MONITOR` is not read as a healthy empty queue.
- `firestore.indexes.json` requires `[status ASC, createdAt ASC]` on `tradingviewJobs`. Firestore does **not** merge single-field indexes for an equality filter plus a sort on a different field, so this composite is required.

**Configuration classification**: the three `JOB_BACKLOG_*` timing keys are **remote-config eligible** (non-secret runtime tuning, in `PARAMETER_SCHEMA` + `firebase-remote-config-template.json`). `JOB_BACKLOG_PROBE_TIMEOUT_MS` and `ENABLE_JOB_BACKLOG_MONITOR` are **environment-only** — a probe deadline and a process-startup gate.

**Coverage**: `tests/unit/job-backlog-service.test.js` (paging, cooldown, recovery, no false all-clear on probe failure, multi-window cycle accumulation, stale-window age re-evaluation, undatable-queued-work hold, front revalidation on cycle close and its failure mode, drained-collection recovery for both Firestore and memory-mirror paths, evidence survival across a mid-cycle outage, rotation cursor committed only for an accepted result, end-to-end recovery on a drained collection larger than the page cap through the real repository, `durableCycleComplete` projection, unref on reschedule, drain), `tests/unit/job-repository-claim.test.js` (bounded scan, truncation), `tests/unit/job-queue.test.js`, `tests/integration/status-endpoint.test.js` (asserts `durableScanRotated` / `durableCycleComplete` are surfaced under `dependencies.jobExecutionQueue`).

## Generic Message Delivery Storage (Issue #654)

Successful `POST /api/webhook/message` deliveries now reuse `AlertStorageService.saveAlert()` after the response is sent, using `source: webhook-message`. This keeps generic-message deliveries available to the existing alert audit, export, summary, and replay flows when `ENABLE_FIRESTORE_ALERT_STORAGE=true` while preserving fail-open delivery behavior, including unexpected storage promise rejections. Integration coverage verifies the persisted payload and rejection handling; the existing full suite remains green.

No environment variable, Remote Config key, endpoint, OpenAPI, or Postman contract changed.

## Generic Message Chunk Estimates and Dry Validation (GH-614)

`POST /api/webhook/message` exposes per-channel chunk estimation and dry-run validation support:
- `dryValidate: true` in the JSON request body validates the request and immediately returns `{ success: true, dryValidate: true, estimatedChunks: { telegram, whatsapp, discord } }` without initializing notification services or dispatching messages. Non-boolean `dryValidate` values return `400 Bad Request`.
- Normal dispatch requests exceeding single-chunk limits on any channel (WhatsApp > 20,000 chars, Discord > 2,000 chars) return additive metadata: `delivered`, `channelDetails`, and `estimatedChunks` alongside `results`. Single-chunk messages retain backwards compatibility returning `{ success: true, results }`.
- `estimateMessageChunks(text)` in `src/lib/messageHelper.js` provides centralized estimation logic.
- `tests/unit/message-helper.test.js` and `tests/integration/generic-message-webhook.test.js` cover chunk estimation, dry validation, invalid input, and additive response metadata.
- `src/openapi/openapi.json` and `CabrosBot.postman_collection.json` document `dryValidate` request/response schemas and examples.

## Generic Message Truncation Metadata (GH-602)

`POST /api/webhook/message` reports inbound truncation so callers can detect silent content loss:
- Inbound `message` values longer than `MAX_MESSAGE_LENGTH` (4,000 characters) are clipped before delivery and emit a `console.warn` line carrying only numeric `originalLength`, `deliveredLength`, and `max` values (no message content, so no injection surface).
- Truncated responses add `truncated: true`, `originalLength`, and `deliveredLength` alongside `results`. These fields are strictly additive and appear **only** when truncation occurred, so existing `{ success: true, results }` consumers are unaffected for messages that fit.
- Truncation metadata is independent of the GH-614 chunk-estimation metadata; both may appear on the same response when a long message also exceeds a channel's single-chunk limit.
- `tests/integration/generic-message-webhook.test.js` covers both branches: metadata omitted when the message fits, metadata present when it does not, and the matching `console.warn` behavior.
- `src/openapi/openapi.json` and `CabrosBot.postman_collection.json` document the conditional fields and both response shapes.


## Telegram Command Rate Limiting (Issue #658)

`index.js` installs `telegramCommandRateLimiter` before Telegraf command handlers. It applies process-local per-chat fixed-window limits to the expensive `/precio`, `/analisis`/`/analysis`, `/scanner`, and `/noticias`/`/news` commands, with bounded storage for 10,000 chat-command buckets. It defaults to 10 `/precio` calls per minute and 3 calls per hour for the other commands; `ENABLE_TELEGRAM_COMMAND_RATE_LIMITING=false` disables it, and `TELEGRAM_COMMAND_RATE_LIMITS_JSON` provides optional per-command `{max,windowMs}` overrides bounded to `max` 1-1000 and `windowMs` 1-86400000, with invalid values falling back to defaults. These are environment-only security controls and are intentionally excluded from Firebase Remote Config.

## Structured Webhook/API Error Envelope (CB-? / Issue #644)

`src/lib/errorEnvelope.js` introduces a shared builder that produces a standardized error response envelope for `/api/*` endpoints. Every error response now carries:

- `success: false` — always false on error paths
- `error` — human-readable message (preserves the existing field)
- `code` — machine-readable code (standardized set: `INVALID_REQUEST`, `FEATURE_DISABLED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `DELIVERY_FAILED`, `STORAGE_UNAVAILABLE`, `INTERNAL_ERROR`, with arbitrary uppercase codes preserved)
- `requestId` — request correlation UUID, generated when missing
- `retryable` — boolean driven by HTTP status code (5xx/429/408/425 = retryable, others = permanent); explicit override supported
- `details` — optional, only included when present and non-empty

The highest-traffic `/api/webhook/alert` endpoint's catch block (`NotificationRoutingValidationError` path + general error path) now emits this envelope. Upstream error envelopes are merged for `error`, `code`, and `details` so provider-specific contracts stay intact while the standardized fields are always present.

**Scope**: This change intentionally narrows to a single endpoint because `gigachad-senior-dev` flagged the original issue as "too large for a single automated pass" (`automation/skip` Score: 45/100, `Scope is too large for a single automated pass`). The helper is designed for incremental adoption — additional endpoints can adopt it in follow-up PRs without breaking existing behavior. HTTP status codes, fail-open patterns, and existing `code` semantics are preserved; the change is additive.

**Core Components**:
- `src/lib/errorEnvelope.js` — `buildErrorEnvelope()`, `sendError()`, `isRetryableStatus()`, `normalizeCode()`, `STANDARD_ERROR_CODES`.
- `src/controllers/webhooks/handlers/alert/alert.js` — Catch block emits standardized envelope; upstream `error.response` envelopes are merged for `error`/`code`/`details`.
- `src/openapi/openapi.json` — `Error` schema extended with `success`, `code`, `requestId`, `retryable`, `details` (additive, no breaking changes).
- `tests/unit/error-envelope.test.js` — 29 cases covering envelope shape, retryable inference, code normalization, request-id fallback, and Express response helper.

**Coverage**:
- `pnpm test -- tests/unit/error-envelope.test.js --testTimeout=5000`
- `pnpm test -- tests/unit/alert-handler.test.js --testTimeout=5000`
- `pnpm test -- tests/integration/alert-grounding.test.js --testTimeout=10000`

No environment variable, Remote Config key, endpoint, or feature flag was added. HTTP status codes and existing fail-open/fail-safe patterns are unchanged.

## Admin Binance Order-Status View (CB-278 / Issue #589)

The `/admin` console provides a dedicated read-only **Orders** view consuming `GET /api/trading/binance/orders` so operators can inspect Binance order status during incident response or after ambiguous submissions without exposing the `WEBHOOK_API_KEY` in shell history.

### Invariants & Implementation Details
- **Read-Only**: Only `GET /api/trading/binance/orders` is exposed. No order placement or cancellation write paths exist in this view.
- **Forms**:
  - `createOrderListForm()`: Queries recent orders by `symbol` (required, 5-20 uppercase chars) and optional bounded `limit` (1-100, default 50).
  - `createOrderLookupForm()`: Queries a single order by `symbol` and exactly one identifier: either numeric `orderId` (positive integer, leading zeros stripped) or `origClientOrderId` (validated against `^[A-Za-z0-9._:-]{1,36}$` both via HTML pattern/maxlength and submit validation).
- **Environment Rendering**: Uses `formatOrderEnvironment()` with defined badge tones: `testnet` renders `status-ready`, `live` renders `status-danger` (defined in `src/admin/admin.css` with warning color), and unknown/disabled renders `status-disabled`.
- **Request Invalidation & Safe Rendering**: Uses monotonic request versions (`listRequestVersion`, `lookupRequestVersion`) to prevent out-of-order stale responses from overwriting current view state. All values flow through DOM text nodes (`element()`, `createTimestamp()`) to prevent XSS.
- **Hosting Parity**: `src/admin/admin.js` is the source file; `public/admin/admin.js` is the built artifact copied via `pnpm run build:hosting` (or `node scripts/build-hosting.js`). Both must stay synchronized in commits.
- **Authentication**: Uses the existing session-stored API key or Firebase bearer token exclusively via request headers; never places keys in query params or URLs.

**Coverage**:
- `tests/unit/admin-client.test.js` covers recent orders list, single order lookup, identifier validation, DOM sanitization, request invalidation, and environment badges.

## Admin Console Chart Primitives (Issue #1288)

`src/admin/admin-charts.js` is the single SVG chart kit for the `/admin` console. It exports four render functions, each returning a DOM node: `sparkline(values, { label, formatValue, emptyText })`, `lineChart(series, { label, xKey, yKey, formatY, emptyText })`, `barChart(categories, { label, valueKey, formatValue, emptyText })`, and `donutChart(slices, { label, emptyText })`.

**This is the only chart system.** Analytics views build on it (see #1277 for the equity curve). Do not add a charting library or a second set of primitives.

### Invariants & Implementation Details
- **CSP-safe**: every node is built with `document.createElementNS` + `setAttribute`, and text via `textContent`. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, CDN, remote font, or external asset of any kind. A charting library cannot be added from a CDN under the helmet CSP in `app.js`, and vendoring one would reintroduce the supply-chain surface `vue.runtime.global.prod.js` already avoids.
- **Colours come only from CSS custom properties** in the `:root` block of `src/admin/admin.css`: `--chart-surface`, `--chart-grid`, `--chart-axis`, and `--chart-series-1` … `--chart-series-6`. No hex literal exists in the JS. Each `.chart-series-N` class sets `--chart-series-color`, so a series element carries both its role class (`chart-line`, `chart-point`, `chart-donut-slice`, `chart-legend-swatch`) and its palette class. **A class like `chart-line-chart-series-1` matches no rule and silently collapses every series onto series 1** — emit the palette class separately.
- **Accessibility contract**: every SVG carries `role="img"` plus an `aria-label` that states the finding in words (`Alerts per hour, from 13:00 to 16:00, 4 points. Alerts: high 31 at 14:00, low 9 at 15:00.`), not just the chart type. Chart text uses `--chart-axis` (5.78:1 on `--chart-surface`); the six series hues each measure ≥ 6.1:1, so any two stay distinguishable side by side. Recompute these ratios before recolouring a token.
- **Every chart ships an equivalent data table**, so the numbers are reachable without seeing the graphic and QA has something concrete to assert against. `lineChart`, `barChart` and `donutChart` use a `<details>` disclosure; `sparkline` uses a `visually-hidden` table because it lives inline in a KPI card.
- **`.visually-hidden` must never be applied to a `<table>`.** A `display: table` box resolves its used width to `max(specified, min-content)`, and the rule also sets `white-space: nowrap`, so `width: 1px` does not apply — a 375px-wide table positioned with `left/top: auto` and `offsetParent === BODY` (`.metric-card` is `position: static`, so nothing contains it) pushed past the right edge and grew `documentElement.scrollWidth` by 20px at a 375px viewport, giving the whole console a page-level horizontal scrollbar. The sparkline's table is therefore wrapped in a `<div class="visually-hidden">` holder. **The `left: -9999px; top: auto` on the class is a second, independent guard**, not redundancy: it makes the helper safe on any element regardless of its display type, because leftward overflow does not grow `scrollWidth` in LTR. Do not "clean up" that offset — `table-layout: fixed` and `display: block` were both tested and neither reduces a table's used width here.
- **Nothing paints outside the viewBox.** Every glyph is placed inside the 720-unit rectangle, which is what lets the containing scroller clip. The y-axis tick labels are therefore right-anchored at `pad.left - 8` rather than at `x: 0`; the earlier `x: 0` relied on `.chart-svg { overflow: visible }` painting into the figure padding and would have been clipped the moment the card got a scroll container.
- **Gutters are derived, never fixed.** `pad.left` and `pad.right` grow from an estimated text width (`textWidth()` = `length × fontSize × 0.6`, because SVG text has no measurable width before layout), with the previous hand-tuned values kept as *floors* so short-label charts render byte-identically to before. A category name longer than `MAX_CATEGORY_CHARS` is ellipsised on the graphic only — the data table and the `aria-label` keep the full string. `categoryGap` additionally reserves room for a **negative** bar's value label, which is painted to the *left* of the bar on the same baseline as the category name; with a fixed gutter those two overlap.
- **Legibility beats fitting.** `lineChart` and `barChart` hold a `min-width: 36rem` and sit in a `.chart-scroll` box with `min-width: 0` + `overflow-x: auto`, so a narrow viewport pans the card instead of scaling 11px viewBox text down to ~4px. **These two are panel-width visuals** — in a 240px KPI card you would pan most of the graphic. Use `sparkline` (no text) and `donutChart` (narrow viewBox, precise values in its HTML legend) inside metric cards. `min-width: 0` on `.chart-scroll` is load-bearing: a grid item defaults to `min-width: auto`, which would size the item to the graphic's floor and put the overflow back on the page. The scroller is keyboard-scrollable because browsers make overflowing scroll containers natively focusable — do not add a `tabindex` to it.
- **Edge cases never throw and never divide by zero.** A zero-range domain resolves to the scale midpoint (`scale()` short-circuits `max === min`); a flat line series gets a symmetric domain so it centres instead of pinning to an edge. Non-finite samples collapse to `null`, split polylines into separate runs, and render as `—` in the table. A bar or donut of all zeros renders a truthful zero-length bar / empty track rather than a fabricated full ring.
- **Domain honesty**: `barChart` anchors its domain on zero so negatives grow leftwards, and a zero category is a zero-length bar. `donutChart` excludes negative shares from the arc geometry but still lists them in the legend and table at `0.0%`.
- **Labels are never invented**: a bare number is a value under a positional `Category N` name, a bare string is a label with no magnitude (`—`), and only explicit `label`/`name` fields name an object. Falling back to the value field would print the bar's own magnitude as its heading.
- **Empty input returns the existing `.empty-state` element** with the caller-supplied `emptyText` (default `DEFAULT_EMPTY_TEXT`), never an empty `<svg>`.
- **Hosting parity**: `src/admin/admin-charts.js` is the source; `public/admin/admin-charts.js` is the build artifact from `pnpm run build:hosting`. Both are committed in sync, and the shell loads `/admin/admin-charts.js` with `defer` before `admin.js`.

**Coverage**: `tests/unit/admin-charts.test.js` — vm-based DOM harness covering all four chart types, empty / single-point / flat-range / negative / non-finite inputs, the `innerHTML`-forbidden sentinel, a source scan asserting no colour literals or remote URLs, the token contract, and source/build parity.

The harness has **no layout engine**, so it cannot catch a scrollbar or a paint that escapes its card. Those are enforced two ways instead: a `layout invariants` block asserts the structural contract (no `.visually-hidden` on a table, the class parks itself off-left, the scroller carries `min-width: 0`, the `rem` floor keeps 11px viewBox text ≥ 8px), and the overflow itself was measured in a real browser with `documentElement.scrollWidth === clientWidth` at 1440/1024/768/375/320 with a sparkline, a line, a bar and a donut mounted in both a KPI card and a panel. Re-verify in a browser after touching the gutters or the scroller.

## Multi-Agent Workflows
- **Senior Dev Engagement**: When acting as a trainee or assistant in PRs/Issues, actively respond to direct questions or mentions from @gigachad-senior-dev. Provide technical, inquisitive, or helpful responses.
- **Architectural Boundary (SOC)**: Separate Business Logic from Channel Presentation. Business Logic must produce stable, channel-neutral structured results. Channel Adapters handle the platform-specific formatting (Markdown, escaping, etc.).
- **Contract & Schema Parity**: Every endpoint, feature flag, or runtime configuration change must synchronize four checked-in surfaces: `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, `README.md`, and `.env.example`. Validate query integers with strict regex `/^\d+$/`, reject explicit `null` on closed enums with HTTP 400, and strictly separate single-value ingest parameters from multi-value filter parameters.
- **Remote Config 4-Way Parity**: Remote-Config-eligible, non-secret runtime configuration variables must maintain atomic 4-way parity across `.env.example`, `RemoteConfigService.js` / Firebase template (`firebase-remote-config-template.json`), `README.md` parameter tables (with exact parameter keys, descriptions, types, and fallback defaults), and `AGENTS.md`. Secrets, authentication controls, delivery destinations, and startup-only gates must remain environment-only and never be added to Remote Config.
- **Postman Variant Completeness**: Every API endpoint and query parameter must include checked-in, runnable Postman examples with executable test script assertions (`pm.test` verifying HTTP status codes and standardized error envelopes) covering both success and invalid/negative variants (e.g. 400 `INVALID_REQUEST` validation errors for invalid limit, status, window, malformed timestamps, or reversed ranges, plus auth failures and conflict states).
- **Standardized Error Envelopes**: All error responses must adhere to `{ success: false, error: "<msg>", code: "<CODE>", requestId, retryable }` via `src/lib/errorEnvelope.js`. Never throw plain `Error` for client validation errors; use `INVALID_REQUEST` (HTTP 400) and `MAINTENANCE_MODE` (HTTP 503).
- **Replay Payload Preservation**: Alert and signal replay flows (`/api/alerts/:id/replay`) must start from the complete stored raw input payload and overlay replay/routing metadata, preserving all top-level attributes and metadata (such as `signalClass`) without field-cherry-picking, destructive filtering, or schema loss.

## 🎓 Trainee Learning Loop (virgin-trainee-dev)

The `virgin-trainee-dev` is in active training. To ensure it evolves and doesn't repeat mistakes:

- **Mandatory Logging**: Whenever `virgin-trainee-dev` receives a correction, negative feedback, or a "No" from @francovp or @gigachad-senior-dev, it **MUST** immediately use the `self-improvement` skill.
- **Target**: Log the event as a `correction` or `knowledge_gap` in `.learnings/LEARNINGS.md`.
- **Goal**: Convert human feedback into durable prompt guidance to stop asking the same "trainee" questions and improve technical output.
- **Automated Pre-Comment Inspection**: Before posting comments on PRs or issues (in automated cron or manual runs), verify existing thread comments via GitHub API (`issues/{id}/comments` and `reviewThreads`) to prevent duplicate comments on the same item across runs. If `virgin-trainee-dev[bot]` or maintainers have already addressed the topic, default to silence (`HEARTBEAT_OK`).
- **Automated Duplicate/Superseded PR Check**: Before processing or commenting on a PR, inspect cross-references and titles/labels for "duplicate of" or "superseded by" markers (e.g. PR #1167 superseded by #1176); direct engagement strictly to the canonical PR.
- **Direct Senior Dev Engagement**: When @gigachad-senior-dev asks specific technical questions on PRs, answer them directly with technical precision and architectural rationale rather than generic acknowledgments or repeated question loops.
- **Clean Worktree Verification**: Automated testing or build validation routines executed by trainee/assistant workflows must leave no unstaged or staged mutations (`git status --porcelain` clean).

## Global HTTP Request Timeouts (Issue #609)

The HTTP server applies bounded Node.js timeouts at startup: 10 seconds for headers, 120 seconds for complete requests, and 30 seconds for keep-alive connections. Node enforces `headersTimeout` only when its periodic connection checker fires, so `connectionsCheckingInterval` is also fixed at 5 seconds — with Node's default 30s interval the nominal 10-second header bound is not applied until ~30 seconds. The sweep is aligned to server start, not to each connection, so a connection beginning just after a sweep is first observed on the next one: the **worst-case** slow-header lifetime is `headersTimeout + connectionsCheckingInterval` = **15 seconds**, not exactly 10 (measured 10.9s / 12.9s / 15.0s by sweep phase; `MAX_SLOW_HEADER_LIFETIME_MS` is exported and asserted by the test). Lowering the interval to 1s would tighten this to ~11s at the cost of waking the checker every second for the process lifetime; a hard per-connection deadline would need socket-level timers. `src/lib/serverTimeouts.js` owns the fixed values and `tests/unit/server-timeouts.test.js` verifies the configuration. No new environment variable, endpoint, OpenAPI, Postman, or Remote Config change was required. These transport-level bounds are complementary to the per-request application deadline in `src/lib/requestDeadline.js` (GH-693): the deadline middleware returns a structured `408` per `/api` route, while these server timeouts bound slow or idle clients across all routes (including `/healthcheck` and static assets that the deadline exempts).

## Per-Symbol Alert Notification Routing (Issue #627)

`POST /api/webhook/alert` accepts optional `symbolRoutes`: an object whose keys are bare symbols (`BTCUSDT`) or exchange-qualified keys (`NASDAQ:NVDA`), each mapping to a non-empty channel array. Delivery results include the matched `symbol`. Without `symbolRoutes`, the existing broadcast and request-level routing path is unchanged.

**Extraction is route-key driven, not heuristic.** `resolveSymbolRouteDispatches()` only produces a dispatch for a symbol that actually appears as a configured `symbolRoutes` key, matched case-insensitively with word boundaries. This is deliberate: an earlier version treated nearly every uppercase token as a symbol, so `BINANCE:BTCUSDT RSI OVERBOUGHT` was read as three symbols. `RSI` and `OVERBOUGHT` then fell back to the request-level channels or a broadcast, and the same alert was delivered up to three times. Unmatched tokens now produce no dispatch at all. Exchange-qualified keys are matched as a unit; bare keys are matched standalone, so `BINANCE:BTCUSDT` still routes to a `BTCUSDT` key. Digit-initial symbols accepted by the route-key validator (e.g. `1INCHUSDT`) are matched too, and the reported `symbol` is always the bare form (`NVDA`) even for a `NASDAQ:NVDA` key.

**Repeat suppression narrows symbol routes too.** When `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION` narrows the request-level channel set, every `symbolRoutes` entry is intersected with that same set before dispatch. Without this, a route's own channel list resurrects a channel that is still cooling down and defeats the per-(channel, destination) suppression guarantee.

**Coverage**:
- `src/services/notification/requestRouting.js` — route-key validation, route-key-driven dispatch extraction, and per-symbol routing.
- `src/controllers/webhooks/handlers/alert/alert.js` — passes alert text for effective requested channels and narrows `symbolRoutes` on repeat suppression.
- `tests/unit/request-routing.test.js` — validation, exchange-qualified and digit-initial matching, indicator-word rejection, and no-match-returns-null.
- `tests/integration/alert-repeat-suppression.test.js` — symbol routes narrowed to the surviving channels (verified to fail without the fix).
- `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, and `README.md` — request/response contract and valid/invalid examples.

No new environment variable, startup gate, destination, secret, or Remote Config key was introduced.

## Market Scanner MCP Circuit-Breaker Fast-Fail Gate (Issue #632)

`POST /api/webhook/market-scanner-alert` consults the process-local TradingView MCP status before starting its sequential scans. `getMcpUnavailableReason()` in `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` returns a skip reason only when **all** of these hold:

1. `tradingViewMcpService.getStatus({ enabled: true })` reports `status === 'degraded'`;
2. `lastErrorCategory` is one of `http_5xx`, `request_failed`, `circuit_breaker_open`;
3. `circuitBreaker.state === 'open'` — the time-based breaker state, **not** the sticky runtime status.

Only then does the endpoint return `502 TRADINGVIEW_MCP_UNAVAILABLE` with every requested scan as `status: 'skipped'` plus a `reason`, without attempting any scanner call.

**Why the gate keys on the breaker state (Codex P1 on the original PR).** `runtimeStatus.status === 'degraded'` is cleared only by a *later successful* MCP call. Gating on it therefore skips the very probe that would clear it, so in a scanner-only process the scanner would return 502 forever — a self-locking outage that could never self-heal without a restart. `getCircuitBreakerStatus().state` is time-based: `getBreakerState()` flips `open` → `half-open` once `TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS` elapses, so the first request after the cooldown proceeds and acts as the bounded recovery probe. Verified empirically: after one transient failure the old gate still skipped post-cooldown, while the new gate allows the probe and the service returns to `ready`/`closed` after it succeeds.

**Fail-open paths** (must never block the scanner): readiness-lookup throwing, a `degraded` state with no reported breaker state, degraded categories outside the provider-outcome set such as `http_4xx`, and any non-`degraded` status.

**502 has two documented shapes** (Codex P2). `TRADINGVIEW_MCP_UNAVAILABLE` is the skip path (nothing attempted); `ALL_SCANS_FAILED` is the attempt path (every scan was attempted and failed). Both are enumerated under `components.responses.MarketScannerBadGateway` in `src/openapi/openapi.json`, in `CabrosBot.postman_collection.json`, and in `docs/webhooks.md`.

**Coverage:** `tests/unit/market-scanner.test.js` covers fail-fast while open, the half-open recovery probe, unknown-breaker fail-open, and the non-outage category; `tests/integration/market-scanner-endpoint.test.js` covers the endpoint-level 502 skip, the transient-failure self-recovery round trip, the `ALL_SCANS_FAILED` attempt path, and the two-variant OpenAPI 502 contract. No new environment variable, Remote Config key, or feature flag was added.

## Persisted Gemini-Grounding Entry Price (GH-599 / Issue #599)

Alert-enrichment now persists an optional numeric `current_price` (with optional `price_currency`) sourced from grounded snippets, propagates it through `AlertStorageService`, and uses it both as a deterministic entry-price fallback for `SignalOutcomeService.recordSignal()` and as the basis for a deterministic `risk_reward_ratio` recompute. The goal: 37/37 enriched alerts that previously had `risk_reward_ratio: 0%` and landed in `missing_entry_price` for BINANCE now become gradeable whenever grounding returns a price.

**Core Components**:
- `src/services/prompts/defaults/alert-enrichment.user.txt` — adds `current_price` (number, optional, `>0`) and `price_currency` (ISO-4217 string, optional) fields plus an "Entry price context" rubric that explicitly tells the model to omit the field when no snippet is available (omission is the preferred and correct output).
- `src/services/prompts/PromptService.js` — `REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS` is unchanged; the new fields are intentionally **excluded** from `inspectAlertEnrichmentRiskSchema()` so legacy Langfuse prompts that pre-date the change MUST NOT be flagged as drift. The prompt text now ships the markers, so newly synced prompts will start including them.
- `src/services/grounding/gemini.js` — `parseOptionalCurrentPrice()` accepts finite positive numbers and clean numeric strings (`"3240.51"` → `3240.51`); rejects `0`, negatives, `NaN`, `Infinity`, booleans, and unparseable strings. `parseOptionalPriceCurrency()` normalizes the 2-5 letter ISO-4217-style code and drops invalid values without dropping the underlying `current_price`. `price_currency` is dropped entirely when `current_price` is absent.
- `src/services/storage/AlertStorageService.js`:
  - `sanitizeEnrichmentData()` now also strips invalid `current_price` / `price_currency` (same drop rules as the parser) so a stray bad value can never reach Firestore.
  - `applyDeterministicRiskReward(enrichmentData, side)` computes `(target-entry)/(entry-invalidation)` for `BUY` and `(entry-target)/(invalidation-entry)` for `SELL` when entry/invalidation/target are all finite positives and `risk_reward_ratio` is missing or invalid. Positive numeric and non-empty string model ratios are preserved; the new `risk_reward_ratio_source: "computed"` field only appears when the service filled the value in.
  - `formatAlertDocument()` and `formatExportRecord()` surface top-level `currentPrice` / `priceCurrency` mirrors so list/detail/export reads can address the field without diving into `enrichmentData`.
  - `saveAlert()` accepts a `side` parameter (parsed from `parseTradingViewSignal`) so deterministic R:R math knows the trade direction.
- `src/controllers/webhooks/handlers/alert/grounding.js` — propagates Gemini entry price and currency through both adapters, preserving the MCP price when present and using `priceSource: 'gemini-grounding'` otherwise. Price provenance is independent of risk-level provenance.
- `src/controllers/webhooks/handlers/alert/alert.js` — passes parsed signal `side` to persistence for deterministic R:R. The existing outcome price resolver consumes the adapter's explicit price provenance and preserves Binance/Twelve Data derived-quote attribution.
- `src/services/storage/SignalOutcomeService.js` — unchanged at the type level; the existing `entryPriceSource` field and `entryPriceSourceBreakdown` aggregation automatically pick up the new `'gemini-grounding'` bucket as soon as `recordSignal()` propagates it.

**Configuration**:
- No new environment variable. No Remote Config key. No new endpoint. No new feature flag. The change is purely additive and gated by the existing `ENABLE_GEMINI_GROUNDING` flag; when grounding is disabled the new fields never appear.

**Where to look first when extending or debugging**:
- `src/services/prompts/defaults/alert-enrichment.user.txt` for the schema/rubric.
- `src/services/grounding/gemini.js` (`parseOptionalCurrentPrice`, `parseOptionalPriceCurrency`) for parser validation.
- `src/services/storage/AlertStorageService.js` (`sanitizeEnrichmentData`, `applyDeterministicRiskReward`, `formatAlertDocument`, `formatExportRecord`) for the persistence contract.
- `src/controllers/webhooks/handlers/alert/grounding.js` for price propagation; `alert.js` for outcome provenance and persistence-side wiring.
- `tests/unit/gemini-client.test.js` (`current_price and price_currency parsing (GH-599)`), `tests/unit/alert-storage-service.test.js` (`current_price, price_currency, and deterministic R:R (GH-599)` + `current_price read fields (GH-599)`), `tests/unit/alert-webhook-request-id.test.js` (`GH-599 Gemini-grounding entry-price fallback for recordSignal`), and `tests/unit/prompt-service.test.js` (`GH-599: does NOT mark alert-enrichment prompt as drift when only current_price / price_currency are missing`) for coverage.

**Coverage**:
- `pnpm test -- tests/unit/gemini-client.test.js`
- `pnpm test -- tests/unit/alert-storage-service.test.js`
- `pnpm test -- tests/unit/alert-handler.test.js`
- `pnpm test -- tests/unit/alert-webhook-request-id.test.js`
- `pnpm test -- tests/unit/prompt-service.test.js`

**Validation plan (per issue #599)**:
1. Unit tests cover: prompt schema fixture with `current_price`; parser rejection of `0`, negative, `NaN`, strings; persistence propagation (`sanitizeEnrichmentData`, `applyDeterministicRiskReward`, read-API mirrors); signal-outcome fallback path; deterministic R:R math; `entryPriceSourceBreakdown` shape (verified by reading `entryPriceSource` field as a generic string and observing the new `'gemini-grounding'` bucket at the contract level — the existing `SignalOutcomeService` aggregation is unchanged).
2. Production observation window (post-deploy): compare `riskMetadataCoverage.risk_reward_ratio.percentage` before/after (baseline 0%) and `eligibilityBreakdown.missing_entry_price` (baseline 10/38).

**Rollout check**:
- Pre-deploy: ensure the deployed Langfuse `alert-enrichment` prompt is synced to a version that includes the `current_price` and `price_currency` markers. Legacy prompts continue to work — `parseOptionalCurrentPrice` returns `undefined` when the field is absent and the rest of the pipeline is unchanged.
- Post-deploy: confirm `GET /api/status` reports `geminiGrounding` ready, then observe `enrichment.riskMetadataCoverage.risk_reward_ratio.percentage` rise from baseline 0% toward the projected ceiling, and `entryPriceSourceBreakdown.gemini-grounding` start appearing in `GET /api/outcomes/summary`.

No endpoint, environment variable, or Remote Config key was added. OpenAPI, Postman examples, list/detail mirrors, and JSONL/CSV exports include the additive price fields.
## Stored-Alert Read Health and the `__name__` Descending Composite Index (Issue #1285)

`GET /api/alerts`, `/api/alerts/summary`, `/api/alerts/export`, and replay all answer `503 STORAGE_UNAVAILABLE` when Firestore rejects the **query**, even though every write succeeds. This is the second time this repository has been bitten by the same Firestore indexing rule (the first was `userPriceAlertService`'s sweep), so the rule is now recorded here as a hard constraint.

- **The invariant.** Every Firestore query that adds `.orderBy(admin.firestore.FieldPath.documentId(), <dir>)` **on top of another `orderBy` requires a composite index in `firestore.indexes.json` for that field pair.** Firestore applies a *free* final sort on `__name__` in the **ascending** direction only, and it never merges single-field indexes. Ordering `__name__` **descending** therefore needs an explicit composite. The `alerts` reads order by `receivedAt DESC, __name__ DESC` and need `alerts { receivedAt DESC, __name__ DESC }`; the unit Firestore double makes `orderBy` a no-op and the Firestore emulator auto-creates indexes, so **neither the unit suite nor `pnpm test:firebase` can catch a missing index.** The only guard is an explicit declaration assertion (the pattern at `tests/unit/alert-storage-service.test.js` "declares the composite Firestore index required by the ordered alerts read"). **Any new `orderBy(FieldPath.documentId(), ...)` must add its index declaration and its assertion in the same PR.**
- **A declaration is not a deployment.** `firestore.indexes.json` is the repository template of record only; it does not create the index in the live project. `firebase deploy --only firestore:indexes` is required, indexes build asynchronously, and a query is rejected until the build reaches `READY`. So a merged fix does not by itself restore service — the deploy is an explicit follow-up step.
- **Read health is separate from write health.** `dependencies.firestore.ready` was derived only from `enabled && configured`, and `configured` validates credential *shape*. A deployment could therefore report `ready: true` while 100% of reads failed. `FirestoreWriteMetricsService` now keeps an independent read counter set (`getReadSnapshot()` → `dependencies.firestoreReadMetrics`), and `readHealth` drives the verdict: `unknown` (no read observed yet — **no evidence, not health**) leaves `ready` alone, `healthy` leaves it alone, and `degraded` forces `ready: false` / `status: "degraded"`. Read health clears on the first successful read, with no restart. **Adding a read path means recording it through `recordReadSuccess`/`recordReadFailure`, or the outage stays invisible.**
- **`/ready` must exercise the real query shape.** The Firestore readiness probe used `listCollections()`, a metadata call that never runs a collection query, so it could not observe this class of fault. It now runs `AlertStorageService.probeOrderedAlertRead()` — the exact indexed query bounded to one document, routed through `recordReadFailure` so a probe-detected fault also feeds `readHealth` and carries its category into the `/ready` payload. **A readiness probe must issue the operation whose availability it is asserting, not a cheaper proxy for it.**
- **Messages must name the failing subsystem.** `createStorageUnavailableError` previously emitted one fixed "Check Firestore credentials and project configuration" for every failure, which actively misdirected operators toward credentials that were demonstrably working. The credential hint is now reserved for `isConfigurationErrorCategory` categories (`uninitialized`, `unauthenticated`); a rejected query reports its own sanitized category from the closed enum in `src/services/storage/firestoreErrorCategories.js` plus `missingIndex: true`. The enum and the provider message are kept separate because **Firestore embeds the fully-qualified project/database path and the index definition in its message** — it is logged, never returned in a response body or a status payload.
- **Coverage**: `tests/unit/firestore-error-categories.test.js`, the read-metric block in `tests/unit/firestore-write-metrics-service.test.js`, the `#1285` blocks in `tests/unit/alert-storage-service.test.js` / `tests/integration/status-endpoint.test.js` / `tests/integration/healthcheck-readiness.test.js` / `tests/integration/alerts-endpoint.test.js`, and the two new Postman assertions in `tests/unit/postman-collection.test.js`. Docs: `docs/troubleshooting.md` runbook, `docs/api-reference.md` read-health section, `docs/alerts.md` index requirement.

No environment variable or Remote Config key was added. `FirestoreWriteMetricsService.js` remains space-indented to match its own existing style (75 pre-existing `indent` findings, lint is `continue-on-error`); it was not reformatted to keep this diff readable.

## Preview Verification Binds SHA to the Selected Deployment (Issue #1129)

The `issue-automator` merge gate could bless a stale build. `get-pr-deployment-url.sh` walks deployments newest-first and returns the first `success`/`active` status, so a still-`pending` newest deployment was **skipped** in favour of the previous successful one — while `verify-preview.sh` validated `EXPECTED_SHA` against `deployments?...&per_page=1`, i.e. the newest record it had just skipped. The SHA check therefore passed on the pending commit and the health checks ran against an older URL.

**The URL and the commit it is checked against now come from one record.** `get-pr-deployment-url.sh --details` emits a single line of JSON — `{"url":…,"sha":…,"state":…,"deployment_id":…,"source":…}` — where `sha`/`state` are read from the *same* deployment whose status supplied `url`, and `source` is `production`, `github-deployment`, or `railway-fallback`. Both fields are empty when no GitHub deployment was selected. The default (flagless) stdout contract is unchanged: still the bare URL.

`verify-preview.sh` resolves the URL through `--details` and runs two independent checks when `EXPECTED_SHA` is supplied, either mismatch exiting `2` (the pre-existing "stale deploy" code that routes to Step 6.5):
1. **Bound-record check** — `EXPECTED_SHA` vs. the `sha` of the deployment that produced the probed URL.
2. **Served-build check** — `EXPECTED_SHA` vs. `service.commit` from `${PREVIEW_URL}/api/status`, the commit the running service reports for itself.

Both checks are needed and neither substitutes for the other: the record does not prove the URL serves it, and the served build does not prove which deployment the URL was selected from. The served-build check is the only available evidence on the Railway-pattern fallback path, where no GitHub deployment exists. It is **fail-open on missing evidence, fail-closed on proven mismatch** — an absent `WEBHOOK_API_KEY`, an auth-gated/unreachable `/api/status`, or a payload without `service.commit` warns and defers to the bound-record result rather than failing the gate.

`WEBHOOK_API_KEY` is read from the environment and sent as the `x-api-key` header only — never in a URL, query string, or printed line (same pattern as `ops/production-smoke-probe.sh`). Retry pacing is tunable through `VERIFY_PREVIEW_MAX_ATTEMPTS` (default `3`) and `VERIFY_PREVIEW_RETRY_DELAY_SECONDS` (default `5`); both defaults are unchanged.

**The served-build probe is the one place this repo's tooling sends an `ADMIN_OPERATOR` credential, so it is host-restricted.** `WEBHOOK_API_KEY` is accepted by `validateAdminAccess` as `ADMIN_OPERATOR` (`src/lib/adminAuth.js`), which authorizes `POST`/`DELETE /trading/binance/orders` and alert replay (`src/routes/index.js`) — a trading-capable secret. Its destination, `PREVIEW_URL`, comes from a deployment status `environment_url`, which the deployment integration supplies and therefore cannot be trusted. Four invariants, all enforced in `resolve_credential_target()` before the curl:

- **`https:` only.** A `http://` preview URL means the header would cross the wire in cleartext, so the check is skipped with a warning.
- **Allowlisted host only.** The default list is the platforms this repo deploys to — `openclaw.tail5e4271.ts.net`, `*.onrender.com`, `*.up.railway.app`. Wildcards match on a **label boundary** (`*.${suffix}`), so `evil-up.railway.app` does not satisfy `*.up.railway.app` and `up.railway.app.attacker.test` does not either. `VERIFY_PREVIEW_ALLOWED_HOSTS` replaces the list for a preview on another host, so an operator never edits the script.
- **One positive character class for the whole URL**, so userinfo (`@`), query/fragment (`?#`), whitespace and backslashes are rejected rather than leniently parsed. `https://cabros-bot-production.up.railway.app@attacker.test` has an allowlisted host *in the userinfo* while curl connects to `attacker.test`; a substring check would have passed it.
- **No `-L`, and `-g`.** Not following redirects is what stops the header being forwarded off-host, and `--globoff` stops curl expanding a `{a,b}` in a hostile path into two header-carrying requests.

Every rejection is a **warning and `return 1`**, not an exit code: the check is already fail-open on missing evidence, and a preview on an unknown host must still be health-verified — it simply loses the served-build evidence, leaving the bound-record check as the gate. Do not "fix" this by reordering so the key is sent first and validated later; do not add `-L`; and do not widen the default list without naming the platform being added.

**Coverage**: `tests/unit/verify-preview-deployment-binding.test.js` drives both scripts against fake `gh`/`curl` binaries. It reproduces the reported scenario (newest `pending` + previous `success`) and asserts exit `2` when the selected URL is not serving `EXPECTED_SHA`, plus the served-build mismatch, the short-SHA prefix match, every unprovable-evidence warning, the Railway fallback, and API-key non-leakage. The `gh` stub answers three distinct `--jq` projections so the legacy code path is reproduced faithfully rather than accidentally passing. A dedicated block drives a hostile `environment_url` — plain HTTP, a non-allowlisted HTTPS host, prefix/suffix-confusable hosts, userinfo smuggling, and glob metacharacters — asserting exit `0` with `served-commit check skipped`, `/api/status` never requested, and **no `x-api-key` in the curl invocation log**; it also asserts the operator override works and that the three real platform hosts still receive the key. Each case also returns a *matching* `service.commit`, so a regression that leaked the key would still print `Served-build match` and could only be caught by the invocation-log assertion.

No endpoint, OpenAPI, Postman, environment variable, Remote Config key, or feature flag was added; `agents.md` and `AGENTS.md` are the same file. `VERIFY_PREVIEW_ALLOWED_HOSTS` is an operator-facing shell variable read by agent tooling, not an application environment variable, so `.env.example` / Remote Config parity does not apply.

## Shared Alert Validation Truncation (Issue #637)

`validateAlert()` keeps the existing 4,000-character cap but now returns `truncated`, `originalLength`, and `deliveredLength` when clipping input. `/api/webhook/alert` propagates those fields in its 200 response and emits a structured warning, allowing callers to detect content loss without changing delivery or enrichment gates. No environment variable, Linear issue, or Remote Config key was added.

The truncation fields are attached only to the `/api/webhook/alert` response. They are **not** part of the shared `DeliveryResult` schema, because `DeliveryResult` is also referenced by `POST /api/alerts/{alertId}/replay`, whose `replayAlert` response never includes them; `/api/webhook/alert` therefore documents an endpoint-specific schema and example.

**Coverage**:
- `tests/unit/validation.test.js` — Boundary, no-truncation, and truncation-with-signalClass metadata behavior.
- `tests/unit/alert-webhook-request-id.test.js` and `tests/integration/alert-grounding.test.js` — Response propagation through dry-run and the mounted webhook.
