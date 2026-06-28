feat(tradingview): add confluence enrichment mode to webhook alert (CB-44)

## Summary

Extends `POST /api/webhook/alert?useTradingViewData=true` with an optional confluence-aware enrichment mode. When `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true`, the enrichment path calls `combined_analysis` in addition to the existing `coin_analysis`, merges the confluence result into the alert output, and surfaces a confluence insight line in the delivered notification.

## Key Changes

### ⚡ Confluence enrichment step in `TradingViewMcpService.enrichFromSignal()`

- After the existing `coin_analysis` + optional `volume_confirmation_analysis` calls, an additional optional `combined_analysis` call is made when `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true`
- Fail-open: MCP errors (timeout, network, invalid payload) are caught and logged; alert delivery is **never blocked**
- Confluence timeout is bounded: `min(8000, max(2000, budget / 2))` ms to stay within the overall enrichment budget
- Logging: `debug` on success, `warn` on failure (consistent with existing volume confirmation pattern)

### 📊 Confluence data in enriched alert result (`_toEnrichedAlert()`)

- Signature extended with optional `confluenceAnalysis` param (default `null` — fully backward-compatible)
- When confluence data is available, a `Confluencia: <bias> · rating <N>` insight line is appended to the `insights` array
- Raw `confluenceData` field added to the returned object for downstream formatters and storage

### 📋 Status visibility (`src/controllers/status.js`)

- `tradingViewConfluenceEnrichment` boolean added to `featureFlags` in `GET /api/status`

## Technical Implementation

### Architecture

The implementation follows the exact same fail-open timeout pattern as the existing `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION` step — no new patterns or abstractions introduced. The `_toEnrichedAlert` signature change is fully backward-compatible (new `confluenceAnalysis` param defaults to `null`).

### New environment variable

- `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT` — boolean flag, default `false`/unset (disabled). Set to `'true'` to enable confluence-aware enrichment on the webhook alert path.

## Testing

- All **517 unit tests** pass (`pnpm test -- tests/unit/ --testTimeout=5000`)
- The `_toEnrichedAlert` method change is backward-compatible: existing tests that call it without `confluenceAnalysis` continue to pass

## References

- **Linear**: [CB-44](https://linear.app/knil/issue/CB-44/use-confluence-analysis-in-tradingview-webhook-enrichment)
- Closes #131
