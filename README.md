# Cabros Bot

[![Node.js CI](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml/badge.svg)](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](https://github.com/francovp/cabros-bot)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24.18.0%20%3C25-brightgreen.svg)](https://nodejs.org/)

A high-performance crypto, equity, and market intelligence bot service built with Node.js and Express. It connects incoming TradingView alerts and scheduled event monitors with Gemini Grounding, TradingView MCP analysis, and Binance Spot execution, dispatching formatted alerts concurrently across Telegram, WhatsApp, and Discord.

> **New here?** Start with [`docs/PRODUCT.md`](docs/PRODUCT.md) for a human-readable capability map, status legend, and the first-24-hours operator journey. This README is the detailed operator reference.

---

## Core Capabilities

- **Multi-Channel Alert Dispatch**: Broadcast alerts concurrently across Telegram, WhatsApp (GreenAPI), and Discord Webhooks with channel-specific Markdown escaping, URL shortening, independent retries, and dead-letter queue redrive.
- **TradingView MCP Integration**: Connects to the remote TradingView MCP Streamable HTTP service to fetch multi-timeframe oscillators, moving averages, pivot points, and technical summaries (`coin_analysis`).
- **AI Grounding & Prompt Management**: Enriches raw signals with Google Gemini Grounding (sentiment, key insights, technical levels, news sources) backed by Langfuse prompt management and token cost budgets.
- **News Monitoring & Event Detection**: Scans crypto and equity symbols on a schedule, scores news confidence, applies persistent deduplication, and falls back to Binance/Twelve Data real-time prices.
- **Binance Spot Trading**: Validates, tests, and places spot orders with strict exchange filters, balance verification, and idempotent client order tracking.
- **Signal Outcomes & Excursion Tracking**: Persists trading signals to Firestore, automatically tracking multi-window price excursion metrics (1h, 4h, 1D, 1W), MFE/MAE, win rates, and calibration.
- **Asynchronous Jobs & Background Workers**: Offloads heavy multi-symbol analyses and market scanner sweeps to Redis/BullMQ background workers with live status polling.
- **Operator Console & Admin API**: Web-based operator UI (served via Firebase Hosting) and REST API secured with Firebase Admin ID tokens and API keys.

---

## Documentation Index

Comprehensive guides and technical documentation are maintained inside the [`docs/`](docs/) directory:

| Guide | Description |
| :--- | :--- |
| **[Environment Configuration](docs/environment-configuration.md)** | Complete dictionary of required and optional environment variables, Remote Config parity, and recipe configurations. |
| **[API Reference](docs/api-reference.md)** | Core system endpoints (`/healthcheck`, `/ready`, `/api/status`, `/api/public/status`), browser admin auth, and Firebase Hosting. |
| **[Webhook Alerts API](docs/webhooks.md)** | TradingView webhook endpoints (`/api/webhook/alert`, `/expanded-analysis-alert`, `/volume-confirmation`, `/symbol-analysis`, `/market-scanner-alert`). |
| **[Asynchronous Jobs API](docs/jobs.md)** | Background TradingView analysis jobs (`/api/jobs/tradingview-analysis`, retry, status polling, BullMQ worker). |
| **[Stored Alerts API](docs/alerts.md)** | Stored alert query, cursor pagination, JSON/CSV export, analytics summary, sentiment score calibration, user feedback, and safe replay mechanics. |
| **[Signal Outcomes Tracking](docs/signal-outcomes.md)** | Signal outcome lifecycle (CB-199), evaluation windows (1h, 4h, 1D, 1W), MFE/MAE excursions, and calibration API. |
| **[TradingView MCP Integration](docs/tradingview-mcp.md)** | Streamable HTTP endpoint setup, symbol resolution, timeframe mapping, and multi-timeframe technical confluence. |
| **[AI Grounding & Prompts](docs/ai-grounding.md)** | Gemini Grounding (001), enrichment flow, reference-calibrated sentiment anchors, the zero-source score cap, token spend tracking, and Langfuse prompt management. |
| **[Multi-Channel Alerts](docs/notifications.md)** | Multi-channel delivery rules (Telegram, WhatsApp, Discord), MarkdownV2 escaping, URL shortening, and dead-letter redrive. |
| **[Telegram Commands](docs/commands.md)** | Interactive bot commands (`/help`, `/precio`, `/cryptobot`, `/analisis`, `/scanner`, `/jobs`, `/noticias`), throttling, and forum topic routing. |
| **[News Monitoring](docs/news-monitor.md)** | Event detection engine, confidence scoring, persistent deduplication, secondary LLM refinement, and volume throttling. |
| **[Observability & Monitoring](docs/monitoring.md)** | Sentry runtime error monitoring (005), health probes, production smoke probes, structured JSON logging, structured per-request HTTP access logs, and Firestore write/read metrics. |
| **[Deployment & Operations](docs/deployment.md)** | Render.com web services and BullMQ workers, preview PR environments, ngrok local tunneling, and Docker/Devcontainer. |
| **[Troubleshooting Guide](docs/troubleshooting.md)** | Diagnostic checklists and recovery runbooks for news monitoring, messaging channels, URL shortening, and retries. |
| **[Firestore Backup & Restore](docs/firestore-backup-and-restore.md)** | Procedures and scripts for backing up and restoring Firestore operational collections. |
| **[SDK Major Drift Audit](docs/runtime-sdk-major-drift-audit.md)** | Dependency audit and version compatibility policy across Node.js runtime and SDKs. |

---

## Quick Start

### 1. Prerequisites

- **Node.js**: `>=24.18.0 <25` (enforced via `.node-version` and `package.json` engines)
- **Package Manager**: `pnpm` (`pnpm@10.34.1` recommended)
- **Telegram Bot Token**: Created via [@BotFather](https://t.me/botfather)

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/francovp/cabros-bot.git
cd cabros-bot

# Install dependencies using frozen lockfile
pnpm install --frozen-lockfile
```

### 3. Environment Configuration

Create a local `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Minimal `.env` setup:

```ini
# Required core credentials
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=-1001234567890
WEBHOOK_API_KEY=your_secret_api_key

# Web server port
PORT=3000
```

Validate your configuration with the built-in diagnostic doctor:

```bash
pnpm run doctor
```

See the [Environment Configuration Guide](docs/environment-configuration.md) for full variable reference and recipe configurations.

### 4. Running the Application

```bash
# Start development server with auto-reload (nodemon)
pnpm run start-dev

# Start production server
pnpm start

# Start standalone BullMQ analysis worker (optional Render background worker)
pnpm run start-worker

# Start standalone signal outcome evaluation worker (optional Render background worker)
pnpm run start:signal-outcome-worker
```

Verify service readiness:

```bash
curl http://localhost:3000/healthcheck
curl http://localhost:3000/ready
curl "http://localhost:3000/healthcheck?depth=readiness"
curl "http://localhost:3000/ready?depth=dependencies"
```

---

## API Endpoints Summary

All webhook and mutation endpoints require the `x-api-key` header (configured via `WEBHOOK_API_KEY`). Browser admin endpoints support Firebase ID tokens (`Authorization: Bearer <token>`).

| Method | Path | Description | Documentation |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthcheck` | Process liveness probe; `?deep=true` = channel readiness, `?depth=readiness` = dependency report (advisory, always 200) | [API Reference](docs/api-reference.md#get-healthcheck) |
| `GET` | `/ready` | Bootstrap gate; `?depth=dependencies` adds a fail-closed dependency probe | [API Reference](docs/api-reference.md#get-ready) |
| `GET` | `/api/status` | Comprehensive system capabilities & dependency matrix | [API Reference](docs/api-reference.md#get-apistatus) |
| `GET` | `/api/public/status` | Safe public subset of capabilities & channel statuses | [API Reference](docs/api-reference.md#get-apipublicstatus) |
| `POST` | `/api/webhook/alert` | Ingest and dispatch alert to configured channels | [Webhook Alerts](docs/webhooks.md#post-apiwebhookalert) |
| `POST` | `/api/webhook/expanded-analysis-alert` | TradingView MCP technical analysis report | [Webhook Alerts](docs/webhooks.md#post-apiwebhookexpanded-analysis-alert) |
| `POST` | `/api/webhook/volume-confirmation` | TradingView volume and momentum confirmation | [Webhook Alerts](docs/webhooks.md#post-apiwebhookvolume-confirmation) |
| `POST` | `/api/webhook/symbol-analysis` | Immediate multi-timeframe symbol analysis | [Webhook Alerts](docs/webhooks.md#post-apiwebhooksymbol-analysis) |
| `POST` | `/api/webhook/market-scanner-alert` | Multi-asset market scanner report (gainers/losers) | [Webhook Alerts](docs/webhooks.md#post-apiwebhookmarket-scanner-alert) |
| `POST` | `/api/webhook/message` | Generic non-alert message to enabled channels; reports inbound truncation metadata | [Webhook Alerts](docs/webhooks.md#post-apiwebhookmessage) |
| `POST` | `/api/jobs/tradingview-analysis` | Queue long-running analysis or scanner job | [Jobs API](docs/jobs.md#post-apijobstradingview-analysis) |
| `GET` | `/api/jobs` | List recent background jobs with status & progress | [Jobs API](docs/jobs.md#get-apijobs) |
| `GET` | `/api/jobs/:jobId` | Poll background job progress and retrieve result | [Jobs API](docs/jobs.md#get-apijobsjobid) |
| `POST` | `/api/news-monitor` | Trigger symbol news scanning & event detection | [News Monitoring](docs/news-monitor.md) |
| `POST` | `/api/trading/binance/orders/preview` | Pre-trade Binance Spot cost & slippage preview | [API Reference](docs/api-reference.md#post-apitradingbinanceorderspreview) |
| `GET` | `/api/alerts` | Query stored alerts with pagination & filtering | [Stored Alerts](docs/alerts.md#get-apialerts) |
| `GET` | `/api/alerts/summary` | Analytics & delivery success rate metrics | [Stored Alerts](docs/alerts.md#get-apialertssummary) |
| `POST` | `/api/alerts/:alertId/replay` | Dry-run or live replay of stored alert | [Stored Alerts](docs/alerts.md#post-apialertsalertidreplay) |
| `GET` | `/api/outcomes` | Query signal outcomes with multi-window returns | [Signal Outcomes](docs/signal-outcomes.md#get-apioutcomes) |
| `GET` | `/api/outcomes/summary` | Expectancy, win rate, and performance summary | [Signal Outcomes](docs/signal-outcomes.md#get-apioutcomessummary) |

Interactive Swagger documentation is available at `/docs`, and OpenAPI 3.1 schema is published at `/openapi.json`.

---

## Telegram Commands Summary

When the Telegram bot is enabled (`ENABLE_TELEGRAM_BOT=true`), the bot provides interactive commands:

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/help`, `/start` | None | Displays command list and argument help. |
| `/precio` | `<symbol>` | Real-time crypto (Binance) or equity (Twelve Data) price quote. |
| `/alerta`, `/alert` | `<symbol> <op> <price>` | Creates a user-defined price-threshold alert. Also `/alerta list` and `/alerta cancel <id>`. |
| `/cryptobot` | `id` | Displays the current Telegram chat ID. |
| `/analisis` | `<symbols>` | Runs quick TradingView technical analysis for specified symbols. |
| `/scanner` | `[options]` | Executes market scanner sweep across preconfigured assets. |
| `/jobs` | `[jobId]` | Inspects status or lists active background analysis jobs. |
| `/noticias` | `[options]` | Trigger news monitoring analysis for specified crypto/equity tickers. |

See the [Telegram Commands Reference](docs/commands.md) for aliases, throttling rules, and examples.

---

## Key Runtime Notes

### Multi-Channel Notification Dispatch
Notifications are dispatched concurrently across enabled channels. For Discord, transient rate limits and server errors are retried according to `DISCORD_MAX_RETRIES` and bounded by `DISCORD_MAX_TOTAL_RETRY_WAIT_MS`. Long messages exceeding platform limits are automatically split into sequential chunks with preserved markdown formatting. See [Multi-Channel Alerts Guide](docs/notifications.md).

### AI Provider Routing & Grounding
When configuring AI providers, `MODEL_PROVIDER=cloudflare` selects Cloudflare runtime routing, whereas `ENABLE_CLOUDFLARE_AIG` only exposes Cloudflare readiness in status/capabilities. Because the flag alone does not route traffic, `dependencies.cloudflareAig` reports `provider` and `routed` alongside `ready`: credentials present while another provider is selected yield `ready: false` and `status: "inactive"`, so an operator can never read `ready` as proof that requests traverse the gateway. Gemini Grounding provides web search citations and confidence scores for market alerts. See [AI Grounding & Prompts](docs/ai-grounding.md).

### Sentiment Score Calibration

Enriched `sentiment_score` is scored against five fixed reference anchors (`0.90` multi-source major catalyst, `0.75` corroborated, `0.60` partial, `0.45` routine, `0.30` negligible) and the model must justify its choice in `sentiment_score_evidence`. Without a reference point the score saturated — 87.6% of production scores sat at or above 0.75, which made the field useless for ranking alerts or tuning thresholds.

Two guards keep that from silently returning:

- **Prompt anchors** — a Langfuse `alert-enrichment` prompt that has not been republished reports `promptProvenance.schemaDriftDetected: true` with the missing markers listed in `missingCalibrationGuidance`. That flag is the rollout signal, not a failure.
- **Saturation telemetry** — `enrichment.sentimentCalibration` in `GET /api/alerts/summary` reports `saturated` plus the rule that fired (`spread_collapse` when `p90 - p10` collapses, `top_band_concentration` when ≥75% of scores pile into the top band). Both rules are needed: the reported production failure had a `p90 - p10` of `0.15`, so a spread-only guard would have stayed silent. `insufficient_sample` and `no_samples` mean no verdict was declared rather than that the window is healthy. `rawScoreCapCount` reports how many alerts the zero-source cap rewrote, which is how you confirm the cap is live in the deployment you are querying.

A process-local window in `src/services/grounding/gemini.js` emits one structured warning per hour when it saturates; it is a fast early warning only, and a restart clears it. See [Stored Alerts](docs/alerts.md#sentiment-score-calibration) and [AI Grounding & Prompts](docs/ai-grounding.md#sentiment-score-calibration).

### News Monitoring Volume Throttling
The news monitor endpoint reports volume throttling status in its response payload:
```json
{
  "analyzed": 5,
  "alertsSent": 2,
  "throttled": 0,
  "errors": 0
}
```
- `throttled` - The number of symbols skipped during the execution sweep because the rate limit window was reached. See [News Monitoring Guide](docs/news-monitor.md).

### User-Defined Price Threshold Alerts

Users can create their own threshold alerts from Telegram (opt-in via `ENABLE_USER_PRICE_ALERTS=true`, disabled by default):

```
/alerta BTCUSDT < 60000      # notify when BTC drops below 60000
/alerta NASDAQ:NVDA >= 140   # notify when NVDA reaches 140
/alerta ETHUSDT mayor 3500   # natural-language operator
/alerta list                 # list this chat's active alerts
/alerta cancel <id>          # cancel an alert
```

Alerts are stored in the server-side-only `userPriceAlerts` Firestore collection (client access is denied by `firestore.rules`) and evaluated by a bounded background sweep. Key behavior:

- **Durable with a fail-open in-memory fallback.** When Firestore is unavailable the service runs from an in-process map; a durable write failure is reported to the user instead of silently acknowledging a lost alert.
- **Durable reads never fall back to the ephemeral mirror.** If a durable `list`/`get`/sweep read fails, the service reports the storage error instead of answering from the process-local map, which would tell a user their armed alerts had vanished and make them impossible to cancel.
- **Fires at most once.** The `armed → triggered` transition is claimed inside a Firestore transaction before the notification is dispatched, and the sweep is guarded by a distributed lease (`userPriceAlertLocks`), so overlapping sweeps or multiple replicas cannot double-notify.
- **A trigger is only consumed when it is actually delivered.** If no Telegram bot is available, the claim is rolled back and the alert returns to `armed` so a replica that can send still notifies the user. Delivery records `deliveryAttemptedAt` *before* the send and `deliveredAt` after it, and the re-arm requires the absence of both — so a lost delivery-marker write can never resurrect a notification the user already received.
- **A replica that cannot deliver never sweeps.** If the process has no Telegram bot (Telegram disabled, or a preview deployment), the sweep is deferred instead of claiming and re-arming the same alert on every cycle.
- **No starvation.** The sweep orders by document id and resumes after the last scanned id, so alerts beyond `USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT` are still evaluated on later sweeps.
- **Bounded cost.** Prices are deduplicated per symbol and fetched with at most `USER_PRICE_ALERT_PRICE_FETCH_CONCURRENCY` concurrent provider calls.
- **Bounded state.** Each chat may hold at most `USER_PRICE_ALERT_MAX_PER_CHAT` armed alerts, they expire after `USER_PRICE_ALERT_RETENTION_DAYS`, and `/alerta` is rate-limited like the other expensive commands.
- **Forum topics.** A Telegram forum topic id of `0` (the chat's General topic) is preserved as an explicit destination rather than treated as "no topic".
- **Notification-only.** No exchange-key custody and no order placement; trading stays behind the operator-only Binance endpoint.

`GET /api/status` and `GET /api/capabilities` expose `featureFlags.userPriceAlerts` and a non-sensitive `dependencies.userPriceAlertWorker` block (role, running state, sweep counters, `lastError`, and `storageMode`). `ready` is only true when storage is `durable`; without Firestore the service reports `configured: false` / `status: "degraded"` so process-local alerts are never mistaken for durable ones.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `ENABLE_USER_PRICE_ALERTS` | `false` | Master feature gate. Remote Config eligible. |
| `USER_PRICE_ALERT_WORKER_ROLE` | `web` | `web`, `worker`, or `disabled`. Must match the process source. |
| `USER_PRICE_ALERT_EVALUATION_INTERVAL_MS` | `60000` | Sweep cadence. Remote Config eligible. |
| `USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT` | `50` | Armed alerts scanned per sweep. Remote Config eligible. |
| `USER_PRICE_ALERT_MAX_PER_CHAT` | `20` | Per-chat armed-alert quota. |
| `USER_PRICE_ALERT_RETENTION_DAYS` | `30` | Days before an armed alert expires. |
| `USER_PRICE_ALERT_LEASE_MS` | `120000` | Distributed sweep lease duration. |
| `USER_PRICE_ALERT_PRICE_FETCH_CONCURRENCY` | `3` | Concurrent price lookups per sweep. |

### Async Job Backlog Depth & Operator Paging

A background probe reports durable async-job backlog depth on `GET /api/status` and `GET /api/capabilities` under `dependencies.jobExecutionQueue`, and pages `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` when non-terminal queued jobs accumulate while workers are stalled or offline. Broker readiness alone cannot distinguish a *ready but undrained* queue from a healthy one, which is why queue "ready" is reported alongside depth rather than instead of it.

`durableQueuedCount` is a **lower bound**: the probe scans at most `5` pages of `100` documents and sets `truncated` when it stops early, so it never overstates what it observed. `oldestQueuedAgeMs` is `null` when the backlog is empty **or** when the durable probe failed — a failed probe never clears an active alert or emits a false all-clear, because an indeterminate result is not evidence of recovery. `backlogMonitorEnabled` is `false` when the monitor is switched off, so disabled monitoring is never read as a healthy empty queue.

Paging is deduplicated by cooldown and only latches after confirmed delivery; a failed page or a failed all-clear is retried on the next probe. All probing and paging is fail-open — it never blocks job intake or alert delivery — and each external probe is individually bounded so a half-open broker connection cannot silently stop backlog reporting for the process lifetime.

| Variable | Default | Bounds | Purpose |
| :--- | :--- | :--- | :--- |
| `JOB_BACKLOG_ALERT_THRESHOLD_MS` | `900000` | `1000`–`86400000` | Oldest-queued age that triggers an operator page. Remote Config eligible. |
| `JOB_BACKLOG_PAGE_COOLDOWN_MS` | `900000` | `1000`–`86400000` | Minimum gap between repeat pages, so a sustained stall cannot storm the operator. Remote Config eligible. |
| `JOB_BACKLOG_PROBE_INTERVAL_MS` | `60000` | `1000`–`3600000` | Background probe cadence. Remote Config eligible. |
| `JOB_BACKLOG_PROBE_TIMEOUT_MS` | `10000` | `1000`–`300000` | Per-dependency probe deadline. Environment-only. |
| `ENABLE_JOB_BACKLOG_MONITOR` | `true` | — | Master monitor gate. **Environment-only** — a process-startup gate, deliberately excluded from Remote Config. |

### Equity Market Data Readiness

`ENABLE_EQUITY_MARKET_DATA=true` plus `EQUITY_MARKET_DATA_PROVIDER=twelve-data` and `TWELVE_DATA_API_KEY` enables equity outcome evaluation for `BATS`, `NASDAQ`, `NYSE`, `AMEX`, `NYSE ARCA`, `FX_IDC`, and `SPCFD` signals. Setting those variables is **necessary but not sufficient**, so `/api/status` will not report the feature as working on the strength of the key alone.

`dependencies.equityMarketData.configured` reflects credential *shape* — gate on, provider selected, key non-empty. A typo'd, revoked, quota-exhausted, or wrong-plan key passes that check, which is why `ready` requires an observed successful provider call instead:

| `status` | Meaning |
| :--- | :--- |
| `disabled` | `ENABLE_EQUITY_MARKET_DATA` is not `true`. |
| `misconfigured` | Enabled, but the provider or API key is missing. |
| `unverified` | Configured, but no provider call has succeeded yet. Not a failure — and not health. |
| `ready` | A provider call has actually succeeded. |
| `degraded` | The provider rejected a call; `lastErrorReason` names the class. |

`readiness`, the `requestsAttempted`/`requestsSucceeded`/`requestsFailed`/`consecutiveFailures` counters, and the `lastSuccessAt`/`lastFailureAt` timestamps expose the observed window, which is process-local and resets on restart — so `unverified` is the normal state right after every deploy. There is deliberately no startup probe: it would burn provider quota on every restart purely to manufacture a green checkmark. See [Environment Configuration](docs/environment-configuration.md#verifying-equity-market-data-is-actually-working).

### Market Scanner MCP Fast-Fail Gate
`POST /api/webhook/market-scanner-alert` checks the process-local TradingView MCP status before running its sequential scans. If the status is `degraded` with `http_5xx`, `request_failed`, or `circuit_breaker_open` **and** the circuit breaker still reports `state: "open"`, it skips every scan and returns `502 TRADINGVIEW_MCP_UNAVAILABLE` with each scan as `status: "skipped"`. The endpoint returns `502` in two shapes: `TRADINGVIEW_MCP_UNAVAILABLE` (skipped, nothing attempted) and `ALL_SCANS_FAILED` (attempted, all failed). The gate keys on the breaker's time-based state so that after `TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS` elapses the next request is allowed through as a recovery probe — a transient outage self-heals without a restart. See [Webhook Alerts](docs/webhooks.md#post-apiwebhookmarket-scanner-alert).

---

## Running Tests

The test suite includes comprehensive unit tests, integration tests, contract audits, and an optional Firestore emulator suite.

```bash
# Run full unit and integration test suite
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Generate code coverage report
pnpm run test:coverage

# Run focused test file
pnpm test -- tests/unit/alert-handler.test.js

# Run opt-in Firestore emulator integration suite (requires local Firebase emulator)
pnpm run test:firebase

# Run linter
pnpm run lint
```

---

### Updating SHA-pinned GitHub Actions

All `uses:` references in `.github/workflows/*.yml` are pinned to full 40-character commit SHAs (with an inline `# v<major>` comment) for supply-chain hardening — see [issue #803](https://github.com/francovp/cabros-bot/issues/803). Mutable major-version tags can be force-moved by the action owner, so a tag pin is not a reproducible CI reference.

To bump a pinned action to a newer release:

1. Visit `https://github.com/<owner>/<repo>/commits/<major-tag>` (for example, `https://github.com/actions/checkout/commits/v4`).
2. Copy the latest commit's 40-character SHA.
3. Update both the SHA and the trailing version comment in every workflow that references the action. The `grep -rEn 'uses:.*@v[0-9]+(\.|$| )' .github/workflows/` check must return zero matches after the change.

A future Dependabot `github-actions` ecosystem entry (proposed in #559) can automate the SHA rewrite on upstream release; until that lands, bump SHAs manually on the cadence above.

### Rate-limit response headers

Every protected `/api` response (success and throttled) carries the standard `X-RateLimit-*` headers so callers can implement adaptive backpressure:

| Header | Value |
|---|---|
| `X-RateLimit-Limit` | Max requests per window for the active bucket (`RATE_LIMIT_MAX` or `1000` for `/api/webhook/alert` and `/api/webhook/message`). |
| `X-RateLimit-Remaining` | Requests remaining in the current window. Zero on a throttled response. |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the current window resets. |

Throttled (`429`) responses additionally include the existing `Retry-After` header (seconds) and the `retryAfterSeconds` field in the JSON body. `/healthcheck`, `/ready`, and static asset routes are exempt — the global rate limiter is mounted after them in `app.js`.

## Architecture Overview

```
                      ┌──────────────────────┐
                      │   TradingView Webhook│
                      │  / External Trigger  │
                      └──────────┬───────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │    Cabros Bot Service   │
                    │  (Express + Middlewares)│
                    └──────┬───────────┬──────┘
                           │           │
           ┌───────────────┘           └───────────────┐
           ▼                                           ▼
┌─────────────────────┐                     ┌─────────────────────┐
│TradingView MCP / AI │                     │ Firestore & BullMQ  │
│Grounding Enrichment │                     │Persistence & Jobs   │
└──────────┬──────────┘                     └──────────┬──────────┘
           │                                           │
           └───────────────────┬───────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │Notification Dispatch│
                    └────┬──────┬──────┬──┘
                         │      │      │
            ┌────────────┘      │      └────────────┐
            ▼                   ▼                   ▼
     ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
     │ Telegram Bot │    │WhatsApp Green│    │Discord Webhk │
     │ (MarkdownV2) │    │  (Shortened) │    │   (Chunks)   │
     └──────────────┘    └──────────────┘    └──────────────┘
```

See [Architecture Guide](docs/deployment.md) and [Notifications Guide](docs/notifications.md) for in-depth pipeline specifications.

---

## License

This project is licensed under the ISC License.
