# TradingView MCP Integration

[← Back to README](../README.md)

## TradingView Signal Enrichment with MCP

When `ENABLE_TRADINGVIEW_MCP_ENRICHMENT=true`, webhook alerts matching TradingView-style patterns (for example `BTCUSDT(240) pasó a señal de VENTA`) are enriched with real technical data from the TradingView MCP server **only if the webhook request includes `?useTradingViewData=true`**.

### How It Works

1. Webhook receives alert text and the request includes `useTradingViewData=true`.
2. System detects TradingView signal pattern (`SYMBOL(TF)` + side `VENTA/COMPRA` or `SELL/BUY`).
3. If TradingView pattern is detected, it queries `coin_analysis` via MCP and uses that output as an **additional real-time technical source**.
4. If `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true`, it calls `combined_analysis` with a dedicated per-call deadline of `min(8000, remaining budget)` and annotates or downgrades the signal when confluence contradicts the webhook side.
5. If `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true`, it calls `multi_timeframe_analysis` with its own fresh per-call deadline of `min(8000, remaining budget)` and returns the raw multi-timeframe metadata in dry-run/stored enrichment data.
6. Gemini/Brave grounding still runs when enabled, and the final `alert.enriched` merges grounding context + MCP technical data. When grounding returns no sources, Gemini sentiment magnitude is capped at `0.55`; the original signed value is retained as `sentiment_score_raw` only when that cap changes the score.
7. If either provider fails, the flow degrades gracefully to the other provider (or original text if none succeed).

Base `coin_analysis` gets the full configured budget when optional enrichment is disabled; when volume/confluence calls are enabled, it gets a bounded sub-budget of up to 75% of `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS`. Any unspent base budget rolls over into the remaining envelope. Each base attempt is capped by whatever remains of that base envelope (GH-630: no fixed reservation is held back for later backoffs, so a retry can never be starved down to a 1ms timeout, and a drained budget is reported as `timeout` via the structural `mcpBudgetExhausted` marker rather than inferred from message text).

Optional calls (`volume_confirmation`, `combined_analysis`, `multi_timeframe_analysis`) run sequentially from the remaining budget envelope under a decoupled deadline model:
- Each confluence call derives a fresh, independent deadline of `min(8000, remaining budget)` at invocation time.
- Per-call timers are isolated and cleared in `finally` blocks, preventing the second call from inheriting an in-flight timer from the first (PR #1384).
- Both calls compose their per-call signal with the overall budget cancellation controller via `AbortSignal.any`, so a fully spent budget aborts in-flight work immediately.
- If the remaining budget is non-positive (`<= 0`) before an optional stage starts, that stage is skipped cleanly without network I/O, recording `{ budgetExhausted: true }`.
- If any optional call times out or fails, the base result is retained fail-open with `tradingViewEnrichmentStatus: "partial"` (or `"full"` when all requested enrichment completes). Failed base enrichment remains fail-open and is tracked as `"failed"` in runtime/storage telemetry.

**Tuning `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS`:** Under default settings (12,000ms budget), base analysis reserves up to 9,000ms, leaving 3,000ms minimum for optional enrichment. If both confluence and multi-timeframe analysis are enabled, each can take up to 8,000ms. To avoid cutting the second call short or starving it when base analysis is slow, operators should increase `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS` toward `20000`-`24000ms` via Firebase Remote Config or environment variable, remaining within `REQUEST_TIMEOUT_MS` (default `30000ms`).

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

### Exchange Alias Resolution (GH-591)

The MCP server only resolves a fixed set of venues (crypto: `KUCOIN`, `BINANCE`, `BYBIT`, `MEXC`; stocks: `EGX`, `BIST`, `NASDAQ`, `NYSE`, `AMEX`, `NYSEARCA`, `PCX`, `BURSA`, `HKEX`, `SSE`, `SZSE`, `TWSE`, `TPEX`). Any other prefix is silently resolved to a crypto venue and the call answers `No data found for <SYMBOL> on KUCOIN` — a deterministic miss, not a transport failure.

`resolveMcpExchange()` in `src/services/tradingview/parseTradingViewSignal.js` maps alert exchange prefixes to a venue the server actually serves. It is a closed, probe-verified lookup table evaluated **before** any suffix-shape inference, and it applies to **outbound MCP calls only**:

| Alert prefix | Venue sent to MCP | Basis |
| --- | --- | --- |
| `BATS` | `NASDAQ` | `BATS:*` answers "no data on KUCOIN"; the same US large-cap symbols resolve on `NASDAQ` |
| `NASDAQ_DLY` | `NASDAQ` | Same venue under the screener's delayed-data suffix |

Two prefixes are deliberately **not** aliased. `FX_IDC` (FX spot) and `SPCFD` (index/CFD) have no equivalent venue on the MCP server — every candidate was probed live and all returned the same KUCOIN miss — so they keep the original prefix and degrade through the normal fail-open path rather than inventing a market.

Alias resolution **never rewrites stored metadata**. The parsed signal, `deriveAssetContext()` classification (including the `FX_IDC`/futures neutrality the parser asserts), and every persisted `exchange` value keep the venue the screener actually sent. Only the outbound call argument changes, and the enrichment payload records it as `alert.enriched.exchange` (original), `alert.enriched.requestedExchange` (original), and `alert.enriched.requestedExchangeMappedTo` (alias target, omitted when no alias was applied).

A `no data` / `symbol not found` response is treated as **terminal for that attempt**: `sendWithRetry()` receives a `shouldRetry` hook and the base analysis stops after a single attempt instead of burning the remaining `TRADINGVIEW_MCP_MAX_RETRIES` backoff. Genuine transport errors, timeouts, and HTTP 5xx responses still retry as before, and circuit-breaker semantics are unchanged.

No new environment variable was added — the table is a code-level contract, not runtime tuning.

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
