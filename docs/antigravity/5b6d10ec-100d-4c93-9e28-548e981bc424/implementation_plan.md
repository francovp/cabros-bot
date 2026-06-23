# Implementation Plan - Feature 3: Volume Breakout Alerts

Enhance the existing `POST /api/webhook/alert` webhook to optionally fetch and append volume confirmation analysis from the TradingView MCP server when TradingView MCP enrichment is active and feature-gated via `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`.

## User Review Required

> [!IMPORTANT]
> **API/Parameter Gating**: This feature is entirely server-side driven and active when the query param `?useTradingViewData=true` is passed to the webhook, and the feature flag `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true` is set.
> **Fail-Open Strategy**: Like existing integrations, if the volume confirmation MCP tool call fails or times out, the webhook will log a warning and proceed without the volume details. Alert delivery is NOT blocked.

## Proposed Changes

### TradingView MCP Service

#### [MODIFY] [TradingViewMcpService.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/services/tradingview/TradingViewMcpService.js)
- Add `callVolumeConfirmation({ symbol, exchange, timeframe, signal })` to call the remote MCP tool `volume_confirmation_analysis`.
- Format the symbol argument to `EXCHANGE:SYMBOL` as expected by the remote python tool regex parser.
- In `enrichFromSignal()`, if `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION === 'true'`, call `callVolumeConfirmation` in a fail-open `try-catch` block.
- Update `_toEnrichedAlert` signature and implementation to receive optional `volumeAnalysis` and append `"Volume confirms: YES/NO ({ratio}x avg)"` to the `insights` array.

---

## Verification Plan

### Automated Tests

- **Unit Tests**:
  - Add a unit test file `tests/unit/tradingview-volume-confirmation.test.js` to verify that `callVolumeConfirmation` correctly formats the arguments (prefixed symbol) and executes the MCP call.
  - Update `tests/unit/tradingview-mcp-service.test.js` to test `enrichFromSignal` logic with volume confirmation enabled and verify that formatting is appended to the `insights` array.
  - Verify that if `callVolumeConfirmation` fails, `enrichFromSignal` degrades gracefully and still returns the coin analysis enrichment.

### Manual Verification

- Deploy the application locally, trigger an alert webhook with the query param `?useTradingViewData=true`, set `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`, and verify that the output alert contains:
  `• Volume confirms: YES/NO (x.xx avg)`
