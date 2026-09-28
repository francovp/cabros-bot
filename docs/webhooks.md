# Webhook Alerts API

[← Back to README](../README.md) | [API Reference](api-reference.md)

The bot exposes several webhook endpoints to receive alerts from TradingView, scanners, and external automation.
All webhook endpoints are protected by `validateApiKey` (via `x-api-key` header) and support multi-channel notification dispatch.

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
  "processingTimeMs": 1200
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
- `dryRun`: Optional. When `true` (or `?dryRun=true`), validates the request and returns the parsed `symbol`/`exchange`/`timeframe` echo with `dryRun: true`, `decision: 'unknown'`, `volumeRatio: null`, and `analysis: null` — no MCP call is made. Useful for validating request shape before paying the ~360s MCP budget.

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
  },
  "requestId": "req-vol-123",
  "processingTimeMs": 310
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
  "includeMultiTimeframe": true,
  "includeMultiAgent": true
}
```

- `dryRun`: Optional. When `true` (or `?dryRun=true`), validates the request and returns the parsed `symbol`/`exchange`/`timeframe`/`analysisMode`/`includeMultiTimeframe` echo with `dryRun: true`, `side: null`, `analysis: null`, and `analysisStatus: 'dry-run'` — no MCP `coin_analysis` (or `multi_timeframe_analysis`) call is made. Useful for probe requests that want to avoid the ~120s MCP budget.

The response includes `alertText`, normalized price/volume/indicator/signal/assessment data, sentiment/news/confluence, multi-timeframe results, and multi-agent consensus results (`multiAgent`) when requested (or when `ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT=true`), plus directional `risk` and `decision` metadata. When multi-agent consensus disagrees with the directional signal (decision is `HOLD`, confidence is `Low`, or decision opposes side), an advisory warning (`Consenso multi-agente no confirma la señal`) is appended to `decision.warnings` without flipping the primary action. `decision.action` is `BUY` or `SELL` only when the data and risk levels are sufficient; otherwise it is `NO_TRADE`. This endpoint never delivers notifications or submits orders. Invalid symbols return `400 INVALID_REQUEST`, TradingView failures return `502 SYMBOL_ANALYSIS_FAILED`, and deadline expiry returns `504 SYMBOL_ANALYSIS_TIMEOUT`. Upstream multi-agent failures fail open and mark `analysisStatus: "partial"` while preserving the base analysis.

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
  "processingTimeMs": 1450
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
