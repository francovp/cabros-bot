# Cabros Bot

[![Node.js CI](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml/badge.svg)](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](https://github.com/francovp/cabros-bot)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24.18.0%20%3C25-brightgreen.svg)](https://nodejs.org/)

A high-performance crypto, equity, and market intelligence bot service built with Node.js and Express. It connects incoming TradingView alerts and scheduled event monitors with Gemini Grounding, TradingView MCP analysis, and Binance Spot execution, dispatching formatted alerts concurrently across Telegram, WhatsApp, and Discord.

> **New here?** Start with [`docs/PRODUCT.md`](docs/PRODUCT.md) for a human-readable capability map, status legend, and the first-24-hours operator journey. This README is the detailed operator reference.

---

## Core Capabilities

- **Multi-Channel Alert Dispatch**: Broadcast alerts concurrently across Telegram, WhatsApp (GreenAPI), and Discord Webhooks with channel-specific Markdown escaping, URL shortening, independent retries, and dead-letter queue redrive. Operator admin pages fail over to the other configured channels — preferring whichever is actually healthy — when the primary Telegram admin destination cannot be delivered, and `GET /api/status` reports `adminPaging` health so a silent operator path is never mistaken for a working one.
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
| **[Observability & Monitoring](docs/monitoring.md)** | Sentry runtime error monitoring (005), health probes, external uptime monitoring, production smoke probes, structured JSON logging, structured per-request HTTP access logs, and Firestore write/read metrics. |
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

Interactive Swagger documentation is available at `/docs`, and OpenAPI 3.1 schema is published at `/openapi.json`. CI coverage guards (`tests/unit/postman-collection.test.js` and `tests/unit/openapi-contract.test.js`) enforce that every mounted `/api` route appears in both OpenAPI and `CabrosBot.postman_collection.json`, and that every unique endpoint path referenced in README API documentation exists in `src/openapi/openapi.json`.

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
When configuring AI providers, `MODEL_PROVIDER=cloudflare` selects Cloudflare runtime routing, whereas `ENABLE_CLOUDFLARE_AIG` only exposes Cloudflare readiness in status/capabilities. Gemini Grounding provides web search citations and confidence scores for market alerts. See [AI Grounding & Prompts](docs/ai-grounding.md).

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

### Job Queue Mode & Broker Readiness

`JOB_EXECUTION_MODE` selects where async TradingView jobs execute:

| Mode | Behaviour |
| :--- | :--- |
| `local` (default) | Jobs run in-process on the web service. No broker required. |
| `render-worker` | Jobs are enqueued to BullMQ and executed by `worker.js`. Requires `REDIS_URL` **and** durable Firestore job storage. |
| `firestore-poller` | Jobs are claimed directly from Firestore without Redis. Requires durable job storage. |

`GET /api/status` and `GET /api/capabilities` report the queue under `dependencies.jobExecutionQueue`. A bounded, fail-open **broker readiness probe** runs at web startup when `JOB_EXECUTION_MODE=render-worker`, so `brokerReachable` is *proven* connectivity rather than the mere presence of a `REDIS_URL` string:

| `status` | Meaning | Operator action |
| :--- | :--- | :--- |
| `disabled` | Queue mode is off (`local`). | Nothing. |
| `misconfigured` | `render-worker` without `REDIS_URL`. | Set `REDIS_URL`. Job creation returns `503 JOB_QUEUE_UNAVAILABLE`. |
| `not_started` | No probe has run yet. **Not evidence of health.** | Re-check; a fresh process reports this until its probe settles. |
| `unreachable` | The probe ran and the broker did not answer in time. | Broker is down, misconfigured, or still provisioning. |
| `ready` | A probe has proven connectivity. | Cutover is validated. |

`configured` only string-checks `REDIS_URL`; do not read it as health. Read `status` / `brokerReachable` instead.

**Cutover runbook** (the `render-worker` switch is deliberately an operator step, not an automatic one):

1. Provision the Key Value broker — `render.yaml` declares `cabros-crypto-bot-telegram-queue` on a **paid** `starter` plan, so this requires billing approval.
2. Confirm the jobs worker is deployed: `cabros-crypto-bot-telegram-worker` (`JOB_EXECUTION_MODE=render-worker`).
3. Set `JOB_EXECUTION_MODE=render-worker` on the **web** service and redeploy it.
4. Verify before sending any job traffic:

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" \
  "$BASE_URL/api/capabilities" \
  | jq '{flag: .featureFlags.jobExecutionWorker, dep: .dependencies.jobExecutionQueue | {mode, status, brokerReachable}}'
# Expected: flag true, mode "render-worker", status "ready", brokerReachable true
```

If `status` is `unreachable`, roll the web service back to `local` first — in `render-worker` mode job creation fails closed with `503 JOB_QUEUE_UNAVAILABLE` while the broker is down.

| Variable | Default | Bounds | Purpose |
| :--- | :--- | :--- | :--- |
| `JOB_QUEUE_ATTEMPTS` | `5` | `1`–`20` | BullMQ delivery attempts per job. |
| `JOB_QUEUE_BACKOFF_MS` | `30000` | positive | Exponential backoff base between attempts. |
| `JOB_QUEUE_CONCURRENCY` | `1` | `1`–`20` | Jobs the worker processes in parallel. |
| `JOB_QUEUE_CLAIM_LEASE_MS` | `60000` | positive | Durable claim lease held by an executing worker. |
| `JOB_QUEUE_CONNECT_TIMEOUT_MS` | `5000` | positive | Broker connect timeout for the queue connection. |
| `JOB_QUEUE_PROBE_TIMEOUT_MS` | `5000` | `1`–`120000` | Startup readiness-probe deadline. Environment-only — a safety deadline, excluded from Firebase Remote Config. |

### Signal Outcome Single-Evaluator Guarantee

`ENABLE_SIGNAL_OUTCOME_TRACKING=true` is enabled in production. It gates three things at once — recording signals on the alert path, the evaluation sweep, and the whole `/api/outcomes` surface — so it is pinned in `render.yaml` rather than left to the Render dashboard, where an operator reading the repo could not tell which process was actually enabled.

The production topology names **two** candidate evaluators: the web service (`SIGNAL_OUTCOME_WORKER_ROLE=web`) and the paid dedicated worker `cabros-crypto-bot-signal-outcome-worker` (`SIGNAL_OUTCOME_WORKER_ROLE=worker`). `startWorker()` only compares a process's own role, so role gating alone does not stop both from sweeping. `SignalOutcomeService` therefore claims the sweep with a Firestore lease in `signalOutcomeLocks`:

- **One evaluator wins.** The replica that loses the claim skips with `reason: "lease-held"` and issues **no** market-data calls, so a pending signal is never priced and written twice — which would double Binance / Gemini / Twelve Data quota spend. Ownership is re-checked while the sweep runs, and a renewal that proves the lease was taken over mid-sweep **halts** the sweep before the next document. An expired lease is taken over rather than skipped forever.
- **The lease fails open.** If Firestore is unavailable or the lease write cannot be attempted, the sweep proceeds exactly as before. A lock-service blip must never be able to silently stop outcome evaluation. Only *proven* ownership loss stops a sweep.
- **It is observable.** `dependencies.signalOutcomeWorker` reports `leaseMs`, `lastRunLeaseHeld` and `leaseHeldSkipCount`, so `leaseHeldSkipCount` climbing on one replica while the other reports `lastRunEvaluatedCount` growth identifies the active evaluator without guessing from the dashboard. Both counters are also rendered on the `/admin` Status explorer card.

Verify the rollout on the deployed service rather than trusting the flag:

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" \
  https://cabros-crypto-bot-telegram.onrender.com/api/capabilities \
  | jq '{flag: .featureFlags.signalOutcomeTracking,
         enabled: .dependencies.signalOutcomeWorker.enabled,
         role: .dependencies.signalOutcomeWorker.role,
         running: .dependencies.signalOutcomeWorker.running,
         lastRunAt: .dependencies.signalOutcomeWorker.lastRunAt,
         leaseHeldSkips: .dependencies.signalOutcomeWorker.leaseHeldSkipCount}'
```

`lastRunAt` advancing with a non-zero `lastRunEvaluatedCount` is the evidence that the sweep actually ran. The flag alone proves nothing: it reports what was configured, not what executed.

| Variable | Default | Bounds | Purpose |
| :--- | :--- | :--- | :--- |
| `ENABLE_SIGNAL_OUTCOME_TRACKING` | `false` | — | Master gate for recording, sweeping and `/api/outcomes`. Environment-only. |
| `SIGNAL_OUTCOME_WORKER_ROLE` | `web` | `web`/`worker`/`disabled` | Which entrypoint may start the sweep. Environment-only. |
| `SIGNAL_OUTCOME_EVALUATION_LEASE_MS` | `120000` | `10000`–`600000` | Distributed sweep lease duration. Environment-only. |

### Langfuse Dynamic Prompt Readiness

`ENABLE_LANGFUSE_PROMPTS=true` is enabled in production by `render.yaml` on the web service and on the jobs worker (which starts the news-monitor and alert schedulers and therefore resolves the same prompts). Previews keep it off, so a throwaway PR deploy cannot publish traces against the production Langfuse project or spend its quota. The credentials are `sync: false` and must be set in the Render dashboard for each service.

Setting the flag is **necessary but not sufficient**. `PromptService` **fails open to the local prompt file** on any remote failure, which is what keeps alert delivery alive — and it also means a deployment where every alert silently resolves locally looks exactly like a healthy one. `dependencies.langfuse.configured` reflects credential *shape* only; a typo'd, revoked, or wrong-project key passes it. So `ready` requires an observed successful prompt resolution instead:

| `status` | Meaning |
| :--- | :--- |
| `disabled` | `ENABLE_LANGFUSE_PROMPTS` is not `true`. Local prompts are the configured intent, not a fallback. |
| `misconfigured` | Enabled, but a Langfuse credential is missing or blank. |
| `unverified` | Configured, but no prompt has resolved yet. Not a failure — and not health. |
| `ready` | At least one managed prompt has actually resolved from Langfuse. |
| `degraded` | A resolution failed and the local file was used instead. `lastErrorReason` names the class. |

`lastErrorReason` is a **closed enum** (`langfuse_not_configured`, `langfuse_client_unavailable`, `langfuse_auth_failed`, `langfuse_prompt_not_found`, `langfuse_timeout`, `langfuse_invalid_response`, `langfuse_unavailable`) because a Langfuse error body can embed the project id, base URL, and API key; an unrecognized failure collapses to `langfuse_unavailable` and raw provider text never reaches the response. Only the `LANGFUSE_BASE_URL` **host** is reported, never the credentials.

Three counters answer the question the flag cannot:

- **`localFallbackCount`** — how many resolutions used the local file *while the gate was on*. It is always `0` while the gate is off. This is the number that proves the enablement is actually doing something; `localFallbackByPrompt` shows which prompts are behind.
- **`byPrompt[].langfuse` / `.local` / `.lastVersion`** — per-prompt provenance, so a *partial* rollout is visible and you can see which Langfuse prompt version an alert actually used.
- **`consecutiveFailures`** — cleared by the next success, so publishing the missing label mid-incident self-heals without a restart.

Unlike equity market data, this feature **does** have a bounded startup probe (5s, `unref`'d, fail-open, non-blocking) that resolves every registered prompt once. Without it an idle deployment would stay `unverified` indefinitely and could not distinguish working prompts from the dominant failure mode of this enablement: valid credentials paired with a `production` label that was never published, so every fetch 404s and every alert falls back to the local file forever.

Verify the rollout on the deployed service rather than trusting the flag:

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" \
  https://cabros-crypto-bot-telegram.onrender.com/api/capabilities \
  | jq '{flag: .featureFlags.langfusePrompts,
         dep: .dependencies.langfuse | {status, ready, label, promptsSucceeded,
                                         localFallbackCount, lastErrorReason,
                                         fallingBack: .localFallbackByPrompt}}'
```

`status: "ready"` with a non-zero `promptsSucceeded` and an empty `fallingBack` map is the evidence the managed prompts are live. `status: "unverified"` right after a deploy is expected until the probe settles.

**`schemaDrift` is a rollout signal, not a failure.** A Langfuse `alert-enrichment` prompt that has not been republished after a local-fallback contract change (for example the #1031 reference anchors) is reported under `dependencies.langfuse.schemaDrift` with the missing markers listed. Use the [`langfuse-prompt-sync`](.agents/skills/langfuse-prompt-sync/SKILL.md) skill to publish. `promptProvenance` on each stored enriched alert carries the same signal per record.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `ENABLE_LANGFUSE_PROMPTS` | `false` (`render.yaml`: `true` on web + jobs worker) | Master gate for Langfuse prompt resolution. Environment-only — a process-startup gate. |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | Project credentials. **Secrets**: Render dashboard only, never a checked-in file. |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | Region or self-hosted host. Environment-only — an external destination. |
| `LANGFUSE_PROMPT_LABEL` | `production` in prod-like envs, `latest` elsewhere | Which label to fetch. Environment-only. |
| `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` | `0` for `latest`, `60` otherwise (`render.yaml` pins `300`) | Langfuse SDK prompt cache TTL. Environment-only. |

All five are **environment-only** for Remote Config parity: credentials are secrets, `LANGFUSE_BASE_URL` is an external destination, and the gate and label are resolved once at startup.

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

### Durable Webhook Idempotency
`ENABLE_FIRESTORE_IDEMPOTENCY=true` is enabled in production, so TradingView replays are suppressed across process restarts and replicas instead of re-delivering alerts and re-paying MCP/Gemini budget. Reservations and cached responses live in the server-side-only `idempotency_keys` collection under a SHA-256 hash of the key — the raw caller key is never stored or logged — and each reservation carries a `claimToken` so a late completion cannot overwrite a newer owner's record.

Setting the variable is **necessary but not sufficient**, because this layer is fail-open: every Firestore error is swallowed and the request continues with in-memory idempotency. A deployment that cannot reach Firestore therefore behaves exactly as it did before the flag existed, so `dependencies.idempotencyStorage` reports observed work rather than credential shape:

| `status` | Meaning |
| :--- | :--- |
| `disabled` | `ENABLE_FIRESTORE_IDEMPOTENCY` is not `true`. |
| `misconfigured` | Enabled, but Firestore credentials are absent or unreadable. |
| `unverified` | Configured, but no durable operation has succeeded yet. Not a failure — and not health. It is the normal state right after every deploy. |
| `ready` | A durable reservation has actually been persisted. |
| `degraded` | Falling back to in-memory idempotency. `lastErrorReason` names the class. |

`mode`/`backend` keep reporting configured *intent* (`durable`/`firestore`) so the target stays visible while broken, and `failOpen` is always `true`: a degraded deployment still delivers alerts, it just cannot suppress a duplicate after a restart or across replicas. `consecutiveFailures` clears on the next success, so a transient outage self-heals without a restart. Counters are process-local and a status read never counts as a durable attempt.

`expiresAt` on each document is only honoured once Firestore's TTL policy exists, so run `bash ops/configure-operational-collection-retention.sh` once per Firebase project; until then the collection grows without bound. Rollback is `false` plus a redeploy — no code change. See [Environment Configuration](docs/environment-configuration.md#verifying-idempotency-storage-is-actually-durable).

### Durable News-Monitor Analysis Records

`ENABLE_FIRESTORE_NEWS_ANALYSIS=true` is enabled in production by `render.yaml` on the **web service only** (previews off), so every analyzed symbol is recorded in the `news_analysis` collection and `GET /api/news-monitor/analyses` and `GET /api/news-monitor/summary` have an audit trail to read. Previews stay off because a PR preview shares the production Firestore project.

Setting the flag is **necessary but not sufficient**. Every Firestore error in this service is swallowed so news alert delivery is never blocked, which means a deployment that cannot reach Firestore behaves exactly as it did before the flag existed. `dependencies.newsAnalysisStorage` therefore reports observed work rather than credential shape:

| `status` | Meaning |
| :--- | :--- |
| `disabled` | `ENABLE_FIRESTORE_NEWS_ANALYSIS` is not `true`. |
| `misconfigured` | Enabled, but Firestore credentials are absent or refused (for example an inline `authorized_user` document, which #1128 refuses rather than silently authenticating as something else). |
| `unverified` | Configured, but no analysis has been recorded or read yet. Not a failure — and not health. It is the normal state right after every deploy. |
| `ready` | A durable write or read has actually succeeded. |
| `degraded` | A durable operation failed and nothing has answered since. `lastErrorReason` names the class and `lastMissingIndex` flags a rejected query. |

`mode`/`backend` keep reporting configured **intent** (`durable`/`firestore`) even after a failure, because `memory` would read as the flag being off. `failOpen` is always `true`: a `degraded` verdict still delivers news alerts, it just stops recording them. Counters are process-local and reset on restart.

Verify the rollout on the deployed service rather than trusting the flag:

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" https://<host>/api/capabilities \
  | jq '{flag: .featureFlags.firestoreNewsAnalysis,
         dep: .dependencies.newsAnalysisStorage | {status, ready, mode, backend,
                                                  operationsSucceeded, lastErrorReason,
                                                  lastMissingIndex}}'
```

`operationsSucceeded` climbing with a non-zero count is the evidence that analysis records are actually landing. The flag alone proves nothing: it reports what was configured.

**Two deployment prerequisites are not code steps.** A merged change is not a working feature until both are done:

1. **Deploy the composite indexes.** `firestore.indexes.json` declares three `news_analysis` composites (`{symbol, createdAt}`, `{eventCategory, createdAt}`, `{symbol, eventCategory, createdAt}`) because Firestore never merges single-field indexes, so an equality filter plus a sort on `createdAt` needs an explicit composite. Run `firebase deploy --only firestore:indexes`; indexes build asynchronously and the query is rejected until the build reaches `READY`. A rejection surfaces as `503 STORAGE_UNAVAILABLE` with `lastMissingIndex: true` — **neither the unit suite (the Firestore double makes `orderBy` a no-op) nor the emulator (which auto-creates indexes) can catch a missing declaration**, so it is asserted at the source level in `tests/unit/news-analysis-storage.test.js`.
2. **Enable TTL deletion.** `expiresAt` is only honoured once the policy exists, and TTL deletion is eventually consistent and only removes already-expired documents. Run `bash ops/configure-operational-collection-retention.sh` once per project, otherwise the collection grows without bound.

**The gate is environment-only, and that is deliberate.** It is deliberately absent from `firebase-remote-config-template.json`. A template parameter's `defaultValue` is reported by the Admin SDK with source `remote`, so a published `"false"` entry would override `render.yaml` and silently re-disable persistence the first time a Remote Config load succeeded — a fix that reads as applied and does nothing. `NEWS_ANALYSIS_RETENTION_DAYS` is the genuine runtime knob and stays remote-config eligible.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `ENABLE_FIRESTORE_NEWS_ANALYSIS` | `false` (`render.yaml`: `true` on web, previews off) | Master gate for recording and for the two read endpoints. Environment-only. |
| `NEWS_ANALYSIS_RETENTION_DAYS` | `30` | Days before a record expires (`1`–`365`). Remote Config eligible. |

### Symbol Analysis Persistence
`ENABLE_SYMBOL_ANALYSIS_STORAGE=true` is enabled in production, so `/api/webhook/symbol-analysis` results are persisted to the `symbolAnalyses` collection and readable from `/api/symbol-analyses` for operator review and outcome correlation. The flag is declared on the **web service only**, with previews off: the single writer is the HTTP route layer in `src/controllers/webhooks/handlers/symbolAnalysis/symbolAnalysis.js`, `worker.js` never mounts routes, and previews share the production Firestore project — a preview would write throwaway rows into the collection operators read.

Setting the variable is **necessary but not sufficient**, because this layer is fail-open: every Firestore error is swallowed, the record is dropped, and the analysis still returns `200`. A deployment that cannot reach Firestore therefore behaves exactly as it did before the flag existed, so `dependencies.symbolAnalysisStorage` reports observed work rather than credential shape:

| `status` | Meaning | Operator action |
| :--- | :--- | :--- |
| `disabled` | `ENABLE_SYMBOL_ANALYSIS_STORAGE` is not `true`. | Nothing. |
| `misconfigured` | Enabled, but Firestore credentials are absent or unreadable. | Check `FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS`. |
| `unverified` | Configured, but no write has landed yet. Not a failure — and not health. It is the normal state right after every deploy. | Send one symbol analysis, then re-check. |
| `ready` | An analysis has actually been persisted (`writesSucceeded >= 1`). | Nothing. |
| `degraded` | A durable write failed while the analysis still returned. `lastErrorReason` names the class. | Investigate Firestore reachability. |

**A successful read is not evidence of persistence.** Read and write counters are reported separately (`writesAttempted`, `writesSucceeded`, `writesFailed`, `readsAttempted`, `readsSucceeded`, `readsFailed`); a non-zero `readsSucceeded` proves Firestore reachability only and never sets `ready`. Persistence is the feature, so only a write proves the enablement took effect. A rejected Firebase initialization is charged to the operation that triggered it, so browsing `/api/symbol-analyses` moves `readsAttempted`/`readsFailed` and leaves the write counters at zero — `writesFailed: 1` therefore always means a real write was attempted. `failOpen` is always `true`, and `consecutiveFailures` clears on the next successful Firestore operation, so a transient outage self-heals without a restart. Counters are process-local and a status read never counts as a durable attempt, so polling `/api/status` cannot manufacture a `ready` verdict.

Verify the rollout on the deployed service, then prove it by persisting one analysis:

```bash
BASE_URL=https://cabros-crypto-bot-telegram.onrender.com

# 1. The gate is on and Firestore credentials are shaped correctly.
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$BASE_URL/api/capabilities" \
  | jq '{flag: .featureFlags.symbolAnalysisStorage,
         status: .dependencies.symbolAnalysisStorage.status,
         writes: .dependencies.symbolAnalysisStorage.writesSucceeded,
         templatePublished: .dependencies.firebaseRemoteConfig.templatePublished,
         configSource: .dependencies.firebaseRemoteConfig.source}'
# Expected right after deploy: flag true, status "unverified", writes 0.
# If flag is false, check templatePublished first: a published template that
# disagrees with render.yaml is what silently overrides the blueprint.

# 2. Persist one analysis, then re-check.
curl -s -X POST -H "x-api-key: $WEBHOOK_API_KEY" -H 'Content-Type: application/json' \
  -d '{"symbol":"BINANCE:BTCUSDT"}' "$BASE_URL/api/webhook/symbol-analysis" >/dev/null

curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$BASE_URL/api/capabilities" \
  | jq '{status: .dependencies.symbolAnalysisStorage.status,
         writes: .dependencies.symbolAnalysisStorage.writesSucceeded,
         lastWriteAt: .dependencies.symbolAnalysisStorage.lastWriteAt}'
# Expected: status "ready", writes >= 1, lastWriteAt set
```

`lastWriteAt` advancing with a non-zero `writesSucceeded` is the evidence that the enablement actually took effect. The flag alone proves nothing: it reports what was configured, not what executed.

**Prerequisite — TTL on `symbolAnalyses`.** Every document carries `expiresAt`, but Firestore only deletes on it once the TTL policy exists, and TTL deletion is eventually consistent (~24 h). Run `bash ops/configure-operational-collection-retention.sh` once per Firebase project — it already covers the `symbolAnalyses` collection group — or the collection grows without bound. This is a deployment step, not something the repository can apply for you. Rollback is `false` plus a redeploy; already-stored documents are left for TTL deletion. See [Environment Configuration](docs/environment-configuration.md#verifying-symbol-analysis-persistence-is-actually-working).

| Variable | Default | Bounds | Purpose |
| :--- | :--- | :--- | :--- |
| `ENABLE_SYMBOL_ANALYSIS_STORAGE` | `false` | — | Persist symbol analyses to Firestore. Environment-only. |
| `SYMBOL_ANALYSIS_RETENTION_DAYS` | `7` | `1`–`365` | TTL horizon for stored analyses. Environment-only. |

Both are classified **environment-only** for Firebase Remote Config parity: a process-startup gate that decides where a collection lives, and a retention horizon, are not runtime tuning knobs. Neither is in `RemoteConfigService.js` `PARAMETER_SCHEMA` nor in `firebase-remote-config-template.json`, so `render.yaml` is the only place either value comes from — matching `ENABLE_FIRESTORE_IDEMPOTENCY`, `ENABLE_FIRESTORE_SCANNER_PRESETS` and `ENABLE_SIGNAL_OUTCOME_TRACKING`.

**This matters because a published template outranks `render.yaml`.** Any allow-listed key present in `firebase-remote-config-template.json` beats `process.env` at runtime (`getRemoteValue()` accepts a plain `defaultValue` from the template, not just a targeted condition), so an allow-listed gate whose template value disagrees with the blueprint reports the blueprint's value in `/api/capabilities` while the template keeps the feature off. `tests/unit/remote-config-service.test.js` now fails if the two ever disagree for a shared key. When triaging a flag that is `true` in the blueprint but reports `false` in production, check `dependencies.firebaseRemoteConfig.templatePublished` first — a published template is the usual cause, and the `Deploy Firebase Remote Config Server Template` workflow is the only thing that changes it.

### External Uptime Monitoring

Production liveness is checked from **outside** the deployment. `.github/workflows/external-uptime-monitor.yml` probes the public `GET /healthcheck` every 5 minutes from GitHub Actions using `ops/external-uptime-monitor.js`; `.github/workflows/external-uptime-watchdog.yml` asserts the monitor itself is still being scheduled. `/healthcheck` is mounted before `validateApiKey`, so the monitor needs **no API key** — which is deliberate, since a monitor that silently no-ops because a secret was never provisioned is what hid the six-day platform-side outage in issue #1107.

Configure it with the repository variables `UPTIME_MONITOR_BASE_URL`, `UPTIME_MONITOR_CHECK_DOCS`, `UPTIME_MONITOR_TIMEOUT_MS`, and `UPTIME_WATCHDOG_MAX_AGE_MINUTES`; optionally add the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` secrets to page on a down/recovery transition. A non-zero probe exit fails the workflow, which is GitHub's own zero-configuration alert channel. Run `pnpm run uptime:monitor --no-page` to reproduce the verdict locally.

**Any platform or host change must update `UPTIME_MONITOR_BASE_URL` and re-register the third-party uptime monitor** — see the platform migration re-activation checklist in [Observability & Monitoring](docs/monitoring.md#external-uptime-monitoring).

### Production Enablement Verification

The secretless monitor above proves only that *something* answers `/healthcheck`. A build months behind `master` answers 200 perfectly, so liveness alone cannot tell you that production is actually running your latest code or that a feature you declared enabled is enabled.

The authenticated layer is `ops/production-smoke-probe.sh`, run every 15 minutes by `.github/workflows/production-smoke-probe.yml`. It asserts `service.commit` equals the latest `master` SHA (exit `5` on a stale deploy), that named dependencies are `ready` (exit `6`), and — with `PRODUCTION_REQUIRE_ENABLED_FLAGS` — that named `featureFlags` are `true` (exit `7`, `FLAG_DISABLED`).

**A flag absent from the deployed build counts as disabled.** The comparison demands the literal string `true`, so an absent key cannot satisfy it and a stale build cannot look compliant — the same shape-is-not-readiness trap this repository has hit repeatedly. The jq default (`// false`) only labels the diagnostic `value=false`; it is not the enforcement point. That distinction matters because a `render.yaml` `value: true` is a *declaration of intent* and production reality is a separate fact — which is how `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT` was declared `true` in the Blueprint while production reported `false` (issue #1109).

Set the `PRODUCTION_REQUIRE_ENABLED_FLAGS` repository variable to a comma-separated flag list; it defaults to empty, so it adds no failure mode until you enable it. Every failure message ends with `(probed <base_url>)`, so a misconfigured target is never mistaken for a real outage. See [Observability & Monitoring](docs/monitoring.md#production-smoke-probe).

### TradingView Confluence Enrichment

`ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true` and `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true` are declared `true` in `render.yaml` on the **web service only** (previews off) — and production is **not** yet running them: as of this writing `featureFlags.tradingViewConfluenceEnrichment` reports `false` live (issue #1109), because the enablement needs a Blueprint apply plus a redeploy onto a current build, and `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME` is inert while its parent gate is off. Treat the Blueprint entry as intent and `/api/status` as reality; the check above is how you tell them apart. Together the flags add an optional `combined_analysis` call to each enriched alert webhook followed by a `multi_timeframe_analysis` call. Both are fail-open: a failure never blocks alert delivery, and it is recorded as a `partial` enrichment rather than a dropped alert.

`ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME` is nested **inside** the confluence gate, so it is inert until confluence enrichment is on — the two flags cannot disagree. Both keys need a web-service declaration in `render.yaml` even though they are only ever read on the web service, because the worker block mirrors them with `fromService` and a mirror whose source is never declared resolves to nothing.

**The enrichment budget decides how much of this actually runs.** `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS` (default `12000`) is the ceiling for the whole webhook enrichment path. Whenever volume confirmation *or* confluence is enabled, the base `coin_analysis` call is reserved 75% of it and the optional calls share what remains — a single split, not a cumulative one, so enabling confluence does not shrink the base slice further when volume confirmation is also on. (Note that `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION` is **not** declared in `render.yaml`, so which slice production actually reserves is not verifiable from the repository; the single-ternary conclusion above is a property of the code and holds either way.) Both confluence calls share one deadline of `min(8000, remaining budget)`, so with the default budget the second (`multi_timeframe_analysis`) call is commonly cut short and the alert is stored as `tradingViewEnrichmentStatus: "partial"`. Raise `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS` (Remote Config eligible, max `120000`) if you want both to complete — but note the webhook request deadline (`REQUEST_TIMEOUT_MS`, default `30000`) bounds the whole request, so the budget cannot usefully exceed it.

Setting the flag is **necessary but not sufficient**, because the layer is fail-open: a confluence call that fails looks identical in delivery terms to one that was never attempted. `dependencies.tradingViewMcp.enrichment.confluence` reports the observed window — `attemptedCount`, `appliedCount`, `failedCount`, `budgetExhaustedCount`, `lastAppliedAt` and a closed-enum `lastFailureCategory`.

**These counters are per *call*, not per alert.** One alert enrichment issues up to two confluence calls (`combined_analysis`, then `multi_timeframe_analysis` when multi-timeframe mode is on), so a single alert can move `attemptedCount` by 2. Every issued call records exactly one outcome, which is what makes `appliedCount + failedCount <= attemptedCount` hold — including the budget-starved case, where `combined_analysis` applied, `multi_timeframe_analysis` failed, and the result is `appliedCount + failedCount == attemptedCount`. `budgetExhaustedCount` counts stages skipped because the budget was already spent, which is *not* a call and therefore not an attempt. Do not read these counters as alert counts or compare them 1:1 against `enrichment.alertPath.totalCount`.

Counters are process-local and reset on restart, so `enabled: true` with every counter at `0` is the expected state right after a deploy. `enrichment.alertPath` remains the aggregate over the whole webhook path and cannot attribute an outcome to confluence specifically.

Verify after the Blueprint is applied:

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" https://<host>/api/capabilities \
  | jq '{flag: .featureFlags.tradingViewConfluenceEnrichment,
         confluence: .dependencies.tradingViewMcp.enrichment.confluence}'
```

### Same-Direction Alert Burst Aggregation

`ENABLE_ALERT_SYNTH_BURST_AGGREGATION=true` buffers a parsed TradingView signal for `ALERT_BURST_WINDOW_MS` and collapses alerts sharing a direction **and** identical routing into one "⚡ Regime shift" message per channel, so a market-wide move reads as one event instead of N×channels messages. Grouping is by direction, not by exchange, because a risk-on or risk-off shift spans asset classes at the same instant; each symbol's exchange and timeframe are listed in the message.

Every constituent alert is still persisted with the shared `burstAggregateId`, so `/api/alerts` analytics and signal outcomes stay per-symbol, and each response reports `aggregated: true`, the shared `burstAggregateId`, `burstSignalCount`, and the aggregate `results`/`deliveredChannels`.

Aggregation is fail-open by design: a window that closes below `ALERT_BURST_MIN_SIGNALS`, a store error, a failed aggregate dispatch, and shutdown mid-window all deliver the held alerts individually, and a `symbolRoutes` request or unparsed text is never buffered at all. It can cost noise reduction, never an alert.

`dependencies.alertBurstAggregation` reports `windowMs`, `minSignals`, `openWindows`, `aggregatedBurstCount`, `aggregatedSignalCount`, `aggregatedFailoverCount`, `releasedSignalCount`, `lastAggregatedAt` and `lastWindowClosedAt`. Counters are process-local, so all zeros with `enabled: true` is expected right after a deploy.

| Variable | Default | Bounds | Purpose |
| :--- | :--- | :--- | :--- |
| `ENABLE_ALERT_SYNTH_BURST_AGGREGATION` | `false` | — | Master gate. Remote Config eligible. |
| `ALERT_BURST_WINDOW_MS` | `3000` | `1000`–`15000` | Buffered window; also the maximum latency added to a parsed alert. Remote Config eligible. |
| `ALERT_BURST_MIN_SIGNALS` | `3` | `2`–`20` | Minimum same-direction signals required to send one aggregate message. Remote Config eligible. |

The window is **leading-edge**, so the added latency is exactly `ALERT_BURST_WINDOW_MS` and can never grow under an alert storm. The trade-off is that a burst wider than the window splits: on the two production bursts behind this feature the 2.3s burst collapses at the default while the ~10s burst needs `ALERT_BURST_WINDOW_MS` raised toward its maximum to collapse as a single message. See [Webhook Alerts](docs/webhooks.md#same-direction-burst-aggregation).

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
