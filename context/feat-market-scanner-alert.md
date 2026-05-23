# feat: add TradingView Market Scanner webhook alerts

Implement the TradingView Market Scanner webhook alert feature, allowing automated market scanning and Spanish report broadcasting to Telegram and WhatsApp.

## Summary of Changes

- **Endpoint Registration**: Added `POST /api/webhook/market-scanner-alert` in `src/routes/index.js`.
- **Market Scanner Handler**: Implemented `postMarketScannerAlert` in `src/controllers/webhooks/handlers/marketScanner/marketScanner.js`. Runs requested scans sequentially with deadline abort-signal monitoring.
- **MCP Scan Wrapper**: Created a `callScanTool` method in `TradingViewMcpService.js` to run and normalize scanner tool results from the TradingView MCP server.
- **Spanish Report Formatter**: Added `marketScannerReport.js` to parse/validate payloads (clamping, defaults) and construct formatted technical reports in Spanish (filtering positive changes in losers and negative changes in gainers).
- **Unit and Integration Tests**:
  - `tests/unit/market-scanner-report.test.js` covering validation and rendering rules.
  - `tests/unit/market-scanner.test.js` covering controller sequential execution, error handling, and timeout behavior.
  - `tests/integration/market-scanner-endpoint.test.js` testing endpoint authorization, integration with notification dispatchers, and error handling.
- **Documentation**: Updated `README.md`, `AGENTS.md`, and `.env.example` with scanner configurations and endpoint usages.
