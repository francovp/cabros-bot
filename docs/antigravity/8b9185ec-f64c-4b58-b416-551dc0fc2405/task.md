# Feature 1: Market Scanner Alert Endpoint

## Implementation Tasks

- [x] Add `callScanTool(toolName, args)` method to `TradingViewMcpService`
- [x] Create `src/services/tradingview/marketScannerReport.js` (request parsing + report formatting)
- [x] Create `src/controllers/webhooks/handlers/marketScanner/marketScanner.js` (endpoint handler)
- [x] Register route in `src/routes/index.js`
- [x] Add unit tests for `marketScannerReport.js`
- [x] Add unit tests for `marketScanner.js` handler
- [x] Add integration test for end-to-end flow
- [x] Update `agents.md` with new feature documentation
- [x] Run focused tests to verify
- [x] Run full test suite to verify no regressions
