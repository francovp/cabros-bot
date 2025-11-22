# Quickstart: News Monitoring with Sentiment Analysis and Alert Distribution

**Feature**: `003-news-monitor` | **Version**: 1.0.0  
**Last Updated**: October 31, 2025

---

## Overview

The News Monitor API analyzes news and market sentiment for crypto and stock symbols using Gemini GoogleSearch grounding. It detects significant market events (price movements, public figure mentions, regulatory announcements), assigns confidence scores, and sends filtered alerts to Telegram and WhatsApp channels.

**Key Features:**
- 📊 **Parallel symbol analysis** (crypto + stocks)
- 🎯 **Event detection** (price surges/declines, public figures, regulatory)
- 🔒 **Intelligent deduplication** (6hr cache TTL per symbol + event type)
- 💰 **Optional Binance integration** for precise crypto prices
- 🤖 **Optional LLM enrichment** for refined confidence scores
- 📱 **Multi-channel alerts** (Telegram + WhatsApp)

---

## Prerequisites

1. **Node.js 20.x** (matches existing codebase)
2. **Active bot** with Telegram and WhatsApp configured (from 002-whatsapp-alerts)
3. **Gemini API key** (already integrated via `@google/genai`)
4. **(Optional)** Binance API access for crypto prices
5. **(Optional)** Azure AI Inference endpoint for LLM enrichment

---

## Installation

### 1. Install Dependencies

```bash
# Core Azure AI Inference packages (for optional LLM enrichment)
npm install @azure-rest/ai-inference @azure/core-auth @azure/core-sse

# Existing dependencies (already installed)
# - @google/genai (Gemini)
# - binance (crypto prices)
# - express (HTTP server)
# - telegraf (Telegram bot)
```

### 2. Environment Configuration

Create or update `.env` file:

```bash
# Feature Flags
ENABLE_NEWS_MONITOR=true                    # Enable the news monitor endpoint
ENABLE_BINANCE_PRICE_CHECK=false            # Enable Binance for crypto prices (default: Gemini only)
ENABLE_LLM_ALERT_ENRICHMENT=false           # Enable secondary LLM enrichment (default: disabled)

# Alert Thresholds
NEWS_ALERT_THRESHOLD=0.7                    # Minimum confidence to send alerts (0.0-1.0)
NEWS_CACHE_TTL_HOURS=6                      # Cache expiration time (hours)
NEWS_TIMEOUT_MS=30000                       # Per-symbol analysis timeout (milliseconds)

# Default Symbols (if request omits crypto/stocks)
NEWS_SYMBOLS_CRYPTO=BTCUSDT,ETHUSD,BNBUSDT
NEWS_SYMBOLS_STOCKS=NVDA,MSFT,TSLA

# Azure AI Inference (required if ENABLE_LLM_ALERT_ENRICHMENT=true)
AZURE_AI_ENDPOINT=https://your-endpoint.inference.ai.azure.com
AZURE_AI_API_KEY=your-api-key-here
AZURE_AI_MODEL=gpt-4o                       # Model deployment name

# Existing Configuration (reused)
BOT_TOKEN=your-telegram-bot-token
TELEGRAM_CHAT_ID=your-telegram-chat-id
WHATSAPP_CHAT_ID=your-whatsapp-chat-id@g.us
WHATSAPP_API_URL=https://api.greenapi.com
WHATSAPP_API_KEY=your-greenapi-key

# URL Shortening (optional, for WhatsApp citations)
URL_SHORTENER_SERVICE=bitly                  # Service: 'bitly', 'tinyurl', 'picsee', 'reurl', 'cuttly', 'pixnet0rz.tw'
BITLY_ACCESS_TOKEN=your-bitly-token          # Required for Bitly
# TINYURL_API_KEY=your-tinyurl-key           # Required for TinyURL (if not provided, uses free API)
# PICSEE_ACCESS_TOKEN=your-picsee-token      # Required for PicSee
# REURL_ACCESS_TOKEN=your-reurl-token        # Required for reurl
# CUTTLY_ACCESS_TOKEN=your-cuttly-token      # Required for Cutt.ly
# PIXNET0RZ_TW_ACCESS_TOKEN=your-pixnet-token # Required for Pixnet0rz.tw
```

### 3. Start the Server

```bash
# Development mode (with auto-reload)
npm run start-dev

# Production mode
npm start
```

Server will start on `http://localhost:3000` (or `PORT` env variable).

---

## Basic Usage

### Example 1: Analyze Crypto and Stock Symbols

**Request** (POST):
```bash
curl -X POST http://localhost:3000/api/news-monitor \
  -H "Content-Type: application/json" \
  -d '{
    "crypto": ["BTCUSDT", "ETHUSD"],
    "stocks": ["NVDA", "MSFT"]
  }'
```

**Response** (HTTP 200):
```json
{
  "success": true,
  "results": [
    {
      "symbol": "BTCUSDT",
      "status": "analyzed",
      "alert": {
        "symbol": "BTCUSDT",
        "eventCategory": "price_surge",
        "headline": "Bitcoin surges 8% on ETF approval news",
        "sentimentScore": 0.85,
        "confidence": 0.82,
        "sources": ["https://example.com/news1"],
        "formattedMessage": "🚀 *BTCUSDT Alert*\n\nPrice: $42,350 (+8.2%)\nSentiment: Bullish (0.85)\nEvent: Price Surge\n\nSources: [Link](https://example.com/news1)",
        "timestamp": 1730390400000,
        "marketContext": {
          "price": 42350,
          "change24h": 8.2,
          "source": "binance",
          "timestamp": 1730390400000
        }
      },
      "deliveryResults": [
        { "success": true, "channel": "telegram", "messageId": "12345", "attemptCount": 1, "durationMs": 450 },
        { "success": true, "channel": "whatsapp", "messageId": "67890", "attemptCount": 1, "durationMs": 620 }
      ],
      "totalDurationMs": 4230,
      "cached": false,
      "requestId": "req-abc123"
    },
    {
      "symbol": "ETHUSD",
      "status": "analyzed",
      "totalDurationMs": 3890,
      "cached": false,
      "requestId": "req-abc123"
    },
    {
      "symbol": "NVDA",
      "status": "analyzed",
      "totalDurationMs": 4120,
      "cached": false,
      "requestId": "req-abc123"
    },
    {
      "symbol": "MSFT",
      "status": "analyzed",
      "totalDurationMs": 3950,
      "cached": false,
      "requestId": "req-abc123"
    }
  ],
  "summary": {
    "total": 4,
    "analyzed": 4,
    "cached": 0,
    "timeout": 0,
    "error": 0,
    "alerts_sent": 1
  },
  "totalDurationMs": 5200,
  "requestId": "req-abc123"
}
```

**What Happened:**
1. System analyzed all 4 symbols in parallel
2. BTCUSDT detected a `price_surge` event with confidence 0.82 (>0.7 threshold)
3. Alert was sent to both Telegram and WhatsApp
4. Other symbols had no significant events (confidence below threshold)
5. Total execution time: 5.2 seconds (includes parallel processing)

---

### Example 2: Use Default Symbols

**Request** (POST with empty body):
```bash
curl -X POST http://localhost:3000/api/news-monitor \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Behavior:**
- Uses `NEWS_SYMBOLS_CRYPTO` and `NEWS_SYMBOLS_STOCKS` from environment variables
- Useful for scheduled cron jobs or periodic monitoring

---

### Example 3: GET Request with Query Parameters

**Request** (GET):
```bash
curl "http://localhost:3000/api/news-monitor?crypto=BTCUSDT,ETHUSD&stocks=NVDA"
```

**Behavior:**
- Same as POST method but accepts comma-separated symbols via query params
- Useful for simple testing or webhooks

---

### Example 4: Cached Result (Duplicate Request)

**Request** (second call within 6 hours):
```bash
curl -X POST http://localhost:3000/api/news-monitor \
  -H "Content-Type: application/json" \
  -d '{
    "crypto": ["BTCUSDT"]
  }'
```

**Response** (HTTP 200):
```json
{
  "success": true,
  "results": [
    {
      "symbol": "BTCUSDT",
      "status": "cached",
      "alert": {
        "symbol": "BTCUSDT",
        "eventCategory": "price_surge",
        "headline": "Bitcoin surges 8% on ETF approval news",
        "sentimentScore": 0.85,
        "confidence": 0.82,
        "sources": ["https://example.com/news1"],
        "formattedMessage": "🚀 *BTCUSDT Alert*\n\nPrice: $42,350 (+8.2%)\nSentiment: Bullish (0.85)\nEvent: Price Surge\n\nSources: [Link](https://example.com/news1)",
        "timestamp": 1730390400000
      },
      "totalDurationMs": 12,
      "cached": true,
      "requestId": "req-def456"
    }
  ],
  "summary": {
    "total": 1,
    "analyzed": 0,
    "cached": 1,
    "timeout": 0,
    "error": 0,
    "alerts_sent": 0
  },
  "totalDurationMs": 12,
  "requestId": "req-def456"
}
```

**What Happened:**
1. Same symbol + event category detected within cache TTL (6 hours)
2. Result returned from cache (status: `cached`)
3. No duplicate alert sent to notification channels
4. Fast response time: 12ms (cache hit)

---

## Advanced Configuration

### Enable Binance Price Fetching (Crypto Only)

```bash
ENABLE_BINANCE_PRICE_CHECK=true
```

**Behavior:**
- System calls Binance API for crypto symbols (e.g., BTCUSDT, ETHUSD)
- Provides real-time order book prices (~5s timeout)
- Automatically falls back to Gemini on failure
- Stock symbols always use Gemini (Binance doesn't support stocks)

**Example:** BTCUSDT price from Binance is $42,350 with 8.2% 24h change.

---

### Enable Optional LLM Enrichment

```bash
ENABLE_LLM_ALERT_ENRICHMENT=true
AZURE_AI_ENDPOINT=https://your-endpoint.inference.ai.azure.com
AZURE_AI_API_KEY=your-api-key-here
AZURE_AI_MODEL=gpt-4o
```

**Behavior:**
- After Gemini analysis, secondary LLM refines confidence score
- Conservative selection: `finalConfidence = min(geminiConfidence, llmConfidence)`
- Prevents false positives from LLM hallucination
- Falls back to Gemini-only analysis if enrichment fails

**Response includes enrichment metadata:**
```json
{
  "alert": {
    "confidence": 0.78,
    "enrichmentMetadata": {
      "original_confidence": 0.82,
      "enriched_confidence": 0.78,
      "enrichment_applied": true,
      "reasoning_excerpt": "Event significance is high due to multiple credible sources",
      "model_name": "gpt-4o",
      "processing_time_ms": 1250
    }
  }
}
```

---

### Enable URL Shortening for WhatsApp Citations

```bash
URL_SHORTENER_SERVICE=bitly
BITLY_ACCESS_TOKEN=your-bitly-access-token
```

**Behavior:**
- System shortens source URLs in WhatsApp alerts using configured service
- Reduces message size from ~25K chars to <10K chars for enriched alerts
- In-memory cache prevents redundant API calls for duplicate sources
- Falls back to title-only citations if shortening fails (e.g., "Reuters / CoinDesk" instead of long URLs)
- Supported services: `bitly`, `tinyurl`, `picsee`, `reurl`, `cuttly`, `pixnet0rz.tw`

**Response includes shortening metadata:**
```json
{
  "alert": {
    "urlShortening": {
      "applied": true,
      "service": "bitly",
      "successCount": 2,
      "failureCount": 0
    }
  }
}
```

---

### Adjust Alert Threshold

```bash
NEWS_ALERT_THRESHOLD=0.8  # More conservative (fewer alerts)
# or
NEWS_ALERT_THRESHOLD=0.6  # More aggressive (more alerts)
```

**Formula:**
```
confidence = (0.6 × event_significance + 0.4 × |sentiment_score|)

if confidence >= NEWS_ALERT_THRESHOLD:
    send alert
```

**Example Scenarios:**
| Event | Significance | Sentiment | Confidence | Threshold 0.7 | Threshold 0.8 |
|-------|--------------|-----------|------------|---------------|---------------|
| BTC +8% bullish | 0.9 | +0.8 | 0.86 | ✅ Send | ✅ Send |
| Trump mentions BTC | 0.85 | +0.6 | 0.75 | ✅ Send | ❌ Skip |
| NVDA -3% neutral | 0.4 | 0.0 | 0.24 | ❌ Skip | ❌ Skip |

---

## Testing

### Run All Tests

```bash
# Unit + integration tests
npm test

# Watch mode (auto-rerun on changes)
npm run test:watch

# Coverage report
npm run test:coverage
```

### Manual Testing with curl

**Test 1: Basic Analysis**
```bash
curl -X POST http://localhost:3000/api/news-monitor \
  -H "Content-Type: application/json" \
  -d '{"crypto": ["BTCUSDT"]}'
```

**Test 2: Cached Result** (run twice within 6 hours)
```bash
curl -X POST http://localhost:3000/api/news-monitor \
  -H "Content-Type: application/json" \
  -d '{"crypto": ["BTCUSDT"]}'
```

**Test 3: Feature Disabled**
```bash
# Set ENABLE_NEWS_MONITOR=false
curl -X POST http://localhost:3000/api/news-monitor \
  -H "Content-Type: application/json" \
  -d '{"crypto": ["BTCUSDT"]}'

# Expected: HTTP 403 with error message
```

---

## Troubleshooting

### Issue: Endpoint returns 403 (Feature Disabled)

**Cause:** `ENABLE_NEWS_MONITOR` is not set to `true`

**Solution:**
```bash
# In .env file
ENABLE_NEWS_MONITOR=true

# Restart server
npm start
```

---

### Issue: No alerts sent even with significant events

**Cause:** Confidence score is below `NEWS_ALERT_THRESHOLD`

**Solution:**
1. Check response to see actual confidence score:
   ```json
   {
     "symbol": "BTCUSDT",
     "status": "analyzed",
     "alert": null,  // No alert because confidence < threshold
     "confidence": 0.65
   }
   ```
2. Lower threshold or investigate event significance:
   ```bash
   NEWS_ALERT_THRESHOLD=0.6  # Lower threshold
   ```

---

### Issue: Binance API timeout or errors

**Cause:** Binance API unavailable or rate-limited

**Solution:**
1. Check Binance status: https://www.binance.com/en/system-status
2. System automatically falls back to Gemini (check response):
   ```json
   {
     "marketContext": {
       "source": "gemini",  // Fallback used
       "price": 42350
     }
   }
   ```
3. If Binance is consistently failing, disable it:
   ```bash
   ENABLE_BINANCE_PRICE_CHECK=false
   ```

---

### Issue: Notification delivery fails

**Cause:** Telegram or WhatsApp API issues

**Solution:**
1. Check delivery results in response:
   ```json
   {
     "deliveryResults": [
       { "success": true, "channel": "telegram", "messageId": "12345" },
       { "success": false, "channel": "whatsapp", "error": "Rate limit exceeded", "attemptCount": 3 }
     ]
   }
   ```
2. System retries 3 times with exponential backoff
3. One channel failure doesn't block the other or HTTP response
4. Verify credentials and chat IDs in `.env`

---

### Issue: LLM enrichment not working

**Cause:** Azure AI Inference endpoint misconfigured or `ENABLE_LLM_ALERT_ENRICHMENT=false`

**Solution:**
1. Verify environment variables:
   ```bash
   ENABLE_LLM_ALERT_ENRICHMENT=true
   AZURE_AI_ENDPOINT=https://your-endpoint.inference.ai.azure.com
   AZURE_AI_API_KEY=your-api-key-here
   AZURE_AI_MODEL=gpt-4o
   ```
2. Check response for enrichment metadata:
   ```json
   {
     "alert": {
       "enrichmentMetadata": {
         "enrichment_applied": false,  // Enrichment failed or disabled
         "error": "Azure AI endpoint unreachable"
       }
     }
   }
   ```
3. System falls back to Gemini-only analysis (no blocking)

---

## Scheduled Monitoring (Cron Jobs)

### GitHub Actions Example

```yaml
name: News Monitor Cron
on:
  schedule:
    - cron: '*/30 * * * *'  # Every 30 minutes

jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger news monitoring
        run: |
          curl -X POST https://cabros-bot.onrender.com/api/news-monitor \
            -H "Content-Type: application/json" \
            -d '{
              "crypto": ["BTCUSDT", "ETHUSD", "BNBUSDT"],
              "stocks": ["NVDA", "MSFT", "TSLA"]
            }'
```

### Render Cron Job (Alternative)

In `render.yaml`:
```yaml
services:
  - type: cron
    name: news-monitor-cron
    env: docker
    schedule: "*/30 * * * *"  # Every 30 minutes
    dockerCommand: |
      curl -X POST http://localhost:3000/api/news-monitor \
        -H "Content-Type: application/json" \
        -d '{}'
```

---

## API Reference

See [contracts/news-monitor.openapi.yml](./contracts/news-monitor.openapi.yml) for full OpenAPI specification.

**Key Endpoints:**
- `POST /api/news-monitor` - Analyze symbols (JSON body)
- `GET /api/news-monitor` - Analyze symbols (query params)

**Response Status Codes:**
- `200` - Success (includes partial success with timeouts/errors)
- `400` - Invalid request (e.g., too many symbols)
- `403` - Feature disabled
- `500` - Internal server error

---

## Next Steps

1. **Test locally** with development server
2. **Deploy to production** with `ENABLE_NEWS_MONITOR=true`
3. **Set up scheduled monitoring** via GitHub Actions or Render cron
4. **Monitor logs** for operational visibility (all external API calls logged)
5. **Tune alert threshold** based on trader feedback

**Support:** See [spec.md](./spec.md) for full feature specification and [data-model.md](./data-model.md) for entity details.
