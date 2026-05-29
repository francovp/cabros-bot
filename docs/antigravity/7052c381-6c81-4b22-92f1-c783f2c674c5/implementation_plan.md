# Combined Analysis Upgrade for Expanded Alert

Enhance the `/api/webhook/expanded-analysis-alert` webhook to optionally request a combined analysis (integrating technical indicators, Reddit sentiment, RSS financial news, and confluence recommendation) from the TradingView MCP server when `analysisMode: "combined"` is provided in the request body.

## User Review Required

> [!IMPORTANT]
> **API Parameter Gating**: The new mode is requested by passing `"analysisMode": "combined"` in the JSON request body (defaults to `"standard"` for backward compatibility).
> **Aesthetic Spanish Format**: Reddit sentiment shows translated labels (Alcista/Bajista/Neutral) with emojis (🐂/🐻/😐) and posts count. Confluence recommendation shows clear labels (e.g., `🟢 STRONG BUY`, `🔴 SELL`) and signals alignment. Latest RSS news headlines display up to 3 articles with source publishers without rendering broken URLs.
> **Fail-Open Strategy**: Like other integrations, if the `combined_analysis` MCP tool call fails or times out, the webhook will log a warning and proceed without blocking alert delivery.

## Open Questions

None. The requirements for parameter routing, Spanish translation, and formatting are clear and aligned with existing code patterns.

## Proposed Changes

### TradingView MCP Service

#### [MODIFY] [TradingViewMcpService.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/services/tradingview/TradingViewMcpService.js)
- Add `callCombinedAnalysis({ symbol, exchange, timeframe, signal })` to invoke the remote MCP tool `combined_analysis`.
- Update `analyzeSymbolIdentifier` to accept an optional `analysisMode` parameter and select the correct analysis function (`callCombinedAnalysis` vs `callCoinAnalysis`).

---

### Expanded Analysis Alert Formatting and Validation

#### [MODIFY] [expandedAnalysisAlertReport.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/services/tradingview/expandedAnalysisAlertReport.js)
- In `parseExpandedAnalysisAlertRequest`, validate that `analysisMode` (if provided) is a string and either `"standard"` or `"combined"`. Default to `"standard"`.
- Update `buildReportRow` to extract `price_data`, `technical_indicators`, `rsi`, `bollinger_bands`, etc. from the nested `analysis.technical` object when it is present (as returned by `combined_analysis`), fell back to `analysis` for backward compatibility.
- Extract `sentiment`, `confluence`, and `news` from the combined analysis payload.
- Update `formatGroupRows` to append Reddit sentiment summary, confluence recommendation (with emojis), and latest RSS news headlines (up to 3 articles with titles and sources, e.g. `(CoinDesk)`) in Spanish.

---

### Expanded Analysis Alert Controller

#### [MODIFY] [expandedAnalysisAlert.js](file:///Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js)
- Pass `analysisMode` from the parsed request down to `analyzeSymbols` and `analyzeSymbolIdentifier`.

---

## Verification Plan

### Automated Tests

- **Unit Tests**:
  - Update `tests/unit/tradingview-mcp-service.test.js` to verify `callCombinedAnalysis` invokes the remote tool and handles the payload correctly.
  - Update `tests/unit/expanded-analysis-alert-report.test.js` to test `parseExpandedAnalysisAlertRequest` validates `analysisMode` correctly, and `buildExpandedAnalysisAlertReport` correctly formats Reddit sentiment, confluence recommendations, and RSS news headlines.
- **Integration Tests**:
  - Update `tests/integration/expanded-analysis-alert-endpoint.test.js` to mock `combined_analysis` tool responses and verify the endpoint responds with the formatted report.

Run tests using:
`npm test -- tests/unit/tradingview-mcp-service.test.js tests/unit/expanded-analysis-alert-report.test.js tests/integration/expanded-analysis-alert-endpoint.test.js`
