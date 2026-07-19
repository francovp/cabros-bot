# Cabros Bot

Express + Telegraf-based Telegram bot service with multi-channel alert delivery (Telegram and WhatsApp) and intelligent news monitoring.

## Features

- 📱 **Multi-Channel Alerts**: Send trading alerts to both Telegram and WhatsApp
- 🚀 **Webhook API**: HTTP endpoint for receiving alerts from external services (e.g., TradingView)
- 📰 **News Monitoring**: Analyze financial news and market sentiment for crypto and stock symbols with AI-powered event detection
- 🧠 **AI Enrichment**: Optional enhancement of alerts using Google Gemini API (grounding) and optional secondary LLM (Azure AI)
- 🧩 **Langfuse Prompt Management**: Manage all runtime LLM prompts centrally in Langfuse with local fail-open fallbacks
- 📊 **TradingView MCP Analysis**: Optional webhook enrichment plus expanded technical-analysis reports from TradingView MCP data
- 💎 **Event Detection**: Identify significant trading events (price surges, public figure mentions, regulatory announcements)
- 💰 **Market Context**: Optional Binance integration for real-time crypto prices with Gemini fallback
- 🎯 **Smart Deduplication**: In-memory cache prevents duplicate alerts for the same event category within 6-hour TTL
- ⚡ **Retry Logic**: Automatic retry with exponential backoff for failed deliveries
- 🔄 **Graceful Degradation**: Continue operating if one channel is unavailable
- ⏱️ **Parallel Processing**: Analyze multiple symbols concurrently with intelligent timeout management

## Environment Configuration

### Required Variables

- `BOT_TOKEN` - Telegram bot token (from BotFather). Required only when `ENABLE_TELEGRAM_BOT=true` and the app is expected to launch Telegraf outside PR previews
- `TELEGRAM_CHAT_ID` - Telegram chat ID where alerts are sent
- `ENABLE_TELEGRAM_BOT` - Enable Telegram bot (`true` or `false`)

### Optional Variables

#### Security

- `WEBHOOK_API_KEY` - API key used to secure `/api/*` endpoints. When configured, clients must provide the key via the `x-api-key` header (or the `api-key` query parameter)

#### WhatsApp Alerts (GreenAPI)

- `ENABLE_WHATSAPP_ALERTS` - Enable WhatsApp alerts (`true` or `false`, default: `false`)
- `WHATSAPP_API_URL` - GreenAPI endpoint URL (e.g., `https://7107.api.green-api.com/waInstance7107356806/`)
- `WHATSAPP_API_KEY` - GreenAPI API key for authentication
- `WHATSAPP_CHAT_ID` - Destination WhatsApp chat/group ID (format: `120363xxxxx@g.us`)

#### Discord Alerts (Webhook)

- `ENABLE_DISCORD_ALERTS` - Enable Discord alerts (`true` or `false`, default: `false`)
- `DISCORD_WEBHOOK_URL` - Discord webhook URL (e.g., `https://discord.com/api/webhooks/<id>/<token>`)

#### URL Shortening (004-url-shortening)

- `BITLY_API_KEY` - Bitly API key for URL shortening (optional; when provided, long URLs in WhatsApp alerts are automatically shortened)

#### AI Grounding

- `ENABLE_GEMINI_GROUNDING` - Enable Gemini-based alert enrichment (`true` or `false`)
- `GEMINI_API_KEY` - Google API key for Gemini access

#### Langfuse Prompt Management

- `ENABLE_LANGFUSE_PROMPTS` - Fetch runtime prompts from Langfuse (`true` or `false`, default: `false`)
- `LANGFUSE_PUBLIC_KEY` - Langfuse public key (required when Langfuse prompt management is enabled)
- `LANGFUSE_SECRET_KEY` - Langfuse secret key (required when Langfuse prompt management is enabled)
- `LANGFUSE_BASE_URL` - Langfuse base URL (default: `https://cloud.langfuse.com`)
- `LANGFUSE_PROMPT_LABEL` - Prompt label to fetch (default: `latest` in local/dev/test, `production` in production-like environments)
- `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` - Prompt cache TTL in seconds (default: `0` for `latest`, `60` for `production`)

#### TradingView MCP Analysis

- `ENABLE_TRADINGVIEW_MCP_ENRICHMENT` - Enable TradingView MCP enrichment for TradingView-like webhook messages (`true` or `false`, default: `false`)
- `EXPANDED_ANALYSIS_ALERT_SYMBOLS` - Comma-separated fallback symbols for `/api/webhook/expanded-analysis-alert` using `EXCHANGE:SYMBOL` format (for example `BINANCE:BTCUSDT,NASDAQ:NVDA`)
- `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS` - Total analysis deadline for `/api/webhook/expanded-analysis-alert` in milliseconds (default: `60000`, capped at `120000`)
- `TRADINGVIEW_MCP_URL` - MCP server HTTP endpoint (default: `https://tradingview-mcp.onrender.com/mcp`)
- `TRADINGVIEW_MCP_TIMEOUT_MS` - Timeout per MCP request in milliseconds (default: `12000`)
- `TRADINGVIEW_MCP_MAX_RETRIES` - Retries for MCP failures (default: `3`)
- `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS` - Total budget envelope for the synchronous webhook enrichment flow (default: `12000`). When exceeded, all in-flight MCP calls are aborted and the enrichment fails open, preventing the alert webhook from being blocked for too long.
- `TRADINGVIEW_MCP_DEFAULT_EXCHANGE` - Default exchange when not present in signal (default: `BINANCE`)
- `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` - Default timeframe fallback (default: `1D` for `/api/webhook/expanded-analysis-alert`, `1h` for webhook signal enrichment)
- `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION` - Enable volume confirmation validation for TradingView alerts (`true` or `false`, default: `false`)
- `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT` - Enable optional `combined_analysis` confluence enrichment for TradingView webhook alerts (`true` or `false`, default: `false`)
- `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME` - Also call `multi_timeframe_analysis` during confluence enrichment (`true` or `false`, default: `false`)
- Runtime gate: TradingView MCP data is only used when webhook requests include `?useTradingViewData=true`

#### Firestore Alert Storage

- `ENABLE_FIRESTORE_ALERT_STORAGE` - Enable Firestore persistence and alert read API (`true` or `false`, default: `false`)
- `ENABLE_FIRESTORE_JOB_STORAGE` - Enable Firestore persistence for async TradingView jobs without enabling alert read APIs (`true` or `false`, default: `false`)
- `FIREBASE_SERVICE_ACCOUNT_JSON` - Inline Firebase service account JSON for server-side Firestore access
- `FIREBASE_PROJECT_ID` - Optional Firebase project override for Admin SDK initialization
- `GOOGLE_APPLICATION_CREDENTIALS` - Optional path to a service account JSON file for local development

#### Admin Notifications

- `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` - Chat ID for deployment alerts and fail-open notification-channel failure pages

#### Server Configuration

- `PORT` - HTTP server port (default: `80`)
- `RENDER` - Render.com deployment flag (used internally)
- `IS_PULL_REQUEST` - Render preview environment flag (disables bot in PRs)
- `LOG_LEVEL` - Structured JSON log verbosity (`debug`, `info`, `warn`, `error`, `silent`; defaults to `debug` in development and `info` in production)
- `SERVICE_NAME` - Optional service name included in JSON logs (default: package name or `cabros-bot`)

#### News Monitoring (003-news-monitor)

- `ENABLE_NEWS_MONITOR` - Enable news monitoring endpoint (`true` or `false`, default: `false`)
- `NEWS_SYMBOLS_CRYPTO` - Default crypto symbols if not provided in request (comma-separated, e.g., `BTCUSDT,ETHUSD`)
- `NEWS_SYMBOLS_STOCKS` - Default stock symbols if not provided in request (comma-separated)
- `NEWS_ALERT_THRESHOLD` - Confidence score threshold for sending alerts (default: `0.7`, range 0.0-1.0)
- `NEWS_CACHE_TTL_HOURS` - Cache time-to-live for deduplication (default: `6` hours)
- `NEWS_TIMEOUT_MS` - Per-symbol analysis timeout (default: `30000` ms)
- `NEWS_GEMINI_CONCURRENCY` - Optional max concurrent Gemini-backed symbol analyses. Unset keeps legacy parallel fan-out.
- `NEWS_GEMINI_QUOTA_MAX_RETRIES` - Max per-symbol retries for Gemini `429 RESOURCE_EXHAUSTED` errors (default: `2`)
- `NEWS_GEMINI_QUOTA_RETRY_BASE_MS` - Base exponential backoff when Gemini does not provide retry delay metadata (default: `1000` ms)
- `ENABLE_BINANCE_PRICE_CHECK` - Enable Binance crypto price fetching (`true` or `false`, default: `false`)
- `ENABLE_LLM_ALERT_ENRICHMENT` - Enable optional secondary LLM enrichment (`true` or `false`, default: `false`)
- `AZURE_LLM_ENDPOINT` - Azure AI Inference endpoint URL (required if enrichment enabled)
- `AZURE_LLM_KEY` - Azure AI Inference API key (required if enrichment enabled)
- `AZURE_LLM_MODEL` - Azure AI LLM model name (e.g., `gpt-4o`, required if enrichment enabled)

#### Runtime Error Monitoring (005-sentry-runtime-errors)

- `ENABLE_SENTRY` - Enable Sentry error reporting (`true` or `false`, default: `false`)
- `SENTRY_DSN` - Sentry Data Source Name (DSN) from your Sentry project settings
- `SENTRY_ENVIRONMENT` - Explicit environment tag (`production`, `preview`, `development`). Auto-derived if not set
- `SENTRY_RELEASE` - Explicit release tag (e.g., `v1.2.3`). Auto-derived from git commit if not set
- `SENTRY_SEND_ALERT_CONTENT` - Include alert text in error events (`true` or `false`, default: `true`)
- `SENTRY_SAMPLE_RATE_ERRORS` - Error sample rate from 0.0 to 1.0 (default: `1.0` = 100%)
- `SENTRY_TRACES_SAMPLE_RATE` - Trace sample rate from 0.0 to 1.0 (leave unset to disable tracing and custom spans)
- `SENTRY_PROFILE_SESSION_SAMPLE_RATE` - Profiling session sample rate from 0.0 to 1.0 (leave unset to disable profiling; requires `SENTRY_TRACES_SAMPLE_RATE` to be set)
- `SENTRY_CONSOLE_LOG_LEVELS` - Comma-separated console levels sent as Sentry Logs (default: `warn,error`; allowed: `debug`, `info`, `warn`, `error`, `log`, `assert`, `trace`)
- `ENABLE_SENTRY_DEBUG_ROUTE` - Mount `GET /debug-sentry` only for explicit local/manual validation (`true` enables it; default disabled so normal runtime returns `404`)
- Sentry Logs are enabled automatically when `ENABLE_SENTRY=true`; configured console levels are sent as Sentry Logs.

#### TradingView Market Scanner Alerts

- `ENABLE_MARKET_SCANNER` - Enable market scanner endpoint (`true` or `false`, default: `false`)
- `MARKET_SCANNER_DEFAULT_EXCHANGE` - Default exchange when not provided in request (default: `BINANCE`)
- `MARKET_SCANNER_TIMEOUT_MS` - Timeout in milliseconds for scanner webhook process (default: `90000`, max `120000`)

## Setup

### 1. Install Dependencies

```bash
pnpm install --frozen-lockfile
```

### 2. Create `.env` File

Copy the `.env.example` file (which serves as the canonical operator template) to `.env` and fill in your configuration values:

```bash
cp .env.example .env
```

Then edit `.env` with your specific values. See `.env.example` for complete documentation of all available environment variables organized by category:

- **Required**: Core bot token and chat IDs
- **Optional: Security**: API Key configuration to secure webhook endpoints
- **Optional: WhatsApp**: GreenAPI integration for multi-channel alerts
- **Optional: AI Grounding**: Gemini API for alert enrichment
- **Optional: Prompt Management**: Langfuse-backed runtime prompts with local fallbacks
- **Optional: TradingView MCP**: Real-time technical enrichment for webhook signals
- **Optional: Admin Notifications**: Separate chat for deployment alerts
- **Optional: Server Configuration**: Port, Render.com flags
- **Optional: News Monitoring**: Feature flags and thresholds
- **Optional: Binance Integration**: Real-time crypto prices
- **Optional: Secondary LLM**: Azure AI or GitHub Models enrichment

See [Environment Configuration](#environment-configuration) section below for detailed descriptions of each variable.

### 3. Run Development Server

```bash
pnpm start-dev
```

### 4. Run Production Server

```bash
pnpm start
```

## API Endpoints

The canonical API contract is served publicly at [`/openapi.json`](http://localhost:80/openapi.json), with interactive Swagger UI at [`/docs`](http://localhost:80/docs). Use those endpoints for request schemas, response shapes, examples, and the current route inventory. Protected `/api` operations still require `x-api-key`; the documentation endpoints never expose configured credentials.

### GET /healthcheck

Health check endpoint.

**Response:**
```json
{"uptime":"..."}
```

### GET /api/status

Machine-readable runtime status for operational tooling. This endpoint uses the same `WEBHOOK_API_KEY` protection as other `/api` endpoints when that environment variable is configured. Send the key with the `x-api-key` header.

The response intentionally exposes only non-sensitive booleans and metadata: service identity, version, commit, environment, feature-flag state, delivery channel readiness, and dependency readiness/configuration status. Secret values such as bot tokens, API keys, DSNs, chat IDs, and provider URLs are not returned.

For `ENABLE_NEWS_MONITOR=true`, the payload also reports the primary LLM dependency used by that flow as `dependencies.newsMonitorLlm`, including the resolved provider (`gemini`, `azure`, or `openrouter`) and whether that provider is actually configured for runtime use. When `FORCE_BRAVE_SEARCH=true`, the payload also exposes `dependencies.braveSearch` so the forced search path can be monitored independently of Gemini. When `ENABLE_GEMINI_GROUNDING=true` and `MODEL_PROVIDER=gemini`, `dependencies.gemini` requires both `GEMINI_API_KEY` and `GEMINI_MODEL_NAME`, matching the runtime path used for grounded alert generation. Firestore readiness treats `GOOGLE_APPLICATION_CREDENTIALS` as configured only when the referenced credential file exists and is readable.

When `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`, `featureFlags.tradingViewVolumeConfirmation` reports the gate value and `dependencies.tradingViewVolumeConfirmation` reports readiness only when the configured TradingView MCP endpoint and its parent MCP enrichment gate are active.

When `ENABLE_FIRESTORE_JOB_STORAGE=true`, `featureFlags.firestoreJobStorage` reports the async-job persistence gate and `dependencies.firestoreJobStorage` reports readiness using the configured Firestore credentials. The legacy `ENABLE_FIRESTORE_ALERT_STORAGE=true` gate also reports job storage as enabled because it activates the same runtime persistence path.

`GET /api/capabilities` is an alias for the same payload.

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
    "tradingViewMcpEnrichment": true,
    "tradingViewVolumeConfirmation": false,
    "firestoreAlertStorage": true,
    "firestoreJobStorage": false,
    "sentryMonitoring": true,
    "langfusePrompts": false,
    "marketScanner": true,
    "binancePriceCheck": false,
    "llmAlertEnrichment": false
  },
  "deliveryChannels": {
    "telegram": { "enabled": true, "status": "ready" },
    "whatsapp": { "enabled": false, "status": "disabled" }
  },
  "dependencies": {
    "telegram": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "whatsapp": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "gemini": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "tradingViewMcp": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "tradingViewVolumeConfirmation": { "enabled": false, "configured": true, "ready": false, "status": "disabled" },
    "firestore": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "firestoreJobStorage": { "enabled": false, "configured": true, "ready": false, "status": "disabled" },
    "sentry": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "langfuse": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "braveSearch": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "newsMonitorLlm": { "provider": "gemini", "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "llmAlertEnrichment": { "enabled": false, "configured": false, "ready": false, "status": "disabled" }
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

## TradingView Signal Enrichment with MCP

When `ENABLE_TRADINGVIEW_MCP_ENRICHMENT=true`, webhook alerts matching TradingView-style patterns (for example `BTCUSDT(240) pasó a señal de VENTA`) are enriched with real technical data from the TradingView MCP server **only if the webhook request includes `?useTradingViewData=true`**.

### How It Works

1. Webhook receives alert text and the request includes `useTradingViewData=true`.
2. System detects TradingView signal pattern (`SYMBOL(TF)` + side `VENTA/COMPRA` or `SELL/BUY`).
3. If TradingView pattern is detected, it queries `coin_analysis` via MCP and uses that output as an **additional real-time technical source**.
4. If `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true`, it also calls `combined_analysis` inside the same enrichment budget and annotates or downgrades the signal when confluence contradicts the webhook side.
5. If `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true`, it also calls `multi_timeframe_analysis` and returns the raw multi-timeframe metadata in dry-run/stored enrichment data.
6. Gemini/Brave grounding still runs when enabled, and the final `alert.enriched` merges grounding context + MCP technical data.
7. If either provider fails, the flow degrades gracefully to the other provider (or original text if none succeed).

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
  "bbw_threshold": 0.05
}
```

- `exchange`: (Optional) The exchange identifier to run scans against. Defaults to `MARKET_SCANNER_DEFAULT_EXCHANGE` or `BINANCE`.
- `timeframe`: (Optional) Interval for indicators (e.g. `5m`, `15m`, `1h`, `4h`, `1D`, `1W`, `1M`). Defaults to `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` or `4h`.
- `scans`: (Optional) Array of scan types to execute sequentially. Defaults to `['top_gainers', 'top_losers', 'volume_breakout_scanner']`.
- `limit`: (Optional) Max number of results per section (clamped to `[1, 20]`, default: `5`).
- `bbw_threshold`: (Optional) Bollinger Band Width threshold for the Bollinger squeeze scan (default: `0.05`).

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
  "timeoutMs": 90000,
  "requestId": "req-xyz789",
  "totalDurationMs": 1450
}
```

### POST /api/webhook/alert

Send alert via webhook. Accepts either JSON or plain text.

Optional query param: `useTradingViewData=true` enables TradingView MCP technical enrichment for this request (requires `ENABLE_TRADINGVIEW_MCP_ENRICHMENT=true`).

**Request (JSON):**
```json
{
  "text": "BTC price is at $45,000 - breakout detected!"
}
```

**Request (Plain Text):**
```
Content-Type: text/plain

BTC price is at $45,000 - breakout detected!
```

**Response:**
```json
{
  "success": true,
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

To run long-running technical analysis or market scans without hitting HTTP request limits or gateway timeouts (502/504), you can use the asynchronous jobs API. Both endpoints require the `x-api-key` header to be configured.

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
  "limit": 5
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "status": "processing",
  "createdAt": "2026-05-25T01:30:00.000Z"
}
```

#### GET /api/jobs/:jobId

Retrieve status, partial progress, final report, and delivery state of a job.
Jobs are retained in memory and, when Firestore job storage is enabled, persisted to the `tradingviewJobs` collection so status survives process restarts. Completed and failed jobs are automatically evicted after 1 hour.

Set `ENABLE_FIRESTORE_JOB_STORAGE=true` plus the normal Firebase Admin credentials (`FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`) to enable durable job storage. The legacy in-memory path remains the fallback when Firestore is disabled or unavailable.

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

When `ENABLE_FIRESTORE_ALERT_STORAGE=true`, successful `POST /api/webhook/alert` requests are persisted to Firestore and can be inspected through the protected alerts read API.

All endpoints below require the same `x-api-key` header used by the webhook routes.
If alert storage is enabled but Firestore credentials/project access are unavailable, they return `503 STORAGE_UNAVAILABLE` instead of a generic `500`.

#### GET /api/alerts

List stored alerts ordered by `receivedAt` descending.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either a legacy ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `source` - Optional source filter (current writes use `webhook`)
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
      "useTradingViewData": false
    }
  ],
  "pagination": {
    "hasMore": false,
    "limit": 50,
    "nextBefore": "eyJ2IjoxLCJyZWNlaXZlZEF0IjoiMjAyNi0wNi0wNlQxMjowMDowMC4wMDBaIiwiaWQiOiJhbGVydC0xIn0"
  }
}
```

#### GET /api/alerts/summary

Return bounded JSON-only analytics for stored alerts without exposing raw alert text or credentials.

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
      "withoutTradingViewData": 1
    },
    "enrichment": {
      "enrichedAlerts": 1,
      "plainAlerts": 1,
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

#### GET /api/alerts/:alertId

Retrieve a single stored alert by Firestore document ID.

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
    "useTradingViewData": true
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

## Multi-Channel Alerts (002)

The alert webhook system supports simultaneous delivery to multiple channels (Telegram, WhatsApp, and Discord) with independent retry logic and graceful degradation.

### Supported Channels

#### Telegram (Default)

- **Enabled by**: `ENABLE_TELEGRAM_BOT=true` + valid `BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- **Format**: MarkdownV2 with special character escaping
- **Timeout**: ~10 seconds per delivery
- **Retry**: 3 attempts with exponential backoff (1s → 2s → 4s)

#### WhatsApp (Optional)

- **Enabled by**: `ENABLE_WHATSAPP_ALERTS=true` + GreenAPI credentials
- **Format**: WhatsApp markdown (bold, italic, strikethrough, code blocks, lists)
- **Timeout**: ~10 seconds per delivery  
- **Retry**: 3 attempts with exponential backoff (1s → 2s → 4s)
- **Message Size**: Automatically truncated to 20,000 characters with "…" suffix if needed
- **Provider**: GreenAPI (REST API via native fetch)

#### Discord (Optional)

- **Enabled by**: `ENABLE_DISCORD_ALERTS=true` + valid `DISCORD_WEBHOOK_URL`
- **Format**: Plain Discord webhook content with Markdown-friendly text
- **Timeout**: ~10 seconds per delivery
- **Retry**: Single request per delivery
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

When `BITLY_API_KEY` is configured, URLs in WhatsApp alerts are automatically shortened to reduce character count and improve readability.

**Features**:
- **Automatic Detection**: Identifies HTTP/HTTPS URLs in alert text
- **Shortened URLs**: Converts long URLs (e.g., `https://example.com/very/long/path?param=value`) to short Bitly links (e.g., `https://bit.ly/abc123`)
- **Session-Scoped Cache**: Caches shortenings during request processing to avoid redundant API calls (1-hour TTL per session)
- **Parallel Shortening**: Multiple URLs shortened concurrently
- **Fallback Behavior**: If shortening fails or is disabled, original URLs are preserved
- **Graceful Degradation**: Shortening errors don't block alert delivery

**How It Works**:
1. Alert received with one or more URLs
2. URLShortener detects and extracts URLs (if `BITLY_API_KEY` configured)
3. Checks session cache for previously shortened URLs
4. Calls Bitly API for new URLs (with 3-retry exponential backoff)
5. Replaces original URLs with shortened versions in alert text
6. Alert delivered to WhatsApp (and other channels) with shortened URLs

**Configuration**:
- Set `BITLY_API_KEY` environment variable with your Bitly API key
- Optional: URLs only shortened for WhatsApp; other channels receive original URLs
- Cache per session: TTL 1 hour; cleared after request completes or session ends

**Example**:

**Before** (158 characters):
```
Sources: 
- https://example.com/research/crypto/bitcoin/technical-analysis?date=2024-01-15&symbol=BTCUSDT&period=4h&includeIndicators=true
```

**After** (with Bitly):
```
Sources: 
- https://bit.ly/crypto-analysis
```

### Delivery Behavior

**Parallel Sending**: Alerts sent to all enabled channels simultaneously without blocking

**Independent Retry**: Each channel retries independently
- Channel A failure doesn't affect Channel B
- Retry timing: 1s → 2s → 4s (max 3 attempts)
- Jitter: ±10% to prevent thundering herd

**Graceful Degradation**: If one channel fails
- Other channels still receive the alert
- Response includes per-channel results
- HTTP 200 OK returned (fail-open pattern)
- Failures logged at WARN/ERROR level
- If `channels` is omitted in the generic message webhook, delivery fans out to every enabled channel

**Example - Dual Channel Delivery**:

```bash
# Alert sent to both Telegram and WhatsApp
curl -X POST https://your-domain/api/webhook/alert \
  -H "Content-Type: application/json" \
  -d '{
    "text": "BTCUSDT: Price surge to $45,000 detected!"
  }'

# Response shows both channels received the message
{
  "success": true,
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "12345",
      "attemptCount": 1,
      "durationMs": 450
    },
    {
      "channel": "whatsapp",
      "success": true,
      "messageId": "msg-uuid-123",
      "attemptCount": 1,
      "durationMs": 320
    }
  ],
  "enriched": false
}
```

**Example - Partial Failure (WhatsApp Down)**:

```json
{
  "success": false,
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "12345",
      "attemptCount": 1,
      "durationMs": 450
    },
    {
      "channel": "whatsapp",
      "success": false,
      "error": "API timeout after 3 retries",
      "attemptCount": 3,
      "durationMs": 7800
    }
  ],
  "enriched": false
}
```

### Configuration for Multi-Channel

```bash
# Telegram (required only when the Telegram bot is enabled outside PR previews)
ENABLE_TELEGRAM_BOT=true
BOT_TOKEN=your_telegram_token
TELEGRAM_CHAT_ID=-1001234567890

# WhatsApp (optional)
ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=https://7107.api.green-api.com/waInstance7107356806/
WHATSAPP_API_KEY=your_greenapi_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# Discord (optional)
ENABLE_DISCORD_ALERTS=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>

# Optional enrichment (applies to all channels)
ENABLE_GEMINI_GROUNDING=true
GEMINI_API_KEY=your_google_ai_studio_api_key
```

### Troubleshooting Multi-Channel Delivery

**Multiple channels failing**:
1. Verify network connectivity from server
2. If `ENABLE_TELEGRAM_BOT=true`, check BOT_TOKEN validity (Telegram)
3. Check GreenAPI credentials and account status (WhatsApp)
4. Verify `DISCORD_WEBHOOK_URL` is still valid and not revoked (Discord)
5. Review application logs for detailed error messages

**API-only or WhatsApp-only startup**:
1. Set `ENABLE_TELEGRAM_BOT=false`
2. Omit `BOT_TOKEN` if Telegram is intentionally disabled
3. Keep using `/api` routes and non-Telegram channels normally

**WhatsApp not sending**:
1. Verify `ENABLE_WHATSAPP_ALERTS=true`
2. Check `WHATSAPP_CHAT_ID` format (should be `120363xxxxx@g.us`)
3. Verify GreenAPI account is active
4. Test API directly: `curl -X POST https://api.green-api.com/test`

**Discord not sending**:
1. Verify `ENABLE_DISCORD_ALERTS=true`
2. Check `DISCORD_WEBHOOK_URL` format and channel permissions
3. Confirm the webhook has not been deleted or regenerated in Discord

**Message truncation**:
- WhatsApp automatically truncates messages > 20,000 characters
- Use MarkdownV2 formatting to reduce character count
- For very long alerts, consider summarizing before sending

**Retry exhaustion**:
- If all 3 retries fail, alert is not re-attempted
- Total maximum wait per channel: ~7.8 seconds (1 + 2 + 4 seconds)
- Check server logs for transient network/API issues

## Commands

### /precio `<symbol>`

Get crypto price from Binance.

**Example:**
```
/precio BTCUSDT
```

**Response:**
```
Precio de BTCUSDT es $45,000.50
```

### /cryptobot

Crypto bot help command.

## Runtime Error Monitoring (005-sentry-runtime-errors)

**📖 [Quickstart Guide](specs/005-sentry-runtime-errors/quickstart.md)** — Complete setup and verification instructions.

The runtime error monitoring feature captures unexpected errors across all application flows and reports them to Sentry for centralized visibility and debugging.
When enabled, it also forwards configured console levels to Sentry Logs using the JavaScript SDK console logging integration.

### Monitored Flows

- **Alert Webhook** (`/api/webhook/alert`): HTTP errors during alert processing
- **News Monitor** (`/api/news-monitor`): Analysis errors and service failures
- **Telegram Commands** (`/precio`, `/cryptobot`): Bot command handler errors
- **WhatsApp Delivery**: Notification delivery failures after retry exhaustion
- **Process Level**: Uncaught exceptions and unhandled promise rejections

### Features

- **Non-Intrusive**: Monitoring failures never affect HTTP responses or message delivery
- **Environment Gating**: Auto-derives environment from Render.com variables (`production`, `preview`, `development`)
- **Privacy Controls**: Optional exclusion of alert content from error events
- **Structured Console Logs**: All `console.*` output is emitted as one-line JSON with `timestamp`, `level`, `message`, `service`, `environment`, and optional `attributes`, `parameters`, and `error`
- **Console Log Capture**: Configured console levels are captured as searchable Sentry Logs
- **Optional Tracing/Spans**: Enable transaction traces plus custom spans for alert processing, news analysis, and multi-channel delivery
- **Graceful Degradation**: Works without affecting existing fallback mechanisms

### Configuration

```bash
# Enable Sentry (required)
ENABLE_SENTRY=true
SENTRY_DSN=https://key@o123.ingest.sentry.io/456

# Optional: Explicit environment (auto-derived if not set)
SENTRY_ENVIRONMENT=production

# Optional: Explicit release (derived from RENDER_GIT_COMMIT if not set)
SENTRY_RELEASE=v1.2.3

# Optional: Privacy control (default: true = include alert text)
SENTRY_SEND_ALERT_CONTENT=false

# Optional: Error sampling (default: 1.0 = 100%)
SENTRY_SAMPLE_RATE_ERRORS=1.0

# Optional: Trace sampling (leave unset to disable tracing)
SENTRY_TRACES_SAMPLE_RATE=0.1

# Optional: Console log levels captured as Sentry Logs (default: warn,error)
SENTRY_CONSOLE_LOG_LEVELS=warn,error
```

### Environment Auto-Detection

| Condition | Environment |
|-----------|-------------|
| `SENTRY_ENVIRONMENT` set | Uses explicit value |
| `RENDER=true` + `IS_PULL_REQUEST=true` | `preview` |
| `RENDER=true` (no PR) | `production` |
| `NODE_ENV=production` | `production` |
| Default | `development` |

### Troubleshooting

**Errors not appearing in Sentry**:
1. Verify `ENABLE_SENTRY=true` and `SENTRY_DSN` is set
2. Check application logs for `[SentryService] Monitoring disabled` message
3. Verify DSN format: `https://<key>@<org>.ingest.sentry.io/<project>`

**Console warnings/errors not appearing in Sentry Logs**:
1. Verify the installed `@sentry/node` version is `10.53.1` or newer
2. Confirm Sentry initialized with `enableLogs: true`
3. Confirm `SENTRY_CONSOLE_LOG_LEVELS` includes the level you are testing
4. Check the Sentry Logs view, not only the Issues view

**Manual Sentry error validation**:
1. Keep `ENABLE_SENTRY_DEBUG_ROUTE` unset in production and preview environments
2. For local-only validation, start the app with `ENABLE_SENTRY_DEBUG_ROUTE=true`
3. Request `GET /debug-sentry` locally to trigger the intentional test error
4. Remove the flag again after validation so the route falls back to `404`

**Expected behaviors not reporting** (by design):
- Validation errors (400 responses) are not reported
- Feature-disabled responses (403) are not reported
- These are expected behaviors, not runtime errors

## News Monitoring & Event Detection

**📖 [Full Quickstart specs/003-news-monitor/quickstart.md(Guide] Complete setup instructions, API reference, and advanced configuration.)** 

**🔄 [Scheduled Monitoring Example](.github/workflows/news-monitor-cron.yml.example)** — GitHub Actions workflow for periodic symbol analysis.

The news monitoring feature analyzes financial news and market sentiment to detect significant trading events automatically. When enabled, it provides real-time alerts about:

- **Price Surges** (>5% gains): Triggered by positive news, bullish sentiment, and significant price movements
- **Price Declines** (>5% losses): Triggered by negative news, bearish sentiment, and significant downturns
- **Public Figure Mentions**: Detects statements from influential personalities affecting asset prices
- **Regulatory Announcements**: Identifies official statements and regulatory changes

### Confidence Scoring

Each alert receives a confidence score (0.0-1.0) using the formula:
```
confidence = (0.6 × event_significance + 0.4 × |sentiment_score|)
```

Where:
- **event_significance** (0.0-1.0): Based on price movement magnitude, source credibility, and mention frequency
- **sentiment_score** (-1.0 to +1.0): Extracted from news articles (-1.0 = bearish, +1.0 = bullish)

Only alerts meeting `NEWS_ALERT_THRESHOLD` (default: 0.7) are sent to channels.

### Deduplication Strategy

The system prevents alert fatigue using an intelligent cache:
- **Cache Key**: `(symbol, event_category)` tuple
- **TTL**: 6 hours by default (configurable via `NEWS_CACHE_TTL_HOURS`)
- **Behavior**: Same event category for the same symbol within TTL is cached; different categories generate separate alerts
- **Example**: BTCUSDT receives one "price_surge" alert at 10:00; calling the endpoint at 11:00 returns cached result. But a "regulatory" alert for BTCUSDT at 11:30 generates a new alert (different category).
- **Enrichment Cache**: When secondary LLM enrichment is enabled (`ENABLE_LLM_ALERT_ENRICHMENT=true`), both primary analysis results AND enrichment results are cached under the same `(symbol, event_category)` key with the same TTL. This prevents redundant Gemini and LLM API calls for duplicate events. If enrichment fails, the original Gemini analysis is cached, and enrichment is not re-attempted until the cache entry expires.

### Timeout Strategy

- **Binance (crypto prices)**: ~5 seconds (aggressive)
- **Gemini (news analysis)**: ~20 seconds (fallback)
- **Optional LLM Enrichment**: ~10 seconds per symbol
- **Per-symbol Total**: 30 seconds (accounts for retry scenarios)
- **Batch Response**: Returns partial results if some symbols timeout

## Running Tests

```bash
# Run all tests
pnpm test

# Run with watch mode
pnpm test:watch

# Generate coverage report
pnpm test:coverage
```

## Architecture

### Notification Services

- **NotificationChannel**: Abstract base class for notification channels
- **TelegramService**: Implements Telegram delivery via Telegraf bot
- **WhatsAppService**: Implements WhatsApp delivery via GreenAPI
- **NotificationManager**: Orchestrates sending to multiple channels in parallel

### News Monitoring Services

- **NewsMonitor Controller** (`src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`): HTTP endpoint handler
- **Analyzer** (`src/controllers/webhooks/handlers/newsMonitor/analyzer.js`): Symbol analysis orchestrator with parallel processing
- **Cache** (`src/controllers/webhooks/handlers/newsMonitor/cache.js`): In-memory deduplication cache with TTL enforcement
- **Enrichment Service** (`src/services/inference/enrichmentService.js`): Optional secondary LLM for confidence refinement

### Grounding Services

- **Gemini Grounding** (`src/services/grounding/`): Reusable Gemini API integration for news sentiment analysis
- **Confidence Scoring**: Weighted formula combining event significance and sentiment
- **Event Detection**: Price surge, price decline, public figure mentions, regulatory announcements

### Supporting Utilities

- **retryHelper**: Exponential backoff retry logic (1s → 2s → 4s)
- **messageHelper**: Message truncation and formatting
- **MarkdownV2Formatter**: Telegram MarkdownV2 text escaping
- **WhatsAppMarkdownFormatter**: WhatsApp markdown conversion
- **PromptService** (`src/services/prompts/`): Centralized runtime prompt registry with Langfuse fetch + local file-based fallback behavior

### Alert Processing (News Monitor)

1. **Request Received** → Validate crypto/stock symbol arrays
2. **Parallel Analysis** → Analyze each symbol concurrently (30s timeout per symbol)
3. **Gemini Extraction** → Detect market sentiment and event categories
4. **Confidence Scoring** → Calculate alert confidence using weighted formula
5. **Optional Enrichment** → Secondary LLM refines confidence (if enabled)
6. **Threshold Filtering** → Only alerts meeting `NEWS_ALERT_THRESHOLD` proceed
7. **Deduplication** → Check cache for duplicate (symbol, event_category) pairs
8. **Multi-Channel Sending** → Send to all enabled channels in parallel
9. **Retry Logic** → Each channel retries independently with exponential backoff
10. **Response** → Return 200 OK with per-symbol results and metadata

### Alert Processing (Traditional Webhook)

1. **Webhook Received** → Validate alert text
2. **Optional Enrichment** → Gemini grounding (if enabled)
3. **Multi-Channel Sending** → Send to all enabled channels in parallel
4. **Retry Logic** → Each channel retries independently with backoff
5. **Response** → Return 200 OK with per-channel results

## Configuration Examples

### Telegram Only (Default)

```bash
BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=-1001234567890
ENABLE_TELEGRAM_BOT=true
```

### Telegram + WhatsApp

```bash
BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=telegram_chat_id
ENABLE_TELEGRAM_BOT=true

ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=your_whatsapp_api_url
WHATSAPP_API_KEY=your_whatsapp_api_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# Optional: Enable URL shortening for WhatsApp
BITLY_API_KEY=your_bitly_api_key
```

### With WhatsApp + URL Shortening

```bash
BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=telegram_chat_id
ENABLE_TELEGRAM_BOT=true

ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=your_whatsapp_api_url
WHATSAPP_API_KEY=your_whatsapp_api_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# URL shortening for WhatsApp (long URLs automatically shortened via Bitly)
BITLY_API_KEY=your_bitly_api_key

# Alerts sent to both channels; WhatsApp receives shortened URLs
```

### With Gemini Enrichment

```bash
ENABLE_GEMINI_GROUNDING=true
GEMINI_API_KEY=your_google_ai_studio_api_key

# Alerts will be enriched with AI analysis before sending
```

### With Langfuse Prompt Management

```bash
ENABLE_LANGFUSE_PROMPTS=true
LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
LANGFUSE_SECRET_KEY=sk-lf-your-secret-key
LANGFUSE_BASE_URL=https://cloud.langfuse.com

# Use "latest" locally and "production" in deployed environments
LANGFUSE_PROMPT_LABEL=latest
LANGFUSE_PROMPT_CACHE_TTL_SECONDS=0
```

With this enabled, prompt edits can be shipped from Langfuse without redeploying the bot. If Langfuse is unavailable, the service falls back to the local prompt registry automatically.

### With News Monitoring (Gemini-only)

```bash
BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=telegram_chat_id
ENABLE_TELEGRAM_BOT=true

ENABLE_NEWS_MONITOR=true
GEMINI_API_KEY=your_google_ai_studio_api_key
NEWS_SYMBOLS_CRYPTO=BTCUSDT,ETHUSD,BNBUSDT
NEWS_SYMBOLS_STOCKS=NVDA,MSFT,AAPL
NEWS_ALERT_THRESHOLD=0.7

# External scheduler (GitHub Actions, Render cron) calls:
# curl -X POST https://your-domain/api/news-monitor \
#   -H "Content-Type: application/json" \
#   -d '{"crypto":["BTCUSDT"],"stocks":["NVDA"]}'
```

### With News Monitoring + Binance Integration

```bash
ENABLE_NEWS_MONITOR=true
ENABLE_BINANCE_PRICE_CHECK=true
NEWS_SYMBOLS_CRYPTO=BTCUSDT,ETHUSD

# Real-time crypto prices fetched from Binance (~5s timeout)
# Falls back to Gemini GoogleSearch if Binance unavailable
```

### With Optional Secondary LLM Enrichment

```bash
ENABLE_NEWS_MONITOR=true
ENABLE_LLM_ALERT_ENRICHMENT=true
AZURE_LLM_ENDPOINT=https://models.github.ai/inference
AZURE_LLM_KEY=your_github_personal_access_token
AZURE_LLM_MODEL=openai/gpt-5-mini

# Secondary LLM refines confidence using conservative strategy:
# enriched_confidence = min(gemini_confidence, llm_confidence)
# Prevents false positives from LLM hallucination
```

## Deployment

### Render.com

The application includes support for Render.com deployment:

- Respects `RENDER` environment variable
- Skips bot launch in preview environments (`IS_PULL_REQUEST=true`)
- Sends deployment notification to admin chat on startup

### Local Development

```bash
# Start dev server with auto-reload
pnpm start-dev

# Open ngrok tunnel for webhook testing
ngrok http 80

# Use ngrok URL for TradingView webhooks
# https://your-ngrok-domain.ngrok.io/api/webhook/alert
```

## Monitoring

### Health Check

```bash
curl http://localhost/healthcheck
```

### Logs

The application logs to stdout:

- `INFO`: Bot initialization, webhook received, alerts sent
- `DEBUG`: Detailed processing steps
- `WARN`: Configuration warnings, retry attempts
- `ERROR`: Delivery failures, API errors

## Troubleshooting

### News Monitoring Issues

#### News Monitor Endpoint Not Responding

1. Verify `ENABLE_NEWS_MONITOR=true` in environment
2. Verify `GEMINI_API_KEY` is set (required for Gemini analysis)
3. Check application logs for "initializeNewsMonitor" message on startup
4. Verify `/api/news-monitor` route is registered (check logs for route mounting)

#### News Alerts Not Sending

1. Verify `NEWS_ALERT_THRESHOLD` setting (default: 0.7). Confidence scores below threshold will be filtered
2. Check `NEWS_TIMEOUT_MS` is not too aggressive (default: 30000 ms is reasonable)
3. Verify notification channels (Telegram, WhatsApp) are properly configured
4. Check application logs for per-symbol analysis status and confidence scores
5. Test with explicit GET request: `GET /api/news-monitor?crypto=BTCUSDT`

#### Duplicate Alerts (Cache Not Working)

1. Verify `NEWS_CACHE_TTL_HOURS` is set (default: 6 hours). Set to 0 for no caching
2. Check application logs for "Cache hit" messages
3. Verify symbols and event categories match between requests (cache key is `(symbol, event_category)`)
4. Different event categories will NOT be deduplicated (e.g., "price_surge" + "regulatory" = 2 alerts)

#### Binance Price Not Being Fetched

1. Verify `ENABLE_BINANCE_PRICE_CHECK=true`
2. Verify symbol format is correct for Binance (e.g., `BTCUSDT` not `BTC`)
3. Check that crypto symbols are placed in `crypto` array (not `stocks`)
4. If Binance fails, system automatically falls back to Gemini GoogleSearch
5. Verify Binance API is accessible: `curl https://api.binance.com/api/v3/avgPrice?symbol=BTCUSDT`

**Symbol Classification**: The system trusts that you've correctly classified symbols into `crypto` and `stocks` arrays. If a symbol is misclassified (e.g., "NVDA" in the `crypto` array), Binance will return an error like `Invalid symbol: NVDA`. In this case:
- Verify the symbol exists on Binance: `https://api.binance.com/api/v3/avgPrice?symbol=NVDA` (will fail)
- Move stock symbols to the `stocks` array
- Use Binance symbol format (e.g., BTCUSDT for Bitcoin, not BTC)
- System will fall back to Gemini GoogleSearch if symbol is not found on Binance

#### Secondary LLM Enrichment Not Working

1. Verify `ENABLE_LLM_ALERT_ENRICHMENT=true`
2. Verify Azure AI Inference credentials: `AZURE_LLM_ENDPOINT`, `AZURE_LLM_KEY`, `AZURE_LLM_MODEL`
3. Check application logs for enrichment errors (will fall back to Gemini if unavailable)
4. Verify enrichment timeout is not exceeded (default: 10s per symbol)
5. If enrichment fails, alert is still sent using Gemini confidence (graceful degradation)

#### High Response Latency

1. Check `NEWS_TIMEOUT_MS` setting (each symbol waits up to this timeout)
2. Multiple symbols with timeouts = longer overall response. Per-symbol timeout: 30s. For 10 symbols, max wait: ~30s.
3. Enable only symbols that are actively traded (unused symbols slow down requests)
4. Reduce `NEWS_CACHE_TTL_HOURS` to refresh data more frequently (trades off cache hits vs. freshness)
5. Monitor external API latencies (Gemini, Binance) in application logs

### WhatsApp Alerts Not Sending

1. Verify `ENABLE_WHATSAPP_ALERTS=true`
2. Check `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID` are set
3. Test WhatsApp API connection: `curl -X POST https://api.green-api.com/...`
4. Check application logs for detailed error messages

### Telegram Alerts Not Sending

1. Verify `BOT_TOKEN` is correct (from BotFather)
2. Verify `TELEGRAM_CHAT_ID` is correct (use `/start` to find)
3. Ensure bot has permission to send messages to the chat
4. Check Telegram API status

### URL Shortening

**URLs not being shortened**:
1. Verify `BITLY_API_KEY` is set in environment
2. Check that alert text contains valid HTTP/HTTPS URLs
3. Verify Bitly API key has sufficient quota (check Bitly dashboard)
4. Check application logs for "URLShortener" error messages

**Shortening timeout errors**:
- Default timeout: 5 seconds per URL batch
- If Bitly API is slow, increase timeout or reduce parallel URLs
- URLs gracefully fallback to original if shortening fails
- Alert still sends with original URLs

**Cache issues**:
- URL shortening cache is session-scoped (clears after request)
- Same URL requested multiple times in quick succession uses cache
- To clear cache manually, restart the application

**WhatsApp message still too long**:
- Shortening reduces URL length, not entire message
- If full alert text > 20,000 chars, WhatsApp auto-truncates
- Reduce alert detail or enable Gemini enrichment to summarize

### Retry Logic

- Failed alerts automatically retry up to 3 times
- Each retry waits: 1s, then 2s, then 4s
- ±10% jitter prevents thundering herd
- All retries logged at WARN/ERROR level
