# Cabros Bot

Express + Telegraf-based Telegram bot service with multi-channel alert delivery (Telegram and WhatsApp) and intelligent news monitoring.

## Features

- 📱 **Multi-Channel Alerts**: Send trading alerts to both Telegram and WhatsApp
- 🚀 **Webhook API**: HTTP endpoint for receiving alerts from external services (e.g., TradingView)
- 📰 **News Monitoring**: Analyze financial news and market sentiment for crypto and stock symbols with AI-powered event detection
- 🧠 **AI Enrichment**: Optional enhancement of alerts using Google Gemini API (grounding) and optional secondary LLM (Azure AI)
- 💎 **Event Detection**: Identify significant trading events (price surges, public figure mentions, regulatory announcements)
- 💰 **Market Context**: Optional Binance integration for real-time crypto prices with Gemini fallback
- 🎯 **Smart Deduplication**: In-memory cache prevents duplicate alerts for the same event category within 6-hour TTL
- ⚡ **Retry Logic**: Automatic retry with exponential backoff for failed deliveries
- 🔄 **Graceful Degradation**: Continue operating if one channel is unavailable
- ⏱️ **Parallel Processing**: Analyze multiple symbols concurrently with intelligent timeout management

## Environment Configuration

### Required Variables

- `BOT_TOKEN` - Telegram bot token (from BotFather)
- `TELEGRAM_CHAT_ID` - Telegram chat ID where alerts are sent
- `ENABLE_TELEGRAM_BOT` - Enable Telegram bot (`true` or `false`)

### Optional Variables

#### WhatsApp Alerts (GreenAPI)

- `ENABLE_WHATSAPP_ALERTS` - Enable WhatsApp alerts (`true` or `false`, default: `false`)
- `WHATSAPP_API_URL` - GreenAPI endpoint URL (e.g., `https://7107.api.green-api.com/waInstance7107356806/`)
- `WHATSAPP_API_KEY` - GreenAPI API key for authentication
- `WHATSAPP_CHAT_ID` - Destination WhatsApp chat/group ID (format: `120363xxxxx@g.us`)

#### URL Shortening (004-url-shortening)

- `BITLY_API_KEY` - Bitly API key for URL shortening (optional; when provided, long URLs in WhatsApp alerts are automatically shortened)

#### AI Grounding

- `ENABLE_GEMINI_GROUNDING` - Enable Gemini-based alert enrichment (`true` or `false`)
- `GEMINI_API_KEY` - Google API key for Gemini access

#### Admin Notifications

- `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` - Chat ID for admin notifications and deployment alerts

#### Server Configuration

- `PORT` - HTTP server port (default: `80`)
- `RENDER` - Render.com deployment flag (used internally)
- `IS_PULL_REQUEST` - Render preview environment flag (disables bot in PRs)
- `LOG_LEVEL` - Log verbosity (`debug`, `info`, `warn`, `error`, `silent`; defaults to `debug` in development and `info` in production)

#### News Monitoring (003-news-monitor)

- `ENABLE_NEWS_MONITOR` - Enable news monitoring endpoint (`true` or `false`, default: `false`)
- `NEWS_SYMBOLS_CRYPTO` - Default crypto symbols if not provided in request (comma-separated, e.g., `BTCUSDT,ETHUSD`)
- `NEWS_SYMBOLS_STOCKS` - Default stock symbols if not provided in request (comma-separated)
- `NEWS_ALERT_THRESHOLD` - Confidence score threshold for sending alerts (default: `0.7`, range 0.0-1.0)
- `NEWS_CACHE_TTL_HOURS` - Cache time-to-live for deduplication (default: `6` hours)
- `NEWS_TIMEOUT_MS` - Per-symbol analysis timeout (default: `30000` ms)
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

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create `.env` File

Copy the `.env.example` file to `.env` and fill in your configuration values:

```bash
cp .env.example .env
```

Then edit `.env` with your specific values. See `.env.example` for complete documentation of all available environment variables organized by category:

- **Required**: Core bot token and chat IDs
- **Optional: WhatsApp**: GreenAPI integration for multi-channel alerts
- **Optional: AI Grounding**: Gemini API for alert enrichment
- **Optional: Admin Notifications**: Separate chat for deployment alerts
- **Optional: Server Configuration**: Port, Render.com flags
- **Optional: News Monitoring**: Feature flags and thresholds
- **Optional: Binance Integration**: Real-time crypto prices
- **Optional: Secondary LLM**: Azure AI or GitHub Models enrichment

See [Environment Configuration](#environment-configuration) section below for detailed descriptions of each variable.

### 3. Run Development Server

```bash
npm run start-dev
```

### 4. Run Production Server

```bash
npm start
```

## API Endpoints

### POST /healthcheck

Health check endpoint.

**Response:**
```json
{"uptime":"..."}
```

## Alert Enrichment with Gemini Grounding (001)

The webhook alert system can optionally enrich alerts with verified sources and market context using Google Gemini API with GoogleSearch grounding.

### How It Works

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

### Example Enrichment Flow

**Request:**
```bash
POST /api/webhook/alert
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
      "alerts": [
        {
          "eventCategory": "price_surge",
          "headline": "Bitcoin breaks $45,000 on positive market sentiment",
          "confidence": 0.85,
          "sentiment": 0.8,
          "sources": ["Reuters", "CoinDesk"],
          "message": "BTCUSDT: Price surge detected (+8.5%) with positive market sentiment (confidence: 0.85). Sources: Reuters, CoinDesk"
        }
      ],
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
      "enrichment": {
        "applied": true,
        "originalConfidence": 0.80,
        "enrichedConfidence": 0.85,
        "reasoning": "Secondary LLM confirms price surge with bullish indicators"
      }
    },
    {
      "symbol": "NVDA",
      "status": "cached",
      "alerts": [],
      "cached": true,
      "cacheHitTime": "2025-10-31T15:30:00Z"
    }
  ],
  "totalDurationMs": 5234,
  "partialSuccess": false
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
- `error` - API failure (Binance, Gemini, or other service error)

### POST /api/webhook/alert

Send alert via webhook. Accepts either JSON or plain text.

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

## Multi-Channel Alerts (002)

The alert webhook system supports simultaneous delivery to multiple channels (Telegram and WhatsApp) with independent retry logic and graceful degradation.

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
# Telegram (required)
ENABLE_TELEGRAM_BOT=true
BOT_TOKEN=your_telegram_token
TELEGRAM_CHAT_ID=-1001234567890

# WhatsApp (optional)
ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=https://7107.api.green-api.com/waInstance7107356806/
WHATSAPP_API_KEY=your_greenapi_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# Optional enrichment (applies to all channels)
ENABLE_GEMINI_GROUNDING=true
GEMINI_API_KEY=your_google_ai_studio_api_key
```

### Troubleshooting Multi-Channel Delivery

**Both channels failing**:
1. Verify network connectivity from server
2. Check BOT_TOKEN validity (Telegram)
3. Check GreenAPI credentials and account status (WhatsApp)
4. Review application logs for detailed error messages

**WhatsApp not sending**:
1. Verify `ENABLE_WHATSAPP_ALERTS=true`
2. Check `WHATSAPP_CHAT_ID` format (should be `120363xxxxx@g.us`)
3. Verify GreenAPI account is active
4. Test API directly: `curl -X POST https://api.green-api.com/test`

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
npm test

# Run with watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
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
npm run start-dev

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

