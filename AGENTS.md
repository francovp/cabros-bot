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

### Key Files & Entry Points
- `index.js` — App entry. Starts Express server and conditionally launches the Telegraf bot. Important logic for enabling the bot lives here.
- `instrument.js` — Initializes Sentry logging + monitoring early (loaded by `index.js`).
- `app.js` — Express app configuration (body parsing, CORS, helmet, healthcheck route).
- `src/routes/index.js` — Registers HTTP API routes (mounted under `/api`; endpoints are feature-gated at runtime).
- `src/controllers/commands.js` — Telegram command handlers wired in `index.js` (`/precio`, `/cryptobot`, `/jobs`).
- `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js` — Price lookup resolver routing crypto to Binance and equities/stocks to Twelve Data (`EquityMarketDataService`).
- `src/controllers/trading/binanceOrders.js` — Operator-only `POST /api/trading/binance/orders`, `GET /api/trading/binance/orders`, and `DELETE /api/trading/binance/orders` controllers.
- `src/controllers/webhooks/handlers/alert/alert.js` — Webhook handler that forwards alert text to a Telegram chat.
- `src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js` — `POST /api/webhook/expanded-analysis-alert` handler that builds TradingView MCP analysis reports and sends them through notification channels.
- `src/controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation.js` — `POST /api/webhook/volume-confirmation` handler that returns structured TradingView MCP volume-confirmation data.
- `src/controllers/webhooks/handlers/jobs/jobs.js` — Job creation (`POST /api/jobs/tradingview-analysis`), listing (`GET /api/jobs`), and status polling (`GET /api/jobs/:jobId`) handlers.
- `src/services/notification/requestRouting.js` — Shared optional channel-routing validator/dispatcher for alert-producing routes (`channels`, `telegramChatId`, `whatsappChatId`) that preserves legacy broadcast behavior when `channels` is omitted.
- `src/controllers/alerts/alerts.js` — Stored alert read, export, analytics, and replay handlers for `GET /api/alerts`, `GET /api/alerts/export`, `GET /api/alerts/summary`, `GET /api/alerts/:alertId`, and `POST /api/alerts/:alertId/replay`.
- `src/controllers/status.js` — Status handler that computes capabilities, feature flags, notification channels, and active dependencies status.
- `src/services/storage/SignalOutcomeService.js` — Records and evaluates signal outcomes, schedules the role-gated evaluator, and persists safe worker heartbeats.
- `src/controllers/outcomes/outcomes.js` — Signal outcome query and summary handlers for `GET /api/outcomes` and `GET /api/outcomes/summary`.
- `src/controllers/pretradeCheck/pretradeCheck.js` — Pre-trade decision-support composer that aggregates current price (Binance / Twelve Data) and a recent (7d) hit-rate from `signalOutcomeService.listOutcomes()` into a single fail-open snapshot, exposed via `GET /api/pretrade-check` and the `/check` Telegram command.
- `src/workers/signalOutcomeWorker.js` — Dedicated Render worker bootstrap with SIGTERM drain handling.
- `src/lib/adminAuth.js` — Opt-in Firebase ID-token verification and `admin.viewer`/`admin.operator` authorization for browser admin workflows; legacy API keys remain supported.
- `src/lib/telegramErrorBoundary.js` — Telegraf global update error boundary (`bot.catch`), polling error rate-limiting supervisor, Sentry reporting, and fail-open admin notifications.
- `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` — Scanner webhook handler executing sequential gainers, losers, and breakouts scanner runs on TradingView MCP.
- `src/services/jobs/JobService.js` — Manages job state, executes background TradingView analysis runs, and performs periodic expiration cleanup.
- `src/services/jobs/JobQueue.js` / `src/services/jobs/jobWorker.js` — BullMQ producer/worker integration for the optional Render worker execution mode.
- `worker.js` — Dedicated Render worker entry point with graceful BullMQ shutdown.
- `src/services/tradingview/expandedAnalysisAlertReport.js` — Parses `EXCHANGE:SYMBOL` requests and formats grouped Spanish technical-analysis reports.
- `src/services/monitoring/SentryService.js` — Wraps `@sentry/node` for runtime error and external failure monitoring with tag enrichment (endpoint, provider, status_code, trace_id), automatic PII sanitization, and actionable 500 error grouping.
- `src/lib/processLifecycle.js` — Coordinates bounded HTTP/process shutdown and cleanup of runtime resources.
- `src/services/prompts/` — Langfuse-backed PromptService that resolves prompts with file-backed local defaults.
- `src/controllers/helpers.js` — Small numeric helper (`round10`) used by price formatting.
- `src/lib/logging.js` — Configures `console.*` levels via `LOG_LEVEL` and emits one-line structured JSON logs with multi-layer secret redaction (sensitive object keys, URL query secrets, JSON string secrets, key-value scalar patterns, Authorization headers, Bearer tokens, Telegram bot tokens, Discord webhook tokens, OpenAI keys, and request-scoped `registerSecretValue` / `clearSecretValue` registry helpers).
- `src/lib/rateLimiter.js` — Global API rate limiting middleware (returns 429 when exceeded; configured via `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`, with safe defaults for invalid values). Core alert/message webhook ingest uses a separate finite 1,000-request bucket per IP and window.
- `src/lib/cors.js` — Express CORS middleware configuring explicit origin allowlists (`https://cabros-bot.web.app`, `https://cabros-bot.firebaseapp.com`, `https://cabros-bot-production.up.railway.app`, `http://localhost:*`, and `CORS_ALLOWED_ORIGINS`).
- `src/openapi/openapi.json` — Canonical OpenAPI 3.1 contract for every mounted `/api` operation.
- `src/openapi/docs.js` — Public, read-only `/openapi.json` and self-hosted Swagger UI `/docs` routes.

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
- Optional but relevant (non-exhaustive; see feature sections below for full config): `ENABLE_TELEGRAM_BOT`, `PORT`, `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ROUTES`, `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID`, `ENABLE_WHATSAPP_ALERTS`, `ENABLE_DISCORD_ALERTS`, `ENABLE_NOTIFICATION_REDRIVE`, `NOTIFICATION_REDRIVE_WORKER_ROLE`, `NOTIFICATION_REDRIVE_INTERVAL_MS`, `NOTIFICATION_REDRIVE_BATCH_LIMIT`, `NOTIFICATION_REDRIVE_MAX_ATTEMPTS`, `NOTIFICATION_REDRIVE_MAX_AGE_MS`, `ZERO_CHANNEL_ALERT_COOLDOWN_MS`, `ENABLE_API_ONLY_MODE`, `ENABLE_GEMINI_GROUNDING`, `GEMINI_API_KEY`, `ENABLE_LANGFUSE_PROMPTS`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_PROMPT_LABEL`, `LANGFUSE_PROMPT_CACHE_TTL_SECONDS`, `BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_ENDPOINT`, `FORCE_BRAVE_SEARCH`, `MODEL_PROVIDER`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `ENABLE_NEWS_MONITOR`, `EXPANDED_ANALYSIS_ALERT_SYMBOLS`, `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS`, `TRADINGVIEW_MCP_URL`, `TRADINGVIEW_MCP_TIMEOUT_MS`, `TRADINGVIEW_MCP_MAX_RETRIES`, `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME`, `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION`, `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT`, `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME`, `ENABLE_ALERT_HTF_RENDER`, `ENABLE_SENTRY`, `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_PROFILE_SESSION_SAMPLE_RATE`, `SENTRY_CONSOLE_LOG_LEVELS`, `ENABLE_SENTRY_DEBUG_ROUTE`, `LOG_LEVEL`, `SERVICE_NAME`, `TRUST_PROXY`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `ENABLE_FIRESTORE_ALERT_STORAGE`, `ENABLE_FIRESTORE_SCANNER_PRESETS`, `ENABLE_FIRESTORE_IDEMPOTENCY`, `ENABLE_SIGNAL_OUTCOME_TRACKING`, `ENABLE_EQUITY_MARKET_DATA`, `EQUITY_MARKET_DATA_PROVIDER`, `TWELVE_DATA_API_KEY`, `TWELVE_DATA_BASE_URL`, `EQUITY_MARKET_DATA_TIMEOUT_MS`, `EQUITY_MARKET_DATA_RPM`, `TWELVE_DATA_RPM`, `SIGNAL_OUTCOME_WORKER_ROLE`, `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS`, `SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT`, `SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS`, `SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS`, `SIGNAL_OUTCOME_MAX_RETRY_AGE_MS`, `SIGNAL_OUTCOME_RETENTION_DAYS`, `ENABLE_MARKET_SCANNER`, `ENABLE_MESSAGE_FOOTER_METADATA`, `ENABLE_FIREBASE_ADMIN_AUTH`, `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`, `FIREBASE_WEB_CONFIG_JSON`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_MODEL_NAME_FALLBACK`, `RENDER`, `IS_PULL_REQUEST`, `RENDER_GIT_COMMIT`, `RENDER_GIT_REPO_SLUG`.

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
- Stored alert read, export, analytics, and replay routes (`GET /api/alerts`, `GET /api/alerts/export`, `GET /api/alerts/summary`, `GET /api/alerts/:alertId`, `POST /api/alerts/:alertId/replay`) are also mounted under `/api`; they require `WEBHOOK_API_KEY` when configured, return `403 FEATURE_DISABLED` unless `ENABLE_FIRESTORE_ALERT_STORAGE=true`, and return `503 STORAGE_UNAVAILABLE` when Firestore is enabled but unreadable.
- Webhook idempotency (`IdempotencyService`) stores reservations and cached responses in Cloud Firestore `idempotency_keys` collection when `ENABLE_FIRESTORE_IDEMPOTENCY=true`. All storage interactions fail open to in-memory caching upon Firestore errors, ensuring webhooks remain responsive across process restarts and horizontal scaling. `/api/status` exposes `featureFlags.firestoreIdempotency` and `dependencies.idempotencyStorage`.
- Scanner preset CRUD responses include a non-sensitive `storage` object with the effective `mode` (`durable` or `ephemeral`) and `backend` (`firestore` or `memory`). `ENABLE_FIRESTORE_SCANNER_PRESETS=true` enables Firestore independently; `/api/status` and `/api/capabilities` expose the same state under `dependencies.scannerPresetStorage`.
- Scanner Preset Scheduler (`ScannerPresetSchedulerService.startWorker()`) runs recurring sweeps for due scanner presets with distributed lease locking when `ENABLE_SCANNER_PRESET_SCHEDULER=true`. `SCANNER_PRESET_SCHEDULER_WORKER_ROLE=web` (default) runs in web, `worker` runs in worker mode, `disabled` disables execution. `/api/status` exposes `featureFlags.scannerPresetScheduler` and `dependencies.scannerPresetScheduler`.
- News Monitor Scheduler (`NewsMonitorSchedulerService.startWorker()`) runs recurring news-monitor sweeps when `ENABLE_NEWS_MONITOR_SCHEDULER=true`. `NEWS_MONITOR_SCHEDULER_WORKER_ROLE=web` (default) runs in web, `worker` runs in worker mode, `disabled` disables execution. Defaults reuses `NEWS_SYMBOLS_CRYPTO` / `NEWS_SYMBOLS_STOCKS` for the sweep's symbol list, with a bounded lease via the `newsMonitorSchedulerLocks` Firestore collection so web + worker replicas don't double-fire. `/api/status` exposes `featureFlags.newsMonitorScheduler` and `dependencies.newsMonitorScheduler`.
- Signal Outcome Tracking includes an autonomous background evaluation worker (`SignalOutcomeService.startWorker()`) that runs on a configurable cadence (default: 5 minutes / `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS=300000`). `SIGNAL_OUTCOME_WORKER_ROLE=web` preserves the existing web timer; `worker` starts only `src/workers/signalOutcomeWorker.js`; `disabled` prevents scheduler startup. Sweeps are single-flight, drain active work on dedicated-worker shutdown, and remain bounded by `SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT` (default: 50) and `SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS` (default: 30000). `/api/status` exposes role, heartbeat, scanned/pending/evaluated/error counters under `dependencies.signalOutcomeWorker`; a disabled local scheduler reports `ready: false` and `status: "disabled"`; the dedicated process also persists those safe counters to `workerHeartbeats/signal-outcome` for cross-process inspection.
- Equity outcome evaluation is opt-in via `ENABLE_EQUITY_MARKET_DATA=true` with `EQUITY_MARKET_DATA_PROVIDER=twelve-data` and `TWELVE_DATA_API_KEY`. `EquityMarketDataService` supports `BATS`, `NASDAQ`, `NYSE`, `AMEX`, and `NYSE ARCA`, uses native `fetch` with bounded AbortController timeouts for `/quote` and `/time_series`, maps provider/quota/malformed-data failures to unavailable outcomes, and never blocks alert delivery. `/api/status` exposes non-sensitive readiness under `featureFlags.equityMarketData` and `dependencies.equityMarketData`.

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
  - `pnpm test -- --testNamePattern="should parse price"` — test by test name pattern
- **After completing all changes**: Run the full test suite `pnpm test` once per implementation to ensure no regressions
- **Rationale**: Full test runs take 2-5 minutes and consume significant token budget. Focused tests give rapid feedback (10-30s) during development. Only run full suite as final validation after full implementation phase.
- **Performance tip**: Use `--testTimeout=5000` with unit tests to speed up execution; integration tests need higher timeouts (~10000ms)

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

**Where to look first when extending or debugging**:
- `src/routes/index.js` for endpoint route definition.
- `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` for scan orchestration and deadline management.
- `src/services/tradingview/marketScannerReport.js` for layout and item-specific formatters.
- Tests in `tests/integration/market-scanner-endpoint.test.js` and `tests/unit/market-scanner-report.test.js` / `tests/unit/market-scanner.test.js`.

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
- Idempotency: job-starting POST endpoints reserve the optional `idempotency-key` before validation/worker launch, replay matching responses with `Idempotency-Replay: true` and `idempotencyReplayed: true`, and return `409 IDEMPOTENCY_CONFLICT` when a key is reused with a different request fingerprint. `JOB_QUEUE_ACCEPTANCE_UNKNOWN` 503 responses remain replayable and include the durable `jobId`, so retries do not create a second UUID or queue item. Nested object keys are canonicalized for the fingerprint while array order remains significant. Requests without a key are unchanged.
- Feature checks: returns `404 FEATURE_DISABLED` if market scanner jobs are created but `ENABLE_MARKET_SCANNER` is not `'true'`.
- Persistence: `createJob()` and `getJob()` are async because job metadata/results may be written to or read from Firestore.
- Render worker and poller modes: set `JOB_EXECUTION_MODE=render-worker` (with `REDIS_URL` and durable Firestore credentials) for BullMQ queue execution, or `JOB_EXECUTION_MODE=firestore-poller` (with durable Firestore credentials and optional `JOB_POLL_INTERVAL_MS`) for direct Firestore polling without Redis. In queue mode, the web process returns `503 JOB_QUEUE_UNAVAILABLE` when the queue cannot accept work; if enqueue acknowledgement and deterministic reconciliation both fail, it returns `503 JOB_QUEUE_ACCEPTANCE_UNKNOWN` with the durable `jobId`, preserves the queued durable record, and keeps the idempotency response replayable. The worker periodically scans durable `processing`/`queued` rows and expired `claimed`/`running` leases, retries retained failed BullMQ jobs before adding a duplicate stable ID, and recovers queue work after Redis or worker persistence outages. `JOB_QUEUE_*` settings control attempts, backoff, concurrency, leases, and connection timeout. Final BullMQ failures become terminal `failed` jobs and trigger configured failure callbacks; if the terminal transition was already committed, later failure handling still reconciles the configured callback before acknowledgement. Notification delivery writes a durable pre-send/completed checkpoint; a redelivery with an unknown outcome fails closed as `JOB_DELIVERY_RECONCILIATION_REQUIRED` instead of replaying an external side effect, while a post-delivery checkpoint persistence failure preserves the completed outcome and retries the final durable write. The default `local` mode is unchanged.
- Durable worker saves reject stale writes that would replace a terminal Firestore job state, and ownerless nonterminal saves cannot replace an active claim; claim release and failure transitions verify the worker's actual Firestore claim attempt transactionally, retrying or requeueing terminal failure persistence while storage recovers. Same-worker, same-attempt renewals that observe the worker's terminal finalization are accepted without changing terminal state. A worker checkpoint that discovers a terminal cancellation raises `JOB_CLAIM_LOST` before notification delivery, pre-claim redeliveries do not release or fail another attempt's claim, and terminal redeliveries reconcile unsent callbacks before acknowledgement. Status-filtered Firestore list queries are bounded server-side before the worker reconciliation scan.
- Telegram commands: async `createJob()` rejections must stay inside the command `try/catch` so `replyValidationError()` can return clear command feedback instead of producing unhandled promise rejections.
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

**Failure and Edge Case Behavior**:
- The API gates checks behind the `validateApiKey` middleware.
- Dependency checking (like querying the TradingView MCP or testing Firestore credentials) is done safely and returns detailed state status (`ready`, `error`, `unconfigured`) in a clean JSON format.
- `deliveryMetrics` is fail-open: malformed or missing `durationMs` values are excluded from latency averages without blocking delivery; counters reset on process restart (acceptable for operational monitoring) and never return values for channels that have not recorded any deliveries.

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
- Telegram requires existing: BOT_TOKEN, TELEGRAM_CHAT_ID

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

**Configuration**:
- `ENABLE_NEWS_MONITOR` — Feature flag (default: false for safe rollout)
- `ENABLE_NEWS_MONITOR_TEST_MODE` — Expose news monitor test-mode state in `/api/status` and `/api/capabilities` (default: false)
- `NEWS_SYMBOLS_CRYPTO` — Default crypto symbols if not provided in request (comma-separated, e.g., "BTCUSDT,ETHUSD")
- `NEWS_SYMBOLS_STOCKS` — Default stock symbols if not provided in request (comma-separated)
- `NEWS_ALERT_THRESHOLD` — Confidence score threshold (default: 0.7, range 0.0-1.0)
- `NEWS_CACHE_TTL_HOURS` — Cache time-to-live (default: 6 hours)
- `NEWS_TIMEOUT_MS` — Per-symbol analysis timeout (default: 30000 ms)
- `NEWS_GEMINI_CONCURRENCY` — Max concurrent Gemini-backed symbol analyses. Production policy is `3`; leave unset only for backward-compatible legacy full fan-out.
- `NEWS_GEMINI_QUOTA_MAX_RETRIES` — Per-symbol retry count for Gemini `429 RESOURCE_EXHAUSTED` errors (default: 2)
- `NEWS_GEMINI_QUOTA_RETRY_BASE_MS` — Base exponential backoff in milliseconds when provider retry metadata is absent (default: 1000)
- `ENABLE_BINANCE_PRICE_CHECK` — Enable Binance crypto price fetching (default: false)
- `ENABLE_LLM_ALERT_ENRICHMENT` — Enable optional secondary LLM enrichment (default: false)
- `URL_SHORTENER_SERVICE` — URL shortening service for WhatsApp citations (default: `picsee`; options: `picsee`, `tinyurl`, `cuttly`)
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
- `GET /api/alerts/export` returns bounded JSONL or CSV (`format=jsonl|csv`) for stored alerts. It requires both `from` and `to`, caps `limit` at 1000, caps the window at 31 days, supports `source`, `enriched`, and `includeText=true`, and only includes safe export fields. Raw alert text is excluded by default and truncated to 1000 chars when included. CSV prefixes direct or tab/LF/CR-prefixed formula-leading string fields with an apostrophe for spreadsheet safety while leaving finite numeric strings unchanged; JSONL is unchanged.
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


- GH-401 / CB-163: `src/admin/admin.js` now validates both the `backend` query parameter and `cabros_backend_origin` localStorage override with an exact HTTPS origin allowlist before using them for API requests. The only allowed override is `https://cabros-bot-production.up.railway.app`; arbitrary origins, wildcards, HTTP URLs, and malformed values fall back to the normal same-origin or hosted-production behavior. `tests/unit/admin-client.test.js` covers rejection of an attacker-controlled override, and the generated Firebase Hosting asset must stay synchronized with `pnpm run build:hosting`.
- GH-402 / CB-164: the hosted admin console `loadAuthConfig()` fetch is now bounded by an 8-second `AbortController` timeout; an aborted or stalled `/admin/auth-config` request resolves through the existing `{ enabled: true, configured: false }` fallback so the console renders "Firebase sign-in is unavailable" instead of hanging on "Checking authentication…". The vm-based admin client test harness provides controllable timers and a fake `AbortController`, with regression coverage for the stall-then-timeout path in `tests/unit/admin-client.test.js`.
- GH-366 / CB-150: durable TradingView jobs now receive a one-hour `expiresAt` on terminal Firestore writes; the shared Firestore retention backfill/configuration covers legacy terminal `tradingviewJobs` documents while leaving active jobs untouched. Unit and Firebase Emulator coverage verify terminal expiry and active-job preservation.
- GH-533 / CB-236: operational Firestore retention now enables native TTL and backfills legacy `notificationDeadLetters` documents using `NOTIFICATION_REDRIVE_MAX_AGE_MS`; existing idempotency and news-dedup retention behavior remains unchanged. Unit coverage verifies the collection mapping.
- GH-313 / CB-128: grounding asset-context parsing now preserves slash-delimited crypto pairs such as `BTC/USDT`; the fallback no longer truncates a symbol before `/`, while explicit exchange and TradingView signal parsing remain unchanged. Regression coverage is in `tests/unit/tradingview-signal-parser.test.js`.
- GH-291 / CB-112: hardened Render-worker job acceptance and recovery. Indeterminate enqueue responses preserve a replayable idempotency result with the durable `jobId`; the worker periodically reconciles durable queued rows and expired claims after Redis recovery, retries retained failed BullMQ jobs, terminal checkpoint races abort before notification delivery, status-filtered list queries preserve recent-first ordering while bounding Firestore scans, and terminal BullMQ failure handling retries pending callbacks even after the terminal job state was already committed. Production worker/Key Value provisioning remains payment-gated.
- GH-284 / CB-118: Production Gemini quota recurrence was traced to an unset `NEWS_GEMINI_CONCURRENCY` with a Sentry `POST /api/news-monitor` dry-run carrying 28 symbols. Production uses the existing scheduler with `NEWS_GEMINI_CONCURRENCY=3`; analysis now runs inside the Sentry span so `summary.quota_exhausted` plus the `news.quota_exhausted` and `news.error_count` attributes remain correlated operational signals. Sentry measured 61 quota events through 2026-07-28T13:44:03Z against a Gemini free-tier limit of 15 requests/minute for the affected model; no current percentile or complete request-count measurement is inferred from that error window.
- GH-287 / CB-119: Added opt-in Twelve Data equity market-data evaluation for `BATS`, `NASDAQ`, `NYSE`, `AMEX`, and `NYSE ARCA` signals. Entry prices use `/quote`; bounded historical `/time_series` bars calculate return, MFE, and MAE across existing windows. Provider failures remain unavailable/fail-open, metrics expose exchange/provider coverage, and `/api/status`, README, OpenAPI, Postman, and `.env.example` document readiness without secrets. Production remains disabled until plan/licensing and live-provider validation are completed.
- GH-292 / CB-122: added an opt-in Render Background Worker entrypoint for signal-outcome evaluation, role-gated web/worker scheduling, graceful dedicated-worker drain, safe heartbeat counters, and paid-worker Blueprint wiring. Production cutover remains explicit: enable tracking and disable the web scheduler only after the worker plan and Firestore credentials are confirmed.
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

## TradingView MCP Alert-Path Health (CB-241 / Issue #536)

TradingView alert enrichment now exposes an in-process rolling 24-hour `dependencies.tradingViewMcp.enrichment.alertPath` snapshot with total, applied, failed, and percentage counters. The existing MCP circuit-breaker paging remains the single deduplicated admin outage page and continues to fail open. Stored-alert summaries expose `enrichment.tradingViewStatusCounts` with `full`, `partial`, `failed`, `not_applicable`, and `unrecorded`; requested legacy records without a persisted outcome are counted as `unrecorded`.

**Coverage**:
- `src/services/tradingview/TradingViewMcpService.js` — Rolling alert-path outcome window and status projection, isolated from volume-confirmation runtime state.
- `src/services/storage/AlertStorageService.js` — Explicit stored outcome buckets with legacy requested-record accounting.
- `tests/unit/tradingview-mcp-service.test.js`, `tests/unit/alert-storage-service.test.js`, and `tests/integration/status-endpoint.test.js` — Rate, bucket, and protected status contract coverage.
- `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, and `README.md` — Additive status/summary contract examples.

No new environment variable or Remote Config key was added; the 24-hour window is a fixed operational reporting boundary and existing circuit-breaker controls already provide deduplicated paging.

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

## Firebase Remote Config Safe Runtime Tuning (CB-116 / Issue #303)

`ENABLE_FIREBASE_REMOTE_CONFIG=true` enables the Firebase Admin server-side Remote Config Preview loader. The repository template is published by `scripts/deploy-server-remote-config.js` to the `firebase-server` namespace and loaded by `admin.remoteConfig().initServerTemplate()`; it is not a Firebase Web/Client SDK configuration. `RemoteConfigService` reuses the existing lazy Firebase Admin/Firestore initialization, loads once after startup, and refreshes on a bounded interval; alert paths only read the in-process cache and never fetch per alert.

The allow-list is limited to news thresholds/concurrency/retries, TradingView timeouts/retries, `SIGNAL_OUTCOME_RETENTION_DAYS` (retention in days between `1` and `3650`, default `365`), and `ENABLE_MESSAGE_FOOTER_METADATA`. Values are validated against finite, integer, positive, boolean, and range constraints. TradingView MCP timeout and enrichment-budget values are bounded to `1000`-`120000` milliseconds, and retry counts to `1`-`5`; the environment fallback uses the same schema as Remote Config. `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS` is intentionally environment-only because the worker timer is created during process startup; it is excluded from both the allow-list and the template. Credentials, API keys, webhook authentication, route/security gates, and notification destinations are excluded. Disabled, unavailable, timed-out, stale, malformed, or invalid values fall back to environment/default values without blocking startup or alert delivery.

`/api/status` and `/api/capabilities` expose only `enabled`, `configured`, `ready` (true only after a successful, fresh template load), `status` (`ready`, `degraded`, `unknown`, `misconfigured`, or `disabled`), `source`, template version, last successful load, last error category, consecutive failures, and bounded loader settings under `dependencies.firebaseRemoteConfig`; remote values and secrets are never returned.

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

## Admin Recent Job Discovery (CB-117 / Issue #283)

The in-app `/admin` Jobs view consumes the existing protected `GET /api/jobs` endpoint with contract-derived status/type filters and the bounded `limit` range. It renders only safe summary fields with DOM text nodes, keeps the API key in the existing `x-api-key` header path, and lets operators pre-fill the existing job-status workflow without bypassing its cancel/retry confirmations.

**Core Components**:
- `src/admin/admin.js` — Recent-job list form, safe summary rendering, and selected-job handoff to the status form.
- `tests/unit/admin-client.test.js` — Covers query construction, header-only authentication, safe rendering, status navigation, stale-list clearing, and pending-response invalidation.

Job-list, status, and cancel/retry responses use monotonic request versions and pass activity guards into `sendRequest`, so responses from obsolete filters or job IDs cannot overwrite current state, hold shared forms disabled, or render stale actions.

This is a UI-only consumer change: job persistence, lifecycle semantics, OpenAPI, and Postman contracts remain unchanged.

## Admin Console Fetch Deadlines (CB-164 / Issue #402)

The hosted admin console now bounds browser fetches: `/admin/auth-config` keeps its existing 8-second fallback, `/openapi.json` uses an 8-second contract-load deadline, ordinary protected API requests use 30 seconds, synchronous analysis/news-monitor/market-scanner/scanner-preset/direct-alert/message/replay reports use a 900-second client budget derived from their 120-second analysis and notification-delivery ceilings, and volume confirmation uses 360 seconds for its three sequential 120-second MCP calls. A shared `fetchWithTimeout()` helper keeps response-body parsing inside the abortable operation, clears timers on success/failure, and preserves contract retry plus request error/finally behavior.

**Coverage**:
- `src/admin/admin.js` and generated `public/admin/admin.js` — shared browser deadline helper for auth config, OpenAPI contract, and API requests.
- `tests/unit/admin-client.test.js` — proves stalled contract and protected requests abort, settle through existing error UI, clear timers, and cover every synchronous long-running console route.
- `tests/integration/openapi-docs.test.js` — keeps the public admin asset contract check aligned with the deadline helper.

No new environment variable, endpoint, OpenAPI, Postman, or Remote Config change was needed.

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
- `tests/unit/tradingview-mcp-service.test.js` — Covers full-budget base analysis, retry after base timeout, capped retry delays, optional timeout preserving base data, and failed status accounting.
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

TradingView MCP alert enrichment derives optional directional invalidation, target, setup, and risk/reward metadata from the MCP analysis. Numeric and numeric-string ATR values are normalized before validation. ATR-derived levels are emitted only when the supplied ATR and every resulting level are finite, positive, and on the correct side of entry; a rejected supplied ATR suppresses the entire numeric risk block instead of falling back to a synthetic stop. Setup metadata remains independently optional, uses explicit/inferred evidence only, and mean-reversion inference must align Bollinger position with signal direction. When Gemini and MCP enrichment are combined, invalidation, target, and risk/reward are selected atomically from one complete provider block to prevent inconsistent ratios.

**Coverage**:
- `src/services/tradingview/TradingViewMcpService.js` — MCP risk derivation, ATR rejection, standalone setup metadata, and side-aware setup inference.
- `src/controllers/webhooks/handlers/alert/grounding.js` — Atomic Gemini/MCP risk-block selection.
- `tests/unit/tradingview-mcp-service.test.js` and `tests/unit/alert-handler.test.js` — Directional calculations, invalid ATR/fallback suppression, setup inference, and provider merge invariants.

No endpoint, OpenAPI, Postman, environment variable, or Remote Config contract changed; existing optional response fields and formatter support remain in place.

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
