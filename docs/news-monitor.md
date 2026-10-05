# News Monitoring & Event Detection

[← Back to README](../README.md)

## News Monitoring & Event Detection

**📖 [Full Quickstart Guide](../specs/003-news-monitor/quickstart.md)** — Complete setup instructions, API reference, and advanced configuration.

**🔄 [Scheduled Monitoring Example](../.github/workflows/news-monitor-cron.yml.example)** — GitHub Actions workflow for periodic symbol analysis.

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

#### Source quality calibration

The base score above is then calibrated against the actual grounding sources before the threshold is applied:

1. **Additive penalties** for source count (0 / 1 source), freshness (stale, moderate, or unknown), source authority, model uncertainty, and invalidation hints.
2. **Multiplicative domain-quality penalty** based on the *weakest* quality tier present in the source set, so one low-quality source cannot be masked by reputable ones:

| Tier | Multiplier | Examples |
|---|---|---|
| `high` | `×1` (baseline) | Reuters, Bloomberg, CNBC, SEC, Binance |
| `medium` | `×0.95` | Forbes, MarketWatch, Investopedia, Decrypt |
| `low` | `×0.85` | Medium, Substack, Reddit, `.blog` / `.buzz` / `.xyz` TLDs |
| `unknown` | `×1` (no penalty) | Domain not in the classification lists — unclassified rather than judged weak |

3. The result is clamped into `[0, 1]`.

This is a false-positive **reduction** mechanism: every multiplier is `≤ 1`, so calibration can only lower a score, never inflate one. `NEWS_ALERT_THRESHOLD` is unchanged — the effective bar simply rises for weak-source signals. When no tier can be resolved (no grounding sources, or the tier classifier fails) no penalty is applied and the score is identical to the pre-calibration-tier behavior.

To audit *why* an alert passed the threshold, inspect `alert.sourceQualityTier` and `alert.calibration.qualityTier` / `alert.calibration.qualityPenalty` in the response. The delivered Telegram/WhatsApp message also includes a `Source Quality: <tier> (x<multiplier>)` line.

### Optional classifier.dev fallback

Set `ENABLE_NEWS_MONITOR_CLASSIFIER=true` to send Gemini `none` headlines through classifier.dev for a second-pass classification. Only recognized event categories meeting `NEWS_ALERT_THRESHOLD` are promoted; provider failures or unsupported labels leave the original `none` result unchanged. This is disabled by default and sends the symbol and generated headline to an external provider, so treat it as an environment-only privacy setting. The effective flag is exposed as `featureFlags.newsMonitorClassifier` in `/api/status`.

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


---

## Endpoint: POST /api/news-monitor

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
    "throttled": 0,
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
- `throttled` - Alert delivery suppressed by alert volume throttling (exceeded batch capacity or sliding window limit)
- `timeout` - Analysis exceeded per-symbol timeout (30s default)
- `error` - API failure (Binance, Gemini, or other service error). Gemini quota exhaustion is reported as `error.code = "GEMINI_QUOTA_EXHAUSTED"` and counted in `summary.quota_exhausted`.

When Sentry tracing is enabled, symbol analysis runs inside the `news_monitor.analyze_symbols` span, which records `news.symbol_count`, `news.quota_exhausted`, and `news.error_count` for quota correlation. Keep production `NEWS_GEMINI_CONCURRENCY=3` to bound provider bursts.
