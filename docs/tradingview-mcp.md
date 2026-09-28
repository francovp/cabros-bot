# TradingView MCP Integration

[← Back to README](../README.md)

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
