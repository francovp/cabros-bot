## Summary

Enhances the existing webhook alert endpoint (`POST /api/webhook/alert`) to optionally retrieve and append volume confirmation analysis from the TradingView MCP server when TradingView MCP enrichment is active and feature-gated via `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`.

## Key Changes

### 📊 TradingView MCP Volume Confirmation Analysis

- Added `callVolumeConfirmation({ symbol, exchange, timeframe, signal })` to `TradingViewMcpService` to invoke the `volume_confirmation_analysis` tool.
- Formats the symbol argument as `EXCHANGE:SYMBOL` to conform to the remote tool's regex constraints.
- Updated `enrichFromSignal` to conditionally call `callVolumeConfirmation` in a fail-open `sendWithRetry` block when gated by the `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION` environment flag.

### 📝 Enriched Alert formatting

- Updated `_toEnrichedAlert` to receive the volume analysis result and format it as `"Volume confirms: YES/NO ({ratio}x avg)"`, appending it to the `insights` list.

### 🧪 Tests

- Created a new unit test suite in `tests/unit/tradingview-volume-confirmation.test.js` covering symbol prefixing, parameters parsing, threshold logic, and fail-open validation.

## Technical Implementation

### Architecture changes

#### `src/services/tradingview/TradingViewMcpService.js`
Exposes the new `callVolumeConfirmation` method, fetches it inside `enrichFromSignal`, and appends formatted volume confidence in `_toEnrichedAlert`.

### File Structure Additions

```text
docs/antigravity/5b6d10ec-100d-4c93-9e28-548e981bc424/
├── implementation_plan.md
├── task.md
└── walkthrough.md
tests/unit/
└── tradingview-volume-confirmation.test.js
```

## Testing infraestructure

### Test Suite

- **5 Unit Tests** (inside `tradingview-volume-confirmation.test.js`)

### Test Coverage

- Symbol prefixing (`BTCUSDT` -> `BINANCE:BTCUSDT`).
- Pre-prefixed symbol preservation.
- Conditional volume verification formatting (`Volume confirms: YES` for ratio >= 1.2, `Volume confirms: NO` for ratio < 1.2).
- Fail-open fallback when the volume confirmation tool fails or times out.

### Test Files

- `tests/unit/tradingview-volume-confirmation.test.js`

## Configuration Updates

### Environment Variables

```bash
ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true
```

## Documentation Updates

- **Walkthrough** Documents the design changes, test coverage, and unit test execution details.

## Examples

Example insight line appended to the alert message:
`• Volume confirms: YES (3.3x avg)`

## Testing

### Pre-merge Verification

- [x] Run unit tests `npm test -- tests/unit/tradingview-volume-confirmation.test.js`
- [x] Run full unit test suite `npm test -- tests/unit/` to ensure no regressions.

### Post-merge Verification

- [ ] Call the webhook with `?useTradingViewData=true` and `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true` to verify that volume confirmation is formatted and sent.

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
