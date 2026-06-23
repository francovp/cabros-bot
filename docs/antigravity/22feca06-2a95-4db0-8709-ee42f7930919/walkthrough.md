# Walkthrough - Enhanced Expanded Analysis with Multi-Timeframe Alignment

We upgraded the `POST /api/webhook/expanded-analysis-alert` webhook to optionally fetch and format multi-timeframe alignment analysis from the remote TradingView MCP server when `"includeMultiTimeframe": true` (or `"include_multi_timeframe": true`) is requested.

## Changes Made

### TradingView MCP Service
- **[TradingViewMcpService.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/services/tradingview/TradingViewMcpService.js)**: Added `callMultiTimeframeAnalysis({ symbol, exchange, signal })` to invoke the `multi_timeframe_analysis` MCP tool.

### Report Formatter
- **[expandedAnalysisAlertReport.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/services/tradingview/expandedAnalysisAlertReport.js)**:
  - Updated `parseExpandedAnalysisAlertRequest(req)` to parse and validate optional boolean parameter `includeMultiTimeframe` / `include_multi_timeframe`.
  - Added `formatMultiTimeframeSection(mtf)` to output timeframe biases (Semanal, Diario, 4H, 1H, 15M) in Spanish, alongside their RSI, confluence level/confidence, and recommendations.
  - Attached the multi-timeframe block to report rows.

### Webhook Controller
- **[expandedAnalysisAlert.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js)**:
  - Updated `postExpandedAnalysisAlert` and `analyzeSymbols` to fetch multi-TF data sequentially in a fail-open block (errors and timeouts log warnings but do not fail the request).
  - Included `multiTimeframe` status inside `compactResults`.

### Tests
- **[expanded-analysis-alert-report.test.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/tests/unit/expanded-analysis-alert-report.test.js)**: Added unit tests for parsing the parameter and formatting the multi-TF output in Spanish.
- **[expanded-analysis-alert-endpoint.test.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/tests/integration/expanded-analysis-alert-endpoint.test.js)**: Added integration test assertions to verify controller logic, parameter handling, and fail-open behaviors. Resolved a test assertion mismatch by formatting expected string with markdown bold asterisks (`• *Semanal (1W):*` instead of `Semanal (1W):`).

---

## Verification Results

### Automated Unit Tests
Executed all 24 unit test files (311 tests) locally inside the sandbox, and all passed:
```bash
PASS tests/unit/expanded-analysis-alert-report.test.js
  Expanded Analysis Alert report
    ...
    includeMultiTimeframe updates
      ✓ parses includeMultiTimeframe and include_multi_timeframe correctly
      ✓ throws request error if includeMultiTimeframe is not a boolean (1 ms)
      ✓ formats the report with multi-timeframe alignment correctly (1 ms)

Test Suites: 24 passed, 24 total
Tests:       311 passed, 311 total
Time:        32.847 s
```
