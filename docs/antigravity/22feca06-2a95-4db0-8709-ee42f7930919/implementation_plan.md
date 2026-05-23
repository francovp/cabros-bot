# Goal: Enhanced Expanded Analysis with Multi-Timeframe Alignment

Upgrade the existing `POST /api/webhook/expanded-analysis-alert` webhook to optionally fetch and append multi-timeframe alignment analysis from the TradingView MCP server when requested (via a new parameter `"includeMultiTimeframe": true`).

## User Review Required

> [!IMPORTANT]
> **API Parameter Naming**: The parameter to enable multi-timeframe alignment is proposed as `"includeMultiTimeframe"` (camelCase) and `"include_multi_timeframe"` (snake_case) inside the request body. Both will be supported for backward compatibility and ease of integration.
> **Fail-Open Strategy**: If the multi-timeframe analysis call fails or times out, the endpoint will still send the base report (`coin_analysis` data) and complete the request successfully (logging a warning). This prevents temporary MCP latency or errors from blocking alerts.

---

## Proposed Changes

### TradingView MCP Service

#### [MODIFY] [TradingViewMcpService.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/services/tradingview/TradingViewMcpService.js)
- Add the `callMultiTimeframeAnalysis({ symbol, exchange, signal })` method to invoke the remote MCP `multi_timeframe_analysis` tool with the required arguments.
- Safely unwrap and normalize the response, throwing an error if the remote tool returns an error or invalid payload.

### Report Formatter

#### [MODIFY] [expandedAnalysisAlertReport.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/services/tradingview/expandedAnalysisAlertReport.js)
- Update `parseExpandedAnalysisAlertRequest(req)` to parse and validate `includeMultiTimeframe` (or `include_multi_timeframe`) as an optional boolean parameter in the JSON body.
- Update `buildExpandedAnalysisAlertReport(items, options)` to format and append the Multi-Timeframe Alignment section (in Spanish) when `multiTimeframe` data is attached to an analyzed item.
- Implement formatting for Weekly (1W), Daily (1D), 4H, 1H, and 15M timeframes, translating biases (`Bullish` -> `Alcista`, `Bearish` -> `Bajista`) and displaying indicators (RSI value), alignment confluence, and recommendation action.

### Webhook Controller

#### [MODIFY] [expandedAnalysisAlert.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js)
- Update `postExpandedAnalysisAlert` to pass the `includeMultiTimeframe` flag to `analyzeSymbols`.
- In `analyzeSymbols`, if `includeMultiTimeframe` is true, call `callMultiTimeframeAnalysis` for each symbol sequentially after fetching the base `coin_analysis`.
- Wrap the multi-TF call in a try/catch block to log warnings and proceed without multi-TF details if it fails (fail-open).
- Include the `multiTimeframe` status inside `compactResults`.

---

## Verification Plan

### Automated Tests
- **Unit Tests**:
  - Update `tests/unit/expanded-analysis-alert-report.test.js` to verify parsing of the `includeMultiTimeframe` request body parameters and formatting of the multi-timeframe report section.
  - Create `tests/unit/expanded-analysis-alert.test.js` (or extend existing) to test the controller logic, verifying that the multi-TF tool is called when the flag is set and that it fails open gracefully if the tool fails.
- **Integration Tests**:
  - Update `tests/integration/expanded-analysis-alert-endpoint.test.js` to mock both `coin_analysis` and `multi_timeframe_analysis` tools and test the HTTP endpoint end-to-end.

### Manual Verification
- Deploy to local development server, call the updated endpoint with `curl` using the new flag:
  ```bash
  curl -X POST http://localhost:80/api/webhook/expanded-analysis-alert \
    -H "Content-Type: application/json" \
    -H "x-api-key: YOUR_KEY" \
    -d '{"symbols": ["BINANCE:BTCUSDT"], "includeMultiTimeframe": true}'
  ```
- Verify the Telegram/WhatsApp message formatting and make sure it includes the multi-timeframe alignment block.
