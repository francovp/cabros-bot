# Cabros Bot

[![Node.js CI](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml/badge.svg)](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](https://github.com/francovp/cabros-bot)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24.18.0%20%3C25-brightgreen.svg)](https://nodejs.org/)

A high-performance crypto, equity, and market intelligence bot service built with Node.js and Express. It connects incoming TradingView alerts and scheduled event monitors with Gemini Grounding, TradingView MCP analysis, and Binance Spot execution, dispatching formatted alerts concurrently across Telegram, WhatsApp, and Discord.

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
| **[Stored Alerts API](docs/alerts.md)** | Stored alert query, cursor pagination, JSON/CSV export, analytics summary, user feedback, and safe replay mechanics. |
| **[Signal Outcomes Tracking](docs/signal-outcomes.md)** | Signal outcome lifecycle (CB-199), evaluation windows (1h, 4h, 1D, 1W), MFE/MAE excursions, and calibration API. |
| **[TradingView MCP Integration](docs/tradingview-mcp.md)** | Streamable HTTP endpoint setup, symbol resolution, timeframe mapping, and multi-timeframe technical confluence. |
| **[AI Grounding & Prompts](docs/ai-grounding.md)** | Gemini Grounding (001), enrichment flow, token spend tracking, and Langfuse prompt management. |
| **[Multi-Channel Alerts](docs/notifications.md)** | Multi-channel delivery rules (Telegram, WhatsApp, Discord), MarkdownV2 escaping, URL shortening, and dead-letter redrive. |
| **[Telegram Commands](docs/commands.md)** | Interactive bot commands (`/help`, `/precio`, `/cryptobot`, `/analisis`, `/scanner`, `/jobs`, `/noticias`), throttling, and forum topic routing. |
| **[News Monitoring](docs/news-monitor.md)** | Event detection engine, confidence scoring, persistent deduplication, secondary LLM refinement, and volume throttling. |
| **[Observability & Monitoring](docs/monitoring.md)** | Sentry runtime error monitoring (005), health probes, production smoke probes, structured JSON logging, and Firestore write metrics. |
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

<<<<<<< HEAD
## API Endpoints

The canonical API contract is served publicly at [`/openapi.json`](http://localhost:80/openapi.json), with interactive Swagger UI at [`/docs`](http://localhost:80/docs). Use those endpoints for request schemas, response shapes, examples, and the current route inventory. Protected `/api` operations still require `x-api-key`; the documentation endpoints never expose configured credentials.

### GET /healthcheck

Health check endpoint.

**Response:**
```json
{"uptime":"..."}
```

### GET /ready

Public bootstrap-readiness endpoint for deployment traffic cutover. It returns `503` while startup is pending or failed, and `200` only after the required bootstrap components are ready. Telegram is `disabled` when the bot is disabled or the environment is a preview; the news monitor is `disabled` when it is not enabled. Readiness checks bootstrap completion only and does not continuously ping external providers, avoiding restart loops caused by transient dependency outages.

Configure the deployment platform health check to use `/ready` (`healthCheckPath` in `render.yaml`; Railway's service healthcheck path should use the same value). Keep `/healthcheck` for process liveness.

The protected `/api/status` response includes the same non-sensitive state under `readiness`.

**Ready response:**
```json
{
  "status": "ready",
  "ready": true,
  "components": {
    "telegramBot": { "status": "disabled" },
    "notificationServices": { "status": "ready" },
    "newsMonitor": { "status": "disabled" }
  }
}
```

Pending and failed bootstrap states use the same body shape with HTTP `503`; failed responses include a sanitized `error` message.

### GET /api/status

Machine-readable runtime status for operational tooling. This endpoint uses the same `WEBHOOK_API_KEY` protection as other `/api` endpoints when that environment variable is configured. Send the key with the `x-api-key` header.

The response intentionally exposes only non-sensitive booleans and metadata: service identity, version, commit, environment, feature-flag state, delivery channel readiness, and dependency readiness/configuration status. Secret values such as bot tokens, API keys, DSNs, chat IDs, and provider URLs are not returned.

For `ENABLE_NEWS_MONITOR=true`, the payload also reports the primary LLM dependency used by that flow as `dependencies.newsMonitorLlm`, including the resolved provider (`gemini`, `azure`, or `openrouter`) and whether that provider is actually configured for runtime use. When `FORCE_BRAVE_SEARCH=true`, the payload also exposes `dependencies.braveSearch` so the forced search path can be monitored independently of Gemini. When `ENABLE_GEMINI_GROUNDING=true` and `MODEL_PROVIDER=gemini`, `dependencies.gemini` requires both `GEMINI_API_KEY` and `GEMINI_MODEL_NAME`, matching the runtime path used for grounded alert generation. `dependencies.geminiQuota` reports whether a Gemini quota cooldown is active, bounded remaining cooldown duration, trigger counters, Brave search fallback events during cooldown, and grounding request telemetry counters (`totalRequests`, `successRequests`, `failureRequests`, `timeoutRequests`) without exposing prompts, error bodies, or provider credentials. `dependencies.groundingCoalescing` reports the bounded equity-alert search sharing window and hit/miss/failure counters. Firestore readiness treats `GOOGLE_APPLICATION_CREDENTIALS` as configured only when the referenced credential file exists and is readable.

When `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`, `featureFlags.tradingViewVolumeConfirmation` reports the gate value and `dependencies.tradingViewVolumeConfirmation` reports readiness only when the configured TradingView MCP endpoint and its parent MCP enrichment gate are active.

TradingView dependency readiness is runtime-derived and fail-open: `configured` reflects the effective endpoint, while `status` starts as `unknown` and changes to `ready` or `degraded` after an MCP operation. `lastErrorCategory` is sanitized to categories such as `timeout`, `http_5xx`, `http_4xx`, `invalid_response`, or `request_failed`; provider response bodies and URLs are never returned by `/api/status`.

When `ENABLE_FIRESTORE_JOB_STORAGE=true`, `featureFlags.firestoreJobStorage` reports the async-job persistence gate and `dependencies.firestoreJobStorage` reports readiness using the configured Firestore credentials. The legacy `ENABLE_FIRESTORE_ALERT_STORAGE=true` gate also reports job storage as enabled because it activates the same runtime persistence path.

`featureFlags.newsMonitorTestMode` reports `ENABLE_NEWS_MONITOR_TEST_MODE` without changing the news monitor's existing test-mode behavior.

`featureFlags.messageFooterMetadata` reports the `ENABLE_MESSAGE_FOOTER_METADATA` setting. It defaults to `true` and is disabled only when the environment variable is explicitly set to `false`.

When `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION=true`, `/api/webhook/alert` suppresses duplicate channel delivery for the same `(exchange, symbol, timeframe, side)` signal within a cooldown window of `ALERT_SIGNAL_COOLDOWN_BARS` bars (default `1`). Suppressed requests still return 200 with `suppressedRepeat: true`, empty `results`/`deliveredChannels`, and remain persisted with a suppression marker so replay and audit stay complete. Opposite-side flips always deliver; storage failures fail open to normal delivery. `featureFlags.alertSignalRepeatSuppression` reports the gate and `dependencies.alertSignalRepeatSuppression` exposes non-sensitive counters (`suppressedCount`, `lastSuppressedAt`, `activeTrackedSignals`).

`featureFlags.cloudflareAig` reports `ENABLE_CLOUDFLARE_AIG`, while `dependencies.cloudflareAig` reports whether the Cloudflare AI Gateway credentials are configured and ready. Runtime provider selection is controlled separately by `MODEL_PROVIDER=cloudflare`; set both values when status/capability telemetry should match active Cloudflare routing.

When `ENABLE_EQUITY_MARKET_DATA=true`, `dependencies.equityMarketData` reports Twelve Data readiness and the supported `BATS`/`NASDAQ`/`NYSE`/`AMEX`/`NYSE ARCA`/`FX_IDC`/`SPCFD` exchanges without exposing the API key. Signal outcome tracking uses `/quote` for missing entry prices and `/time_series` for bounded historical bars; provider, timeout, malformed-data, and quota failures mark equity outcomes unavailable without blocking alert delivery. Extended-hours data is excluded by default. Confirm current Twelve Data plan limits and licensing before production use: [pricing](https://twelvedata.com/pricing), [US equities coverage](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data), and [commercial usage](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage).
`dependencies.signalOutcomeWorker` reports the scheduler role, shutdown state, cadence/budgets, and the last-sweep heartbeat counters (`lastRunAt`, scanned, pending, evaluated, and error counts). The `worker` role is intended for the dedicated Render service; set the web service role to `disabled` during cutover so only one scheduler is active. A disabled local scheduler reports `ready: false` and `status: "disabled"` because it is not the process evaluating outcomes.

The dedicated worker also persists the same non-sensitive heartbeat to `workerHeartbeats/signal-outcome` in Firestore. Heartbeat writes fail open and never block alert delivery.
`featureFlags.firebaseRemoteConfig` reports `ENABLE_FIREBASE_REMOTE_CONFIG`. This is server-side Remote Config: the Firebase Admin SDK loads the published template with `initServerTemplate()`, while no Firebase Web/Client SDK configuration is involved. `dependencies.firebaseRemoteConfig` exposes only `enabled`, `configured`, `ready` (true only after a successful, fresh template load), `status` (`ready`, `degraded`, `unknown`, `misconfigured`, or `disabled`), `source` (`remote`, `environment`, `default`, or `disabled`), `templateVersion`, `lastSuccessfulLoad`, `lastErrorCategory`, `consecutiveFailures`, and bounded loader settings; it never returns remote parameter values or credentials.

`GET /api/capabilities` is an alias for the same payload.

When configured, `featureFlags.binanceTrading` and `dependencies.binanceTrading` expose only the non-sensitive execution gate, selected `testnet`/`demo`/`live` environment, allow-listed symbols, and readiness state.

### Browser admin authentication

`/admin` is public shell content. With `ENABLE_FIREBASE_ADMIN_AUTH=false` (the default), it keeps the existing session-only `WEBHOOK_API_KEY` console flow. With the flag enabled, the shell shows Firebase email/password sign-in, keeps an API-key field only in memory for API-key-only webhook/news-monitor operations, and does not read or write that key to browser storage. `/admin/auth-config` returns only the public Firebase Web configuration needed by the client.

The server verifies Firebase ID tokens with revoked-token checks enabled. Custom claims may use `roles: ["admin.viewer"]`, `roles: ["admin.operator"]`, `adminRole`, `role`, or the equivalent `admin.viewer`/`admin.operator` boolean claims. Viewers can read status, alerts, analytics, exports, scanner presets, and job metadata; operators can perform the existing preset, replay, and job actions. The legacy API-key path remains available for machine clients. Protected webhook and news-monitor routes remain API-key-only.

When Firebase auth is enabled, configure `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for server-side Admin SDK token verification, plus the public browser settings listed above. Do not put service-account JSON or ID tokens in browser config, Postman variables, logs, or client error messages.

The public browser configuration may also include `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_MEASUREMENT_ID`; these values are not service-account credentials.

### Firebase Hosting for Admin Console

The `/admin` console is deployed as a static site on Firebase Hosting for the `cabros-bot` project (`https://cabros-bot.web.app/admin`):

- **Build & Artifacts**: `pnpm run build:hosting` synchronizes static console assets from `src/admin/` to `public/admin/` and generates the root redirect `public/index.html`. `firebase.json` defines the hosting root (`public`), ignore patterns, rewrite rules (`/admin/**` -> `/admin/index.html`), and `no-cache` cache-control headers.
- **Backend API Connectivity**: When hosted on Firebase Hosting (`*.web.app` / `*.firebaseapp.com`), the admin console resolves `https://cabros-bot-production.up.railway.app` by default. `?backend=` and `cabros_backend_origin` overrides are accepted only when their exact origin is the explicit HTTPS allowlist entry `https://cabros-bot-production.up.railway.app`; arbitrary origins, wildcards, HTTP URLs, and malformed values are ignored before any credential-bearing request.
- **CORS & CSP Policy**: Backend CORS permits requests from the explicit allowlist (`https://cabros-bot.web.app`, `https://cabros-bot.firebaseapp.com`, `https://cabros-bot-production.up.railway.app`, `http://localhost:*`, and optional `CORS_ALLOWED_ORIGINS`), and Helmet CSP allows `connect-src` to Google Auth, Firebase Hosting origins, and the backend origin.
- **CI/CD Deployment**: `.github/workflows/firebase-hosting.yml` automatically deploys pull requests to ephemeral Firebase preview channels and deploys the `live` channel on releases merged to `master`.
- **Local Testing**: Run `pnpm run build:hosting` then `firebase emulators:start --only hosting` to test the static hosting deployment locally on port 5000.
- **Rollback**: In the Firebase Console (Hosting > Release history) or via Firebase CLI: `firebase hosting:rollback` / `firebase hosting:clone cabros-bot:previous_version cabros-bot:live`.

.env.example is the canonical operator template. The documentation-alignment test checks static application-owned `process.env` reads against that template; platform-injected values, test-only controls, and deprecated compatibility aliases are explicitly classified instead of being copied into production configuration.

**Response:**
```json
{
  "service": {
    "name": "cabros-bot",
    "version": "0.1.0",
    "commit": "abcdef1234567890",
    "environment": "production"
  },
  "featureFlags": {
    "telegramBot": true,
    "whatsappAlerts": false,
    "geminiGrounding": true,
    "newsMonitor": true,
    "newsMonitorTestMode": false,
    "tradingViewMcpEnrichment": true,
    "tradingViewVolumeConfirmation": false,
    "firestoreAlertStorage": true,
    "firestoreJobStorage": false,
    "sentryMonitoring": true,
    "langfusePrompts": false,
    "marketScanner": true,
    "binancePriceCheck": false,
    "llmAlertEnrichment": false,
    "cloudflareAig": false,
    "messageFooterMetadata": true,
    "equityMarketData": false
  },
  "deliveryChannels": {
    "telegram": { "enabled": true, "status": "ready" },
    "whatsapp": { "enabled": false, "status": "disabled" }
  },
  "dependencies": {
    "telegram": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "whatsapp": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "gemini": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "tradingViewMcp": { "enabled": true, "configured": true, "ready": false, "status": "unknown", "lastCheckedAt": null, "lastSuccessAt": null, "lastFailureAt": null, "lastErrorCategory": null, "successCount": 0, "failureCount": 0, "enrichment": { "alertPath": { "windowMs": 86400000, "totalCount": 0, "appliedCount": 0, "failedCount": 0, "appliedRate24h": 0, "failureRate24h": 0 } } },
    "tradingViewVolumeConfirmation": { "enabled": false, "configured": true, "ready": false, "status": "disabled", "lastCheckedAt": null, "lastSuccessAt": null, "lastFailureAt": null, "lastErrorCategory": null, "successCount": 0, "failureCount": 0 },
    "firestore": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "firestoreJobStorage": { "enabled": false, "configured": true, "ready": false, "status": "disabled" },
    "signalOutcomeWorker": {
      "enabled": false,
      "configured": true,
      "ready": false,
      "status": "disabled",
      "role": "web",
      "running": false,
      "shutdownRequested": false,
      "lastRunScannedCount": 0,
      "lastRunPendingCount": 0,
      "lastRunEvaluatedCount": 0,
      "lastRunErrorCount": 0
    },
    "sentry": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "langfuse": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "braveSearch": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "newsMonitorLlm": { "provider": "gemini", "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "llmAlertEnrichment": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "cloudflareAig": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "equityMarketData": { "provider": null, "enabled": false, "configured": false, "ready": false, "status": "disabled", "supportedExchanges": ["BATS", "NASDAQ", "NYSE", "AMEX", "NYSE ARCA", "FX_IDC", "SPCFD"], "timeoutMs": 5000 }
  }
}
```

## Alert Enrichment with Gemini Grounding (001)

The webhook alert system can optionally enrich alerts with verified sources and market context using Google Gemini API with GoogleSearch grounding.

### MCP Flow

When `ENABLE_GEMINI_GROUNDING=true`:

1. Alert text received via webhook
2. Gemini API queries with GoogleSearch grounding enabled
3. Returns summary and extracted sources (URLs with titles)
4. Enriched alert formatted and sent to all enabled channels (Telegram, WhatsApp)

### Enrichment Features

- **Sentiment Analysis**: Determines market sentiment (BULLISH/BEARISH/NEUTRAL) with confidence score
- **Key Insights**: Extracts bullet points of critical information
- **Technical Levels**: Identifies support and resistance levels mentioned in context
- **Risk Parameters**: Optionally reports invalidation level, target level, setup type, and estimated risk/reward ratio
- **Verified Sources**: Extracts URLs and titles from GoogleSearch results
- **Language Support**: Respects original language of alert text
- **Graceful Fallback**: If enrichment fails, original alert is sent without delays
- **Reusable Results**: Single grounding call shared across all notification channels

### Configuration

- `ENABLE_GEMINI_GROUNDING` - Enable/disable enrichment (default: `false`)
- `GEMINI_API_KEY` - Google API key with Generative AI enabled

### How Langfuse Prompt Management Works

When `ENABLE_LANGFUSE_PROMPTS=true`, runtime prompts are fetched from Langfuse through the centralized prompt service in `src/services/prompts/`.

The local fallback prompts now live as editable text templates under `src/services/prompts/defaults/`, which makes them much easier to review, diff, and version independently from the prompt registry code.

Managed prompts currently include:

- search-query derivation
- grounded summary generation
- webhook alert enrichment
- news analysis
- secondary confidence enrichment
- Gemini market price fetch query

Behavior notes:

- **Fail-open by design**: if Langfuse is disabled, misconfigured, unavailable, or missing a prompt, the app automatically falls back to the local prompt text files in `src/services/prompts/defaults/`.
- **Label-based rollout**: use `LANGFUSE_PROMPT_LABEL` (for example `latest`, `staging`, or `production`) to switch prompt versions without code changes.
- **SDK caching**: prompt fetches use the Langfuse SDK cache and can be tuned with `LANGFUSE_PROMPT_CACHE_TTL_SECONDS`.
- **Current architecture contract**: prompts are compiled into the existing `systemPrompt` / `userPrompt` flow, so provider routing for Gemini, Azure, and OpenRouter remains unchanged.
- **Alert enrichment schema**: Langfuse `alert-enrichment` versions should mirror the local fallback's optional `invalidation_level`, `target_level`, `setup_type`, and `risk_reward_ratio` fields. The prompt service inspects resolved remote prompts against `REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS`, records `schemaDriftDetected: true` and missing risk fields if any are omitted, and warns once per version without failing open delivery.

## TradingView Signal Enrichment with MCP

When `ENABLE_TRADINGVIEW_MCP_ENRICHMENT=true`, webhook alerts matching TradingView-style patterns (for example `BTCUSDT(240) pasó a señal de VENTA`) are enriched with real technical data from the TradingView MCP server **only if the webhook request includes `?useTradingViewData=true`**.

### How It Works

1. Webhook receives alert text and the request includes `useTradingViewData=true`.
2. System detects TradingView signal pattern (`SYMBOL(TF)` + side `VENTA/COMPRA` or `SELL/BUY`).
3. If TradingView pattern is detected, it queries `coin_analysis` via MCP and uses that output as an **additional real-time technical source**.
4. If `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true`, it also calls `combined_analysis` inside the same enrichment budget and annotates or downgrades the signal when confluence contradicts the webhook side.
5. If `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true`, it also calls `multi_timeframe_analysis` and returns the raw multi-timeframe metadata in dry-run/stored enrichment data.
6. Gemini/Brave grounding still runs when enabled, and the final `alert.enriched` merges grounding context + MCP technical data. When grounding returns no sources, Gemini sentiment magnitude is capped at `0.55`; the original signed value is retained as `sentiment_score_raw` only when that cap changes the score.
7. If either provider fails, the flow degrades gracefully to the other provider (or original text if none succeed).

Base `coin_analysis` gets the full configured budget when optional enrichment is disabled; when volume/confluence calls are enabled, it gets a bounded sub-budget so a timed-out first attempt can retry before the total envelope expires. Optional calls share the remaining envelope; if one times out, the base result is retained with `tradingViewEnrichmentStatus: "partial"` (or `"full"` when all requested enrichment completes). Failed base enrichment remains fail-open and is tracked as `"failed"` in runtime/storage telemetry.

When TradingView data is requested, `alert.enriched.tradingViewEnrichmentApplied` is `true` only when the MCP result was successfully applied. `tradingViewEnrichmentStatus` reports `full`, `partial`, `failed`, or `not_applicable`; the status is persisted separately from `useTradingViewData`, so analytics can distinguish requested, delivered, partial, and failed enrichment. When the MCP result supplies price data, `alert.enriched.current_price` (number or `null`) and the optional structured `alert.enriched.price_data` snapshot (e.g. `current_price`, `high`, `low`) are also part of the enrichment payload; these fields feed outcome-tracking entry prices and appear in dry-run `enrichedData` responses.

`GET /api/status` exposes `dependencies.tradingViewMcp.enrichment.alertPath`, an in-process rolling 24-hour window with `totalCount`, `appliedCount`, `failedCount`, `appliedRate24h`, and `failureRate24h`. The existing circuit-breaker admin page remains deduplicated and fail-open. `GET /api/alerts/summary` exposes `enrichment.tradingViewStatusCounts`; requested records without a persisted status are counted as `unrecorded`, while non-requested records are `not_applicable`.

### Timeframe Mapping

- `5 -> 5m`
- `15 -> 15m`
- `60 -> 1h`
- `240 -> 4h`
- `D/1D -> 1D`
- `W/1W -> 1W`
- `M/1M -> 1M`

### Example Enrichment Flow

**Request:**
```bash
POST /api/webhook/alert?useTradingViewData=true
Content-Type: application/json

{
  "text": "Bitcoin breaks $83,000 resistance level with strong volume."
}
```

**Response (with enrichment enabled):**
```json
{
  "success": true,
  "enriched": true,
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    }
  ]
}
```

**Message sent to Telegram:**
```text
*Bitcoin breaks $83,000 resistance level with strong volume.*

*Key Insights*
• Bitcoin price surged past $83k.
• Volume indicates strong momentum.

Sentiment: BULLISH 🚀 (0.85)

*Risk Parameters*
Setup: breakout
Invalidation: $80,000
Target: $90,000
Risk/Reward: 2.5:1

*Technical Levels*
Supports: $80,000
Resistances: $85,000

*Sources*
[CoinDesk](https://coindesk.com/...) / [CoinTelegraph](https://cointelegraph.com/...)
```

### Troubleshooting

- **Enrichment timeout**: If Gemini takes >8s, original alert is sent with warning logged
- **API errors**: Missing `GEMINI_API_KEY` or API rate limits fall back to original text
- **Long alerts**: Text >4000 chars may be truncated to manage costs
- **Disabled enrichment**: Set `ENABLE_GEMINI_GROUNDING=false` to skip processing

### POST /api/news-monitor

Analyze financial news and market sentiment for crypto and stock symbols. Detect significant trading events and send alerts to configured channels.

**Request (JSON):**
```json
{
  "crypto": ["BTCUSDT", "ETHUSD"],
  "stocks": ["NVDA", "MSFT"]
}
```

**Request (GET with query params):**
```
GET /api/news-monitor?crypto=BTCUSDT,ETHUSD&stocks=NVDA,MSFT
```

Add `dryRun=true` to either GET or POST to run the same validation and analysis without sending Telegram, WhatsApp, or Discord notifications, claiming or writing news-dedup cache entries, or recording signal outcomes. The response includes `dryRun: true`, the generated alerts, the intended `requestedChannels`, and an empty `deliveredChannels` array. POST also accepts `dryRun: true` in the JSON body.

```text
GET /api/news-monitor?crypto=BTCUSDT&channels=telegram,whatsapp&dryRun=true
POST /api/news-monitor?dryRun=true
```

Dry-run response excerpt:
```json
{
  "success": true,
  "dryRun": true,
  "requestedChannels": ["telegram", "whatsapp"],
  "deliveredChannels": [],
  "results": [{
    "symbol": "BTCUSDT",
    "status": "analyzed",
    "alert": { "eventCategory": "price_surge", "headline": "Bitcoin breaks resistance" },
    "deliveryResults": [],
    "cached": false
  }]
}
```

**Response:**
```json
{
  "success": true,
  "requestId": "req-abc123def456",
  "results": [
    {
      "symbol": "BTCUSDT",
      "status": "analyzed",
      "alert": {
        "eventCategory": "price_surge",
        "headline": "Bitcoin breaks $45,000 on positive market sentiment",
        "confidence": 0.85,
        "sources": ["Reuters", "CoinDesk"]
      },
      "deliveryResults": [
        {
          "channel": "telegram",
          "success": true,
          "messageId": "123456"
        },
        {
          "channel": "whatsapp",
          "success": true,
          "messageId": "whatsapp-msg-id"
        }
      ],
      "totalDurationMs": 2847,
      "cached": false,
      "requestId": "req-abc123def456"
    },
    {
      "symbol": "NVDA",
      "status": "cached",
      "alert": null,
      "cached": true,
      "requestId": "req-abc123def456"
    }
  ],
  "summary": {
    "total": 2,
    "analyzed": 1,
    "cached": 1,
    "timeout": 0,
    "error": 0,
    "quota_exhausted": 0,
    "alerts_sent": 1
  },
  "requestedChannels": ["telegram", "whatsapp"],
  "deliveredChannels": ["telegram", "whatsapp"],
  "totalDurationMs": 5234,
  "tokenUsage": {
    "inputTokens": 120,
    "outputTokens": 80,
    "totalTokens": 200
  }
}
```

**Event Categories** (detected by Gemini analysis):
- `price_surge` - Bullish price movement (>5% gain) with positive news
- `price_decline` - Bearish price movement (>5% loss) with negative news
- `public_figure` - Mentions of influential figures (Trump, Elon Musk, etc.)
- `regulatory` - Regulatory or official announcements

**Response Status Values**:
- `analyzed` - Symbol successfully analyzed, alerts generated/filtered
- `cached` - Result returned from cache (within TTL for same event category)
- `timeout` - Analysis exceeded per-symbol timeout (30s default)
- `error` - API failure (Binance, Gemini, or other service error). Gemini quota exhaustion is reported as `error.code = "GEMINI_QUOTA_EXHAUSTED"` and counted in `summary.quota_exhausted`.

When Sentry tracing is enabled, symbol analysis runs inside the `news_monitor.analyze_symbols` span, which records `news.symbol_count`, `news.quota_exhausted`, and `news.error_count` for quota correlation. Keep production `NEWS_GEMINI_CONCURRENCY=3` to bound provider bursts.

### POST /api/webhook/expanded-analysis-alert

Generate an expanded technical-analysis report with TradingView MCP `coin_analysis` data and send it through all enabled notification channels.

**Request (JSON):**
```json
{
  "symbols": ["BINANCE:BTCUSDT", "NASDAQ:NVDA"],
  "timeframe": "1D"
}
```

If `symbols` is empty or omitted, the endpoint falls back to `EXPANDED_ANALYSIS_ALERT_SYMBOLS`. If neither is defined, it returns `400 NO_SYMBOLS`. Symbols must be complete `EXCHANGE:SYMBOL` identifiers; crypto pairs are not normalized automatically.

The endpoint stops analysis at `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS` (default 60 seconds, max 120 seconds). If the deadline is reached before any symbol is analyzed, it returns `504 EXPANDED_ANALYSIS_ALERT_TIMEOUT`; completed symbols are returned and remaining symbols are marked with `status: "timeout"`.

**Response:**
```json
{
  "success": true,
  "alertText": "📊 *ANÁLISIS AMPLIADO — Friday 22/05/2026*...",
  "results": [
    {
      "symbol": "NASDAQ:NVDA",
      "status": "analyzed",
      "price": 219.51,
      "rsi": 57.8
    }
  ],
  "deliveryResults": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    }
  ],
  "summary": {
    "total": 1,
    "analyzed": 1,
    "error": 0,
    "delivered": 1
  },
  "requestId": "req-abc123",
  "totalDurationMs": 1200
}
```

### POST /api/webhook/volume-confirmation

Run TradingView MCP `volume_confirmation_analysis` on demand and return structured JSON without sending notifications.

**Request (JSON):**
```json
{
  "symbol": "BINANCE:BTCUSDT",
  "timeframe": "4h"
}
```

- `symbol`: Required `EXCHANGE:SYMBOL` identifier.
- `timeframe`: Optional indicator interval. Defaults to `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` or `1h`.

**Response (JSON):**
```json
{
  "success": true,
  "symbol": "BINANCE:BTCUSDT",
  "exchange": "BINANCE",
  "asset": "BTCUSDT",
  "timeframe": "4h",
  "confirmed": true,
  "decision": "confirm",
  "volumeRatio": 1.7,
  "analysis": {
    "symbol": "BINANCE:BTCUSDT",
    "volume_analysis": {
      "volume_ratio": 1.7,
      "volume_strength": "HIGH"
    }
  }
}
```

If the symbol format is invalid, the endpoint returns `400 INVALID_REQUEST`. If TradingView MCP fails, it returns `502 VOLUME_CONFIRMATION_FAILED` with the upstream error message.

### POST /api/webhook/symbol-analysis

Analyze one `EXCHANGE:SYMBOL` with TradingView MCP and return the Spanish report plus decision-ready data without sending notifications or placing orders.

**Request (JSON):**
```json
{
  "symbol": "BINANCE:BTCUSDT",
  "timeframe": "1D",
  "analysisMode": "combined",
  "includeMultiTimeframe": true
}
```

The response includes `alertText`, normalized price/volume/indicator/signal/assessment data, sentiment/news/confluence and multi-timeframe results when requested, plus directional `risk` and `decision` metadata. `decision.action` is `BUY` or `SELL` only when the data and risk levels are sufficient; otherwise it is `NO_TRADE`. This endpoint never delivers notifications or submits orders. Invalid symbols return `400 INVALID_REQUEST`, TradingView failures return `502 SYMBOL_ANALYSIS_FAILED`, and deadline expiry returns `504 SYMBOL_ANALYSIS_TIMEOUT`.

### POST /api/webhook/market-scanner-alert

Execute multiple market scanner tools on the TradingView MCP server (such as top gainers, top losers, volume breakout, smart volume, or Bollinger squeeze), generate a formatted technical summary report in Spanish, and send it through all enabled notification channels.

**Request (JSON):**
```json
{
  "exchange": "BINANCE",
  "timeframe": "4h",
  "scans": [
    "top_gainers",
    "top_losers",
    "volume_breakout_scanner",
    "smart_volume_scanner",
    "bollinger_scan"
  ],
  "limit": 5,
  "bbw_threshold": 0.05,
  "ranked": true,
  "includeMultiTimeframe": true
}
```

- `exchange`: (Optional) The exchange identifier to run scans against. Defaults to `MARKET_SCANNER_DEFAULT_EXCHANGE` or `BINANCE`.
- `timeframe`: (Optional) Interval for indicators (e.g. `5m`, `15m`, `1h`, `4h`, `1D`, `1W`, `1M`). Defaults to `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` or `4h`.
- `scans`: (Optional) Array of scan types to execute sequentially. Defaults to `['top_gainers', 'top_losers', 'volume_breakout_scanner']`.
- `limit`: (Optional) Max number of results per section (clamped to `[1, 20]`, default: `5`).
- `bbw_threshold`: (Optional) Bollinger Band Width threshold for the Bollinger squeeze scan (default: `0.05`).
- `ranked`: (Optional) Sort results by actionable trade quality and include numeric `score` plus non-empty `reason` in each `scanResults[].scores[]` entry (default: `false`).
- `includeMultiTimeframe`: (Optional) Fetch higher-timeframe alignment for each scanner candidate through TradingView MCP. Aligned candidates receive a default `+10` score modifier, counter-trend candidates receive a default `-10` modifier, and upstream failures leave the original scanner item unchanged (default: `false`). The alias `include_multi_timeframe` is also accepted.

**Response (JSON):**
```json
{
  "success": true,
  "alertText": "📡 *SCANNER DE MERCADO — Saturday 23/05/2026*\n...",
  "scanResults": [
    {
      "scan": "top_gainers",
      "status": "success",
      "itemCount": 1
    }
  ],
  "deliveryResults": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    }
  ],
  "summary": {
    "totalScans": 1,
    "success": 1,
    "error": 0,
    "timeout": 0,
    "totalItems": 1,
    "delivered": 1
  },
  "timedOut": false,
  "includeMultiTimeframe": true,
  "timeoutMs": 90000,
  "requestId": "req-xyz789",
  "totalDurationMs": 1450
}
```

When `ranked` is `true`, each successful scan also includes structured scores:

```json
{
  "scan": "top_gainers",
  "status": "success",
  "itemCount": 1,
  "scores": [{ "symbol": "BTCUSDT", "score": 83, "reason": "+3.5% · RSI 62.0 · Vol 1.8x · HTF aligned +10", "trendConfluence": { "status": "aligned", "direction": "bullish", "confidence": 82, "adjustment": 10 } }]
}
```

### POST /api/webhook/alert

Send alert via webhook. Accepts either JSON or plain text.

Optional headers:
- `x-request-id`: Optional client-supplied correlation ID (1-128 printable ASCII characters). If omitted or invalid, a UUIDv4 is generated.
- `idempotency-key` / `x-idempotency-key`: Optional replay key for deduplicating retries.

Optional query param: `useTradingViewData=true` enables TradingView MCP technical enrichment for this request (requires `ENABLE_TRADINGVIEW_MCP_ENRICHMENT=true`).

**Request (JSON):**
```json
{
  "text": "BTCUSDT and NVDA momentum update",
  "symbolRoutes": {
    "BTCUSDT": { "channels": ["telegram"] },
    "NVDA": { "channels": ["discord"] }
  }
}
```

`symbolRoutes` is optional. Each key may be a bare symbol or an `EXCHANGE:SYMBOL` identifier and must map to a non-empty list of `telegram`, `whatsapp`, and/or `discord`. Matched symbols are delivered only to their configured channels; symbols without a route use the global `channels` list or the normal broadcast. When this field is absent, alert behavior is unchanged. Per-symbol delivery results include `symbol`.

**Request (Plain Text):**
```
Content-Type: text/plain

BTC price is at $45,000 - breakout detected!
```

**Response:**
```json
{
  "success": true,
  "requestId": "0d63f03b-d5a2-4a0b-928d-1959b8eb6a95",
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    },
    {
      "channel": "whatsapp",
      "success": true,
      "messageId": "whatsapp-msg-id"
    }
  ],
  "enriched": false
}
```

### Asynchronous Jobs API

To run long-running technical analysis or market scans without hitting HTTP request limits or gateway timeouts (502/504), you can use the asynchronous jobs API. All endpoints require the `x-api-key` header to be configured.

#### POST /api/jobs/tradingview-analysis

Start a background analysis or scanner job.

**Request (JSON - Expanded Analysis):**
```json
{
  "type": "expanded-analysis",
  "symbols": ["BINANCE:BTCUSDT"],
  "timeframe": "1D",
  "includeMultiTimeframe": true
}
```

**Request (JSON - Market Scanner):**
```json
{
  "type": "market-scanner",
  "exchange": "BINANCE",
  "timeframe": "4h",
  "scans": ["top_gainers", "top_losers"],
  "limit": 5,
  "ranked": true,
  "includeMultiTimeframe": true
}
```

For market-scanner jobs, `ranked` and `includeMultiTimeframe` use the same scoring and fail-open higher-timeframe enrichment as the synchronous scanner endpoint. If the job deadline aborts enrichment after a scan completes, that scan is retained and only remaining scans are marked as timed out.

**Response (201 Created):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "status": "processing",
  "createdAt": "2026-05-25T01:30:00.000Z"
}
```

**Idempotency:** `POST /api/jobs/tradingview-analysis`, `POST /api/jobs/:jobId/retry`, and `POST /api/jobs/:jobId/retry-failed` accept an optional client-generated `idempotency-key` header. Matching concurrent or sequential requests replay the original response and `jobId`/`newJobId` without starting another worker. The first response sends `Idempotency-Replay: false`; a replay sends `Idempotency-Replay: true` and includes `"idempotencyReplayed": true` in the JSON response. `JOB_QUEUE_ACCEPTANCE_UNKNOWN` responses are also replayable and include the durable `jobId`, preventing a retry from creating a second queue item. Reusing a key with a different request fingerprint returns `409 IDEMPOTENCY_CONFLICT`. Requests without the header retain current behavior.

Example:
```http
POST /api/jobs/tradingview-analysis
idempotency-key: job-create-2026-07-26-001
```

The idempotency cache is in-memory, bounded, and retained for five minutes by default (`WEBHOOK_IDEMPOTENCY_TTL_MS` can override the TTL). Request fingerprints canonicalize nested object key order while preserving array order.

#### POST /api/jobs/:jobId/retry and /api/jobs/:jobId/retry-failed

Retry a cancelled/failed job or only its failed items. Supply the same `idempotency-key` when retrying a request after a timeout or lost response to receive the original `newJobId` instead of creating another background job.

When `callbackUrl` is configured, each callback POST includes:

- `x-callback-timestamp` - ISO-8601 delivery timestamp; reject stale values outside your freshness window.
- `x-callback-event` - job event (`processing`, `completed`, `failed`, `cancelled`, or `timed_out`).
- `x-callback-delivery-id` - UUID unique to this HTTP delivery attempt; use it for deduplication.
- `x-callback-signature` - included when `callbackSecret` or `JOB_CALLBACK_SIGNING_SECRET` is configured.

Before each delivery attempt, hostname callback URLs are resolved with all current DNS answers. Any private answer blocks the callback (unless `ALLOW_PRIVATE_CALLBACKS=true`), and the connection is pinned to the validated answers so the subsequent fetch cannot perform a second hostname lookup and bypass the SSRF check. Redirects remain disabled with `redirect: 'error'`.

`ALLOW_HTTP_CALLBACKS` and `ALLOW_PRIVATE_CALLBACKS` are local/testing security overrides and should remain `false` in production. `JOB_CALLBACK_RETRY_DELAY_MS` defaults to `1000` ms; `JOB_CALLBACK_SIGNING_SECRET` is an optional server-side HMAC secret and must never be committed.

Verify the signature with HMAC-SHA256 over this exact canonical string, using the shared secret and the raw JSON request body:

```text
x-callback-timestamp + "\n" + x-callback-event + "\n" + x-callback-delivery-id + "\n" + raw-request-body
```

Retries generate a new delivery ID and signature for every attempt. The `callbackStatus.attempts` records include the same `deliveryId` for audit and deduplication.

#### GET /api/jobs

List recent sanitized jobs. The endpoint includes jobs from the in-memory repository and, when Firestore job storage is enabled, jobs persisted in `tradingviewJobs`. Expired terminal jobs are excluded.

**Query Parameters:**
- `status` - Optional: `pending`, `processing`, `completed`, `failed`, `cancelled`, or `timed_out`
- `type` - Optional: `expanded-analysis` or `market-scanner`
- `limit` - Integer between `1` and `100` (default: `50`)

**Response (200 OK):**
```json
{
  "success": true,
  "jobs": [
    {
      "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
      "type": "expanded-analysis",
      "status": "completed",
      "progress": { "total": 1, "current": 1 },
      "createdAt": "2026-05-25T01:30:00.000Z",
      "updatedAt": "2026-05-25T01:30:12.000Z",
      "totalDurationMs": 12053
    }
  ]
}
```

#### GET /api/jobs/:jobId

Retrieve status, partial progress, final report, and delivery state of a job.
Jobs are retained in memory and, when Firestore job storage is enabled, persisted to the `tradingviewJobs` collection so status survives process restarts. Completed, failed, cancelled, and timed-out jobs are automatically evicted after 1 hour. Durable terminal documents receive an `expiresAt` timestamp based on `createdAt`; run `bash ops/configure-firestore-alert-retention.sh` once per Firebase project to backfill legacy terminal jobs and enable native TTL deletion for `tradingviewJobs`. Firestore TTL deletion is eventually consistent, while the API still filters expired jobs on reads.

For completed ranked market-scanner jobs, `scanResults[].scores[]` contains the structured `symbol`, numeric `score`, non-empty `reason`, and optional `trendConfluence` fields used by the alert report. This is also included in configured terminal callback payloads.

Set `ENABLE_FIRESTORE_JOB_STORAGE=true` plus the normal Firebase Admin credentials (`FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`) to enable durable job storage. The legacy in-memory path remains the fallback when Firestore is disabled or unavailable.

By default, jobs still execute in-process (`JOB_EXECUTION_MODE=local`). With `JOB_EXECUTION_MODE=render-worker` (BullMQ + Redis) or `JOB_EXECUTION_MODE=firestore-poller` (direct Firestore polling), the web service stores sanitized job metadata in Firestore and enqueues/persists the job for the dedicated `pnpm run start-worker` process. The worker claims eligible queued jobs transactionally, periodically reconciles durable rows still marked `processing`/`queued` plus expired `claimed`/`running` leases, renews its lease at persistence checkpoints, and drains active work on `SIGTERM`. Notification delivery is checkpointed durably before and after the external send; a redelivery with an unknown outcome fails closed as `JOB_DELIVERY_RECONCILIATION_REQUIRED` rather than sending the same alert twice. Missing Redis (in `render-worker` mode) or durable Firestore storage fails the create request with `503 JOB_QUEUE_UNAVAILABLE`.

**Response (200 OK - Processing):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "type": "expanded-analysis",
  "status": "processing",
  "progress": {
    "total": 2,
    "current": 1,
    "status": "Analyzing symbol BINANCE:BTCUSDT (1/2)"
  },
  "results": [
    {
      "symbol": "BINANCE:BTCUSDT",
      "status": "analyzed",
      "price": 65430,
      "rsi": 43.5
    }
  ],
  "createdAt": "2026-05-25T01:30:00.000Z",
  "updatedAt": "2026-05-25T01:30:05.000Z",
  "totalDurationMs": 5123
}
```

### Stored Alerts API

When `ENABLE_FIRESTORE_ALERT_STORAGE=true`, successful `POST /api/webhook/alert`, news-monitor deliveries, and delivered `POST /api/webhook/market-scanner-alert` / `POST /api/webhook/expanded-analysis-alert` reports are persisted to Firestore and can be inspected through the protected alerts read API. Each stored record carries a `source` field of one of `webhook`, `news-monitor`, `market-scanner`, or `expanded-analysis`. Stored alert text is capped at 20,000 characters; when clipped, the record exposes `truncated: true` and `originalLength` so the read API, export, and replay can flag the loss — `replay` will redeliver the truncated text only.

Stored `alerts` and `alertReplays` records default to 90 days of retention. The service filters expired records before list, detail, export, and summary responses while Firestore's native TTL deletion is eventual. New records carry an `expiresAt` timestamp; `bash ops/configure-firestore-alert-retention.sh` backfills legacy records from `receivedAt`/`replayedAt` before enabling both TTL policies, shortens existing expiries when the configured deadline is earlier, removes legacy raw replay idempotency keys after hashing them, reports scanned/updated/skipped counts, and fails if a record has no usable timestamp. Replay audit documents retain only a SHA-256 `idempotencyKeyHash`, never the raw key. Inspect the TTL policies with `gcloud firestore fields ttls list`.

All endpoints below require the same `x-api-key` header used by the webhook routes.
If alert storage is enabled but Firestore credentials/project access are unavailable, they return `503 STORAGE_UNAVAILABLE` instead of a generic `500`.

#### GET /api/alerts

List stored alerts ordered by `receivedAt` descending.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either a legacy ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `source` - Optional source filter. Valid values include `webhook`, `news-monitor`, `market-scanner`, and `expanded-analysis`.
- `enriched` - Optional boolean filter (`true` or `false`)

**Response (200 OK):**
```json
{
  "success": true,
  "alerts": [
    {
      "id": "alert-1",
      "receivedAt": "2026-06-06T12:00:00.000Z",
      "text": "BTC alert",
      "enriched": true,
      "enrichmentData": {
        "sentiment": "bullish"
      },
      "tokenUsage": {
        "totalTokens": 42
      },
      "deliveryResults": [
        {
          "channel": "telegram",
          "success": true
        }
      ],
      "source": "webhook",
      "useTradingViewData": false,
      "tradingViewEnrichmentApplied": false
    }
  ],
  "pagination": {
    "hasMore": false,
    "limit": 50,
    "nextBefore": "eyJ2IjoxLCJyZWNlaXZlZEF0IjoiMjAyNi0wNi0wNlQxMjowMDowMC4wMDBaIiwiaWQiOiJhbGVydC0xIn0"
  }
}
```

#### GET /api/alerts/export

Export bounded stored alerts as JSONL or CSV. CSV serialization prefixes string fields whose leading control characters (`tab`/`LF`/`CR`) are followed by `=`, `+`, `-`, or `@`—or that begin directly with those markers—with an apostrophe so spreadsheet clients treat them as inert text; finite numeric strings such as `-42` remain unchanged. JSONL output is unchanged.

**Query Parameters:**
- `format` - `jsonl` or `csv` (default: `jsonl`)
- `from` / `to` - Required bounded ISO-8601 timestamps
- `limit` - Integer between `1` and `1000` (default: `500`)
- `source` / `enriched` - Optional filters
- `includeText` - Optional boolean; raw alert text is excluded unless `true`

#### GET /api/alerts/summary

Return bounded JSON-only analytics for stored alerts without exposing raw alert text or credentials.

Each enriched alert records only safe prompt provenance (`name`, `source`, `label`, and `version`) when a prompt was resolved. The `enrichment.riskMetadataCoverage` block uses enriched alerts as its denominator and reports populated counts/percentages for `invalidation_level`, `target_level`, `setup_type`, and `risk_reward_ratio`. `byPromptProvenance` groups the same metrics by Langfuse/local provenance; legacy records without provenance use `null`. Missing or invalid optional values remain zero coverage and are never synthesized.

Similarly, `enrichment.evidenceCoverage` tracks whether enriched alerts cited grounding sources, reporting `zeroSources`, `oneToTwoSources`, and `threePlusSources` distribution along with `averageSourceCount`, overall and grouped `byPromptProvenance`.

**Query Parameters:**
- `from` - Optional ISO-8601 lower bound; defaults to 24 hours before `to`
- `to` - Optional ISO-8601 upper bound; defaults to request time
- `limit` - Integer between `1` and `1000` (default: `500`)

The service caps the queried window at 31 days to keep routine operator usage cheap.

**Response (200 OK):**
```json
{
  "success": true,
  "summary": {
    "window": {
      "from": "2026-06-06T00:00:00.000Z",
      "to": "2026-06-07T00:00:00.000Z",
      "limit": 500,
      "maxDays": 31
    },
    "totalAlerts": 2,
    "bySource": {
      "webhook": 2
    },
    "bySymbol": {
      "BTCUSDT": 1,
      "ETHUSDT": 1
    },
    "byFeatureFlag": {
      "enriched": 1,
      "plain": 1,
      "tradingViewData": 1,
      "tradingViewDataApplied": 1,
      "withoutTradingViewData": 1
    },
    "enrichment": {
      "enrichedAlerts": 1,
      "plainAlerts": 1,
      "tradingViewStatusCounts": {
        "full": 0,
        "partial": 0,
        "failed": 0,
        "not_applicable": 1,
        "unrecorded": 1
      },
      "riskMetadataCoverage": {
        "denominator": 1,
        "fields": {
          "invalidation_level": { "populated": 0, "percentage": 0 },
          "target_level": { "populated": 0, "percentage": 0 },
          "setup_type": { "populated": 0, "percentage": 0 },
          "risk_reward_ratio": { "populated": 0, "percentage": 0 }
        },
        "byPromptProvenance": [
          {
            "provenance": null,
            "denominator": 1,
            "fields": {
              "invalidation_level": { "populated": 0, "percentage": 0 },
              "target_level": { "populated": 0, "percentage": 0 },
              "setup_type": { "populated": 0, "percentage": 0 },
              "risk_reward_ratio": { "populated": 0, "percentage": 0 }
            }
          }
        ]
      },
      "evidenceCoverage": {
        "denominator": 1,
        "zeroSources": { "populated": 1, "percentage": 100 },
        "oneToTwoSources": { "populated": 0, "percentage": 0 },
        "threePlusSources": { "populated": 0, "percentage": 0 },
        "totalSourceCount": 0,
        "averageSourceCount": 0,
        "byPromptProvenance": [
          {
            "provenance": null,
            "denominator": 1,
            "zeroSources": { "populated": 1, "percentage": 100 },
            "oneToTwoSources": { "populated": 0, "percentage": 0 },
            "threePlusSources": { "populated": 0, "percentage": 0 },
            "totalSourceCount": 0,
            "averageSourceCount": 0
          }
        ]
      },
      "tokenUsage": {
        "inputTokens": 10,
        "outputTokens": 20,
        "totalTokens": 30,
        "totalCost": 0.001
      }
    },
    "delivery": {
      "totalSuccess": 2,
      "totalFailure": 1,
      "byChannel": {
        "telegram": {
          "total": 2,
          "success": 1,
          "failure": 1
        },
        "whatsapp": {
          "total": 1,
          "success": 1,
          "failure": 0
        }
      }
    },
    "latency": {
      "averageProcessingMs": 250,
      "averageDeliveryMs": 150
    }
  }
}
```

For rollout validation, first verify the active prompt provenance and coverage in preview, then observe a bounded production/shadow window after aligning the remote `alert-enrichment` prompt with the local optional-risk schema. Treat missing fields as unavailable data; do not use zero coverage as a trading outcome or fabricate stops, targets, setup types, or R:R values.

#### GET /api/alerts/replays

List bounded alert-replay audit records from the Firestore `alertReplays` collection, ordered by `replayedAt` descending. Each `POST /api/alerts/{alertId}/replay` writes a unique audit document so retries with the same idempotency key are preserved as history instead of overwriting prior attempts; the HTTP `Idempotency-Replay` contract remains upstream of storage. Raw idempotency keys are never stored or returned — only a SHA-256 hash prefix is exposed.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either a legacy ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `alertId` - Optional stored alert id to scope replays to a single document

**Response (200 OK):**
```json
{
  "success": true,
  "replays": [
    {
      "id": "1700000000000_<uuid>",
      "alertId": "alert-1",
      "idempotencyKeyHashPrefix": "06bdeddf2a29",
      "attemptId": "1700000000000_<uuid>",
      "channels": ["telegram"],
      "deliverySummary": [
        { "channel": "telegram", "success": true, "messageId": "tg-1" }
      ],
      "replayedAt": "2026-06-06T12:34:56.000Z"
    }
  ],
  "pagination": {
    "hasMore": false,
    "limit": 50,
    "nextBefore": null
  }
}
```

The same `403 FEATURE_DISABLED` (when `ENABLE_FIRESTORE_ALERT_STORAGE=false`) and `503 STORAGE_UNAVAILABLE` mapping as the sibling endpoints applies.

#### GET /api/alerts/:alertId

Retrieve a single stored alert by Firestore document ID. The response also surfaces `lastReplay` — the most recent `alertReplays` entry for the alert, or `null` if none has been recorded.

**Response (200 OK):**
```json
{
  "success": true,
  "alert": {
    "id": "alert-123",
    "receivedAt": "2026-06-06T10:30:00.000Z",
    "text": "Stored alert",
    "enriched": false,
    "enrichmentData": null,
    "tokenUsage": null,
    "deliveryResults": [],
    "source": "webhook",
    "useTradingViewData": true,
    "tradingViewEnrichmentApplied": false
  },
  "lastReplay": {
    "id": "1700000000000_<uuid>",
    "alertId": "alert-123",
    "idempotencyKeyHashPrefix": "06bdeddf2a29",
    "attemptId": "1700000000000_<uuid>",
    "channels": ["telegram"],
    "deliverySummary": [
      { "channel": "telegram", "success": true, "messageId": "tg-1" }
    ],
    "replayedAt": "2026-06-06T12:34:56.000Z"
  }
}
```

**Response (200 OK - Completed):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "type": "expanded-analysis",
  "status": "completed",
  "progress": {
    "total": 1,
    "current": 1,
    "status": "Completed analysis"
  },
  "results": [
    {
      "symbol": "BINANCE:BTCUSDT",
      "status": "analyzed",
      "price": 65430,
      "rsi": 43.5
    }
  ],
  "alertText": "📊 *ANÁLISIS AMPLIADO — Monday 25/05/2026*...",
  "deliveryResults": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "987654"
    }
  ],
  "summary": {
    "total": 1,
    "analyzed": 1,
    "error": 0,
    "delivered": 1
  },
  "createdAt": "2026-05-25T01:30:00.000Z",
  "updatedAt": "2026-05-25T01:30:12.000Z",
  "totalDurationMs": 12053
}
```

### Signal Outcomes (CB-199)

#### GET /api/outcomes

Query durably recorded signal outcomes record-by-record with pagination and filtering by symbol, exchange, status, window, and date range. Requires `x-api-key` header (or `api-key` query parameter) or Firebase Bearer token with `admin.viewer` or `admin.operator` role. Returns `403 FEATURE_DISABLED` if `ENABLE_SIGNAL_OUTCOME_TRACKING !== 'true'`, and `503 STORAGE_UNAVAILABLE` if Firestore is enabled but inaccessible.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either an ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `symbol` - Filter by trading symbol (e.g. `BTCUSDT` or `BINANCE:BTCUSDT`)
- `exchange` - Filter by exchange identifier (e.g. `BINANCE`, `NASDAQ`)
- `status` - Filter by evaluation status (`pending`, `evaluated`, `unavailable`)
- `window` - Filter by measurement window (`1h`, `4h`, `1D`, `1W`)
- `from` - Optional ISO-8601 lower bound timestamp
- `to` - Optional ISO-8601 upper bound timestamp

**Response (200 OK):**
```json
{
  "success": true,
  "outcomes": [
    {
      "id": "outcome-doc-1",
      "receivedAt": "2026-08-23T12:00:00.000Z",
      "requestId": "req-1",
      "source": "news-monitor",
      "symbol": "BTCUSDT",
      "exchange": "BINANCE",
      "assetClass": "crypto",
      "timeframe": "1h",
      "setupType": "breakout",
      "score": 0.9,
      "side": "BUY",
      "price": 65000,
      "entryPriceSource": "tradingview-mcp",
      "stop": 63000,
      "target": 68000,
      "marketDataProvider": "binance",
      "eligibilityState": "supported_provider",
      "eligibilityReason": null,
      "outcomeEvaluated": true,
      "outcomes": {
        "1h": {
          "status": "evaluated",
          "reason": null,
          "targetTime": "2026-08-23T13:00:00.000Z",
          "price": 66000,
          "return": 1.5385,
          "maxFavorableExcursion": 2.0,
          "maxAdverseExcursion": -0.2,
          "firstHit": null,
          "targetHit": false,
          "stopHit": false,
          "firstHitTime": null,
          "rMultiple": 0.5
        }
      },
      "sources": [],
      "tokenUsage": {
        "inputTokens": 100,
        "outputTokens": 40,
        "totalTokens": 140,
        "totalCost": 0.00003
      },
      "processingTimeMs": 150
    }
  ],
  "pagination": {
    "limit": 50,
    "hasMore": false,
    "nextBefore": null
  }
}
```

#### GET /api/outcomes/summary

Query aggregated performance and coverage metrics for recorded signal outcomes, with optional filtering by symbol, exchange, status, window, and date range. When no outcomes match the filters or tracking is enabled with an empty dataset, the endpoint returns `200 OK` with `available: false` and a typed empty summary structure. Requires `x-api-key` header (or `api-key` query parameter) or Firebase Bearer token with `admin.viewer` or `admin.operator` role.

**Query Parameters:**
- `limit` - Maximum number of recent outcomes to aggregate (integer between `1` and `100`, default: `50`)
- `symbol` - Filter by trading symbol (e.g. `BTCUSDT` or `BINANCE:BTCUSDT`)
- `exchange` - Filter by exchange identifier (e.g. `BINANCE`, `NASDAQ`)
- `status` - Filter by evaluation status (`pending`, `evaluated`, `unavailable`)
- `window` - Filter by measurement window (`1h`, `4h`, `1D`, `1W`)
- `from` - Optional ISO-8601 lower bound timestamp
- `to` - Optional ISO-8601 upper bound timestamp

**Response (200 OK):**
```json
{
  "success": true,
  "summary": {
    "available": true,
    "totalSignalsReceived": 50,
    "totalSignalsEligible": 45,
    "totalSignalsEvaluated": 40,
    "totalSignalsPending": 5,
    "totalSignalsUnavailable": 5,
    "coveragePercent": 80,
    "isCoverageComplete": false,
    "targetHitRatePercent": 65.5,
    "stopHitRatePercent": 25,
    "expectancyR": 1.25,
    "populationNote": "Metrics represent 40 evaluated signals out of 50 total received signals (80% coverage).",
    "exchangeBreakdown": {
      "BINANCE": {
        "received": 40,
        "eligible": 40,
        "evaluated": 35,
        "pending": 3,
        "unavailable": 2
      }
    },
    "providerBreakdown": {
      "binance": {
        "received": 40,
        "eligible": 40,
        "evaluated": 35,
        "pending": 3,
        "unavailable": 2
      }
    },
    "entryPriceSourceBreakdown": {
      "tradingview-mcp": 40
    },
    "eligibilityBreakdown": {
      "supported_provider": 45
    },
    "windows": {
      "1h": {
        "totalSignals": 35,
        "hitRatePercent": 60,
        "targetEligibleWindows": 30,
        "stopEligibleWindows": 30,
        "targetHitRatePercent": 55,
        "stopHitRatePercent": 20,
        "expectancyR": 0.85,
        "averageReturnPercent": 2.15,
        "averageMfePercent": 3.45,
        "averageMaePercent": -1.1,
        "maxAdverseExcursionPercent": -4.5
      }
    },
    "drawdownProxy": {
      "averageMaxAdverseExcursionPercent": -1.85,
      "absoluteMaxAdverseExcursionPercent": -7.2
    },
    "falsePositiveCandidatesCount": 0,
    "falsePositiveCandidates": [],
    "latencyCostMetadata": {
      "averageProcessingTimeMs": 450,
      "tokenUsage": {
        "inputTokens": 1200,
        "outputTokens": 400,
        "totalCost": 0.0035
      }
    }
  }
}
```

## Multi-Channel Alerts (002)

The alert webhook system supports simultaneous delivery to multiple channels (Telegram, WhatsApp, and Discord) with independent retry logic and graceful degradation.

### Supported Channels

#### Telegram (Default)

- **Enabled by**: `ENABLE_TELEGRAM_BOT=true` + valid `BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- **Format**: MarkdownV2 with special character escaping
- **Timeout**: ~10 seconds per delivery
- **Retry**: Rate limits (HTTP 429) retried up to 2 additional times (3 total attempts) with `Retry-After` parameter backoff and total wait budget caps
- **Forum Topics (`message_thread_id`)**: Route alerts automatically into forum topics by category/source via `TELEGRAM_TOPIC_ROUTES` or explicitly per request via `telegramThreadId` (set `0` to target the General topic). Precedence: explicit request payload `telegramThreadId` > `TELEGRAM_TOPIC_ROUTES[category]` > `TELEGRAM_TOPIC_ROUTES.default` > General topic.

#### WhatsApp (Optional)

- **Enabled by**: `ENABLE_WHATSAPP_ALERTS=true` + GreenAPI credentials
- **Format**: WhatsApp markdown (bold, italic, strikethrough, code blocks, lists)
- **Timeout**: ~10 seconds per delivery  
- **Retry**: 3 attempts with exponential backoff (1s → 2s → 4s) per chunk
- **Message Size**: Payloads exceeding 20,000 characters are automatically split into sequential chunks that each deliver and retry independently (no ellipsis truncation)
- **Provider**: GreenAPI (REST API via native fetch)

#### Discord (Optional)

- **Enabled by**: `ENABLE_DISCORD_ALERTS=true` + valid `DISCORD_WEBHOOK_URL`
- **Format**: Plain Discord webhook content with Markdown-friendly text
- **Timeout**: ~10 seconds per delivery
- **Retry**: Rate limits (HTTP 429) retried up to `DISCORD_MAX_RETRIES` additional attempts (default: `2`) using `Retry-After` backoff bounded by `DISCORD_FALLBACK_RETRY_DELAY_MS`, `DISCORD_MAX_RETRY_DELAY_MS`, and `DISCORD_MAX_TOTAL_RETRY_WAIT_MS`
- **Message Size**: Payloads exceeding 2,000 characters are automatically split into sequential chunks that each deliver and retry independently
- **Provider**: Discord webhook execute endpoint via native `fetch`

### Channel-Specific Formatting

**Telegram (MarkdownV2)**:
- Escapes special characters: `_ * [ ] ( ) ~ ` > # + - = | { } . !`
- Preserves hyperlinks
- Supports inline code, code blocks, and bold/italic text

**WhatsApp**:
- Converts unsupported Telegram syntax to WhatsApp equivalents
- Strips links (displayed as plain text)
- Supports bold (`*text*`), italic (`_text_`), strikethrough (`~text~`)
- Supports code blocks with triple backticks
- Supports lists with asterisk or hyphen

**Discord**:
- Sends webhook `content` payloads over native `fetch`
- Reuses the plain-text/Markdown-friendly formatting path
- Works with direct routing via `channels: ["discord"]`

### URL Shortening for WhatsApp

When a supported URL-shortening service is configured, URLs in WhatsApp alerts are automatically shortened to reduce character count and improve readability.

**Features**:
- **Automatic Detection**: Identifies HTTP/HTTPS URLs in alert text
- **Shortened URLs**: Converts long URLs (e.g., `https://example.com/very/long/path?param=value`) to a provider link
- **Session-Scoped Cache**: Caches shortenings during request processing to avoid redundant API calls (1-hour TTL per session)
- **Parallel Shortening**: Multiple URLs shortened concurrently
- **Fallback Behavior**: If shortening fails or is disabled, original URLs are preserved
- **Graceful Degradation**: Shortening errors don't block alert delivery

**How It Works**:
1. Alert received with one or more URLs
2. URLShortener detects and extracts URLs when a supported provider is configured
3. Checks session cache for previously shortened URLs
4. Calls the selected provider for new URLs
5. Replaces original URLs with shortened versions in alert text
6. Alert delivered to WhatsApp (and other channels) with shortened URLs

**Configuration**:
- Set `URL_SHORTENER_SERVICE=picsee` with `PICSEE_API_KEY`, `URL_SHORTENER_SERVICE=cuttly` with `CUTTLY_API_KEY`, or select `tinyurl` without a credential
- Optional: URLs only shortened for WhatsApp; other channels receive original URLs
- Cache per session: TTL 1 hour; cleared after request completes or session ends

**Example**:

**Before** (158 characters):
```
Sources: 
- https://example.com/research/crypto/bitcoin/technical-analysis?date=2024-01-15&symbol=BTCUSDT&period=4h&includeIndicators=true
```

**After** (with URL shortening):
```
Sources: 
- https://short.url/crypto-analysis
```

### Delivery Behavior

**Parallel Sending**: Alerts sent to all enabled channels simultaneously without blocking

**Independent Retry**: Each channel retries independently
- Channel A failure doesn't affect Channel B
- WhatsApp retries transient provider failures up to 3 attempts with exponential backoff (1s → 2s → 4s, ±10% jitter) per chunk
- Discord retries 429 rate-limit responses with up to `DISCORD_MAX_RETRIES` additional attempts (default: `2`, up to 3 total attempts) per chunk using `Retry-After` backoff bounded by `DISCORD_MAX_TOTAL_RETRY_WAIT_MS`
- Telegram retries 429 rate-limit responses up to 2 times

**Message Chunking**: Payloads exceeding provider length limits (20,000 characters for WhatsApp, 2,000 characters for Discord) are automatically split into sequential chunks that deliver and retry independently; earlier delivered chunks are preserved if a later chunk fails.

**Graceful Degradation**: If one channel fails
- Other channels still receive the alert
- Response includes per-channel results
- HTTP 200 OK returned (fail-open pattern)
- Failures logged at WARN/ERROR level
- If `channels` is omitted in the generic message webhook, delivery fans out to every enabled channel

**Example - Dual Channel Delivery**:
=======
Verify service readiness:
>>>>>>> origin/master

```bash
curl http://localhost:3000/healthcheck
curl http://localhost:3000/ready
```

---

## API Endpoints Summary

All webhook and mutation endpoints require the `x-api-key` header (configured via `WEBHOOK_API_KEY`). Browser admin endpoints support Firebase ID tokens (`Authorization: Bearer <token>`).

| Method | Path | Description | Documentation |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthcheck` | Fast process liveness probe | [API Reference](docs/api-reference.md#get-healthcheck) |
| `GET` | `/ready` | Deep dependency readiness probe (Redis, Firestore, MCP) | [API Reference](docs/api-reference.md#get-ready) |
| `GET` | `/api/status` | Comprehensive system capabilities & dependency matrix | [API Reference](docs/api-reference.md#get-apistatus) |
| `GET` | `/api/public/status` | Safe public subset of capabilities & channel statuses | [API Reference](docs/api-reference.md#get-apipublicstatus) |
| `POST` | `/api/webhook/alert` | Ingest and dispatch alert to configured channels | [Webhook Alerts](docs/webhooks.md#post-apiwebhookalert) |
| `POST` | `/api/webhook/expanded-analysis-alert` | TradingView MCP technical analysis report | [Webhook Alerts](docs/webhooks.md#post-apiwebhookexpanded-analysis-alert) |
| `POST` | `/api/webhook/volume-confirmation` | TradingView volume and momentum confirmation | [Webhook Alerts](docs/webhooks.md#post-apiwebhookvolume-confirmation) |
| `POST` | `/api/webhook/symbol-analysis` | Immediate multi-timeframe symbol analysis | [Webhook Alerts](docs/webhooks.md#post-apiwebhooksymbol-analysis) |
| `POST` | `/api/webhook/market-scanner-alert` | Multi-asset market scanner report (gainers/losers) | [Webhook Alerts](docs/webhooks.md#post-apiwebhookmarket-scanner-alert) |
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
