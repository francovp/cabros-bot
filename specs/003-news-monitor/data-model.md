# Data Model: News Monitoring with Sentiment Analysis and Alert Distribution

**Feature**: `003-news-monitor` | **Date**: October 31, 2025  
**Purpose**: Define entities, relationships, validation rules, and state transitions

---

## Core Entities

### 1. NewsAlert

Represents a detected market event with confidence scoring and notification metadata.

**Fields**:
```typescript
interface NewsAlert {
  symbol: string;                    // Financial symbol (e.g., "BTCUSDT", "NVDA")
  eventCategory: EventCategory;      // Type of event detected
  headline: string;                  // Human-readable event description
  sentimentScore: number;            // -1.0 (bearish) to +1.0 (bullish)
  confidence: number;                // 0.0-1.0, calculated via formula
  sources: string[];                 // URLs or titles of news sources
  formattedMessage: string;          // Notification-ready text (MarkdownV2 for Telegram)
  timestamp: number;                 // Unix timestamp (ms) when alert was created
  marketContext?: MarketContext;     // Optional price data (if available)
  enrichmentMetadata?: EnrichmentMetadata;  // Optional LLM enrichment (when enabled)
}

enum EventCategory {
  PRICE_SURGE = 'price_surge',       // Significant price increase with bullish sentiment
  PRICE_DECLINE = 'price_decline',   // Significant price decrease with bearish sentiment
  PUBLIC_FIGURE = 'public_figure',   // Mention of Trump, Elon Musk, etc.
  REGULATORY = 'regulatory',         // Official announcements, policy changes
  NONE = 'none'                      // No significant event detected
}
```

**Validation Rules**:
- `symbol`: Non-empty string, max 20 characters, alphanumeric + underscore
- `eventCategory`: Must be one of `EventCategory` enum values
- `headline`: Non-empty string, max 250 characters
- `sentimentScore`: Number in range [-1.0, 1.0]
- `confidence`: Number in range [0.0, 1.0]
- `sources`: Array of strings, max 10 sources, each max 500 characters
- `formattedMessage`: Non-empty string, max 4000 characters (Telegram limit)
- `timestamp`: Positive integer (Unix timestamp in milliseconds)

**Confidence Calculation**:
```javascript
// Primary confidence from Gemini analysis
confidence = (0.6 × event_significance + 0.4 × |sentiment_score|)

// If enrichment enabled, apply conservative selection
if (enrichmentMetadata) {
  confidence = Math.min(confidence, enrichmentMetadata.enriched_confidence)
}

// Clamp to valid range
confidence = Math.max(0.0, Math.min(1.0, confidence))
```

**Relationships**:
- Has-One `MarketContext` (optional, depends on Binance/Gemini availability)
- Has-One `EnrichmentMetadata` (optional, only when `ENABLE_LLM_ALERT_ENRICHMENT=true`)
- Belongs-To `AnalysisResult` (container for per-symbol analysis output)

---

### 2. MarketContext

Encapsulates price data sourced from Binance or Gemini.

**Fields**:
```typescript
interface MarketContext {
  price: number;                     // Current asset price (USD)
  change24h: number;                 // 24-hour percentage change (-100 to +infinity)
  volume24h?: number;                // Optional 24-hour trading volume (USD)
  source: 'binance' | 'gemini';      // Data provider
  timestamp: number;                 // Unix timestamp (ms) when data was fetched
}
```

**Validation Rules**:
- `price`: Positive number (> 0)
- `change24h`: Number (can be negative)
- `volume24h`: Optional positive number
- `source`: Must be 'binance' or 'gemini'
- `timestamp`: Positive integer (Unix timestamp in milliseconds)

**Relationships**:
- Belongs-To `NewsAlert` (optional)

---

### 3. CacheEntry

In-memory record for deduplication with TTL tracking.

**Fields**:
```typescript
interface CacheEntry {
  key: string;                       // Cache key: "${symbol}:${eventCategory}"
  timestamp: number;                 // Unix timestamp (ms) when entry was created
  data: CachedAnalysisData;          // Cached analysis result
}

interface CachedAnalysisData {
  alert: NewsAlert;                  // Detected alert (or null if no event)
  analysisResult: AnalysisResult;    // Complete analysis output
  deliveryResults?: NotificationDeliveryResult[];  // Notification outcomes
}
```

**Validation Rules**:
- `key`: Non-empty string matching pattern `^[A-Z0-9_]+:(price_surge|price_decline|public_figure|regulatory|none)$`
- `timestamp`: Positive integer
- `data.alert`: Valid `NewsAlert` or null
- `data.analysisResult`: Valid `AnalysisResult`

**TTL Logic**:
```javascript
const TTL_MS = process.env.NEWS_CACHE_TTL_HOURS * 60 * 60 * 1000; // Default: 6 hours

function isExpired(entry) {
  return (Date.now() - entry.timestamp) > TTL_MS;
}
```

**Relationships**:
- Contains `NewsAlert` and `AnalysisResult`
- Managed by `NewsCache` singleton

---

### 4. AnalysisResult

Container for per-symbol analysis output with status tracking.

**Fields**:
```typescript
interface AnalysisResult {
  symbol: string;                    // Financial symbol analyzed
  status: AnalysisStatus;            // Outcome of analysis
  alert?: NewsAlert;                 // Detected alert (only if confidence >= threshold)
  deliveryResults?: NotificationDeliveryResult[];  // Notification outcomes (if alert sent)
  error?: ErrorDetail;               // Error info (only if status = 'error')
  totalDurationMs: number;           // Analysis execution time
  cached: boolean;                   // True if result was returned from cache
  requestId: string;                 // Unique correlation ID for tracing
}

enum AnalysisStatus {
  ANALYZED = 'analyzed',             // Successfully analyzed (may or may not generate alert)
  CACHED = 'cached',                 // Returned from cache (duplicate within TTL)
  TIMEOUT = 'timeout',               // Analysis exceeded 30s budget
  ERROR = 'error'                    // API failure or validation error
}

interface ErrorDetail {
  code: string;                      // Error code (e.g., 'BINANCE_TIMEOUT', 'GEMINI_RATE_LIMIT')
  message: string;                   // Human-readable error description
  originalError?: string;            // Stack trace or original error message (for debugging)
}
```

**Validation Rules**:
- `symbol`: Non-empty string, max 20 characters
- `status`: Must be one of `AnalysisStatus` enum values
- `alert`: Required if status = 'analyzed' and confidence >= threshold, otherwise null
- `deliveryResults`: Required if alert was sent, otherwise undefined
- `error`: Required if status = 'error', otherwise undefined
- `totalDurationMs`: Non-negative integer
- `cached`: Boolean
- `requestId`: Non-empty string (UUID format recommended)

**Relationships**:
- Has-One `NewsAlert` (optional, depends on confidence threshold)
- Has-Many `NotificationDeliveryResult` (via existing NotificationManager)
- Has-One `ErrorDetail` (optional, only on errors)

---

### 5. EnrichmentMetadata

Optional metadata when secondary LLM enrichment is applied.

**Fields**:
```typescript
interface EnrichmentMetadata {
  original_confidence: number;       // Gemini-only confidence score (0.0-1.0)
  enriched_confidence: number;       // Secondary LLM refined score (0.0-1.0)
  enrichment_applied: boolean;       // True if enrichment succeeded
  reasoning_excerpt: string;         // Brief explanation from LLM (max 500 chars)
  model_name: string;                // Azure AI model identifier (e.g., "gpt-4o")
  processing_time_ms: number;        // Enrichment execution time
}
```

**Validation Rules**:
- `original_confidence`: Number in range [0.0, 1.0]
- `enriched_confidence`: Number in range [0.0, 1.0]
- `enrichment_applied`: Boolean
- `reasoning_excerpt`: String, max 500 characters
- `model_name`: Non-empty string, max 100 characters
- `processing_time_ms`: Non-negative integer

**Conservative Selection Rule**:
```javascript
finalConfidence = Math.min(original_confidence, enriched_confidence);
```

**Relationships**:
- Belongs-To `NewsAlert` (optional)

---

### 6. NotificationDeliveryResult

Represents outcome of sending alert to a notification channel (from existing 002-whatsapp-alerts).

**Fields** (reused from existing implementation):
```typescript
interface NotificationDeliveryResult {
  success: boolean;                  // True if message delivered successfully
  channel: 'telegram' | 'whatsapp';  // Notification channel
  messageId?: string;                // Platform-specific message ID (if success)
  error?: string;                    // Error message (if !success)
  attemptCount: number;              // Number of retry attempts (1-3)
  durationMs: number;                // Delivery execution time
}
```

**Validation Rules**:
- `success`: Boolean
- `channel`: Must be 'telegram' or 'whatsapp'
- `messageId`: Required if success = true, otherwise undefined
- `error`: Required if success = false, otherwise undefined
- `attemptCount`: Integer in range [1, 3]
- `durationMs`: Non-negative integer

**Relationships**:
- Belongs-To `AnalysisResult` (multiple per analysis if alert sent)

---

## Request/Response Schemas

### HTTP Request Schema

**Endpoint**: `POST /api/news-monitor` (also supports GET with query params)

```typescript
interface NewsMonitorRequest {
  crypto?: string[];                 // Optional array of crypto symbols (default: NEWS_SYMBOLS_CRYPTO env)
  stocks?: string[];                 // Optional array of stock symbols (default: NEWS_SYMBOLS_STOCKS env)
}
```

**Example**:
```json
{
  "crypto": ["BTCUSDT", "ETHUSD", "BNBUSDT"],
  "stocks": ["NVDA", "MSFT", "TSLA"]
}
```

**Validation Rules**:
- At least one of `crypto` or `stocks` must be provided (or defaults used)
- Each symbol: Non-empty string, max 20 characters, alphanumeric + underscore
- Max 100 symbols total per request (combined crypto + stocks)

---

### HTTP Response Schema

**Success Response** (HTTP 200):
```typescript
interface NewsMonitorResponse {
  success: boolean;                  // True if at least one symbol analyzed
  partial_success?: boolean;         // True if some symbols timeout/error
  results: AnalysisResult[];         // Per-symbol analysis outcomes
  summary: {
    total: number;                   // Total symbols requested
    analyzed: number;                // Symbols with status 'analyzed'
    cached: number;                  // Symbols with status 'cached'
    timeout: number;                 // Symbols with status 'timeout'
    error: number;                   // Symbols with status 'error'
    alerts_sent: number;             // Number of alerts that met confidence threshold
  };
  totalDurationMs: number;           // Total endpoint execution time
  requestId: string;                 // Unique correlation ID
}
```

**Example**:
```json
{
  "success": true,
  "partial_success": true,
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
      "symbol": "NVDA",
      "status": "timeout",
      "error": {
        "code": "ANALYSIS_TIMEOUT",
        "message": "Analysis exceeded 30s budget"
      },
      "totalDurationMs": 30000,
      "cached": false,
      "requestId": "req-abc123"
    }
  ],
  "summary": {
    "total": 2,
    "analyzed": 1,
    "cached": 0,
    "timeout": 1,
    "error": 0,
    "alerts_sent": 1
  },
  "totalDurationMs": 30150,
  "requestId": "req-abc123"
}
```

---

## State Transitions

### Analysis Result Status Flow

```
                    ┌──────────────┐
                    │   Request    │
                    │   Received   │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ Check Cache  │
                    └──────┬───────┘
                           │
                 ┌─────────┴─────────┐
                 │                   │
        Cache Hit│                   │Cache Miss
                 ▼                   ▼
          ┌───────────┐      ┌───────────────┐
          │  CACHED   │      │ Fetch Market  │
          │  (return) │      │   Context     │
          └───────────┘      │ (Binance/     │
                             │  Gemini)      │
                             └───────┬───────┘
                                     │
                           ┌─────────┴─────────┐
                           │                   │
                  Success  │                   │Timeout/Error
                           ▼                   ▼
                    ┌──────────────┐    ┌──────────────┐
                    │   Analyze    │    │    ERROR     │
                    │   with       │    │   (return)   │
                    │   Gemini     │    └──────────────┘
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Calculate   │
                    │  Confidence  │
                    └──────┬───────┘
                           │
                 ┌─────────┴─────────┐
                 │                   │
        Below Threshold              Above Threshold
                 │                   │
                 ▼                   ▼
          ┌───────────┐      ┌───────────────┐
          │ ANALYZED  │      │   Optional    │
          │(no alert) │      │   LLM         │
          └───────────┘      │   Enrichment  │
                             └───────┬───────┘
                                     │
                                     ▼
                             ┌───────────────┐
                             │ Send Alerts   │
                             │ to Telegram + │
                             │   WhatsApp    │
                             └───────┬───────┘
                                     │
                                     ▼
                             ┌───────────────┐
                             │   ANALYZED    │
                             │ (with alert)  │
                             └───────────────┘
```

### Cache Entry Lifecycle

```
┌─────────────┐
│   Create    │  ← New analysis result (symbol + event_category)
│   Entry     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│    VALID    │  ← Entry exists, age < TTL_MS
│  (can use)  │
└──────┬──────┘
       │
       │ (Time passes)
       │
       ▼
┌─────────────┐
│   EXPIRED   │  ← age >= TTL_MS
│  (evicted)  │
└─────────────┘
```

**TTL Enforcement**:
- Checked on every `cache.get(symbol, eventCategory)`
- Periodic cleanup via `setInterval(() => cache.cleanup(), 3600000)` (every 1 hour)

---

## Validation Summary

### Input Validation

| Field | Rules | Error Response |
|-------|-------|----------------|
| `crypto`, `stocks` | Max 100 symbols total, each max 20 chars | HTTP 400, `{ error: "Too many symbols" }` |
| Symbol format | Alphanumeric + underscore only | Passed to external APIs (Binance/Gemini will reject invalid) |

### Output Validation

| Entity | Critical Validations |
|--------|---------------------|
| `NewsAlert` | confidence ∈ [0,1], sentimentScore ∈ [-1,1], eventCategory is valid enum |
| `MarketContext` | price > 0, source is 'binance' or 'gemini' |
| `AnalysisResult` | status is valid enum, alert present only if status='analyzed' + confidence>=threshold |
| `EnrichmentMetadata` | enriched_confidence ≤ original_confidence (conservative selection) |

---

## Environment Configuration

```bash
# Feature flags
ENABLE_NEWS_MONITOR=false                   # Default: disabled
ENABLE_BINANCE_PRICE_CHECK=false            # Default: disabled (use Gemini only)
ENABLE_LLM_ALERT_ENRICHMENT=false           # Default: disabled (Gemini-only analysis)

# Thresholds
NEWS_ALERT_THRESHOLD=0.7                    # Minimum confidence to send alerts (0.0-1.0)
NEWS_CACHE_TTL_HOURS=6                      # Cache expiration time
NEWS_TIMEOUT_MS=30000                       # Per-symbol analysis timeout (30s)

# Default symbols (if request body omits crypto/stocks)
NEWS_SYMBOLS_CRYPTO=BTCUSDT,ETHUSD,BNBUSDT
NEWS_SYMBOLS_STOCKS=NVDA,MSFT,TSLA

# Azure AI Inference (required if ENABLE_LLM_ALERT_ENRICHMENT=true)
AZURE_AI_ENDPOINT=https://your-endpoint.inference.ai.azure.com
AZURE_AI_API_KEY=your-api-key
AZURE_AI_MODEL=gpt-4o                       # Model deployment name

# Existing config (reused)
TELEGRAM_CHAT_ID=...
WHATSAPP_CHAT_ID=...
BOT_TOKEN=...
```

---

## Summary

This data model supports:
- ✅ **Structured event detection** via `EventCategory` enum
- ✅ **Confidence-based filtering** with reproducible formula
- ✅ **Optional LLM enrichment** with conservative score selection
- ✅ **Intelligent deduplication** via `(symbol, eventCategory)` cache keys
- ✅ **Multi-channel delivery** reusing existing `NotificationManager`
- ✅ **Partial success handling** with per-symbol status tracking
- ✅ **Operational visibility** via `requestId`, `totalDurationMs`, `cached` flags

**Ready for Phase 1: API Contracts**
