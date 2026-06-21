## Summary

Upgrades the `POST /api/webhook/expanded-analysis-alert` webhook to optionally retrieve and append multi-timeframe alignment analysis (Weekly, Daily, 4H, 1H, 15M) from the remote TradingView MCP server when requested using `"includeMultiTimeframe": true` (or `"include_multi_timeframe": true`).

## Key Changes

### 📡 TradingView MCP Service Wrapper

- Added `callMultiTimeframeAnalysis({ symbol, exchange, signal })` to `TradingViewMcpService` to invoke the remote `multi_timeframe_analysis` tool.

### 📝 Report Formatter Updates

- Updated `parseExpandedAnalysisAlertRequest(req)` to handle `includeMultiTimeframe` / `include_multi_timeframe` body parameters.
- Added Spanish formatting for multi-TF alignment biases (translating `Bullish` to `Alcista`, `Bearish` to `Bajista`), RSI values, confluences, confidence, and recommended action.

### ⚡ Fail-Open Webhook Controller

- Updates `expandedAnalysisAlert.js` controller to retrieve multi-TF data sequentially in a try/catch block.
- If the call fails or times out, the endpoint logs a warning but proceeds to deliver the base report to avoid blocking alerts (fail-open strategy).

### 🧪 Tests

- Added unit coverage in `tests/unit/expanded-analysis-alert-report.test.js` to verify parameter parsing and Spanish technical formatting.
- Added integration coverage in `tests/integration/expanded-analysis-alert-endpoint.test.js` to mock responses and assert fail-open, timeout, and conditional behavior.

## Technical Implementation

### Architecture changes

#### `src/services/tradingview/TradingViewMcpService.js`
Exposes the `callMultiTimeframeAnalysis` method.

#### `src/services/tradingview/expandedAnalysisAlertReport.js`
Handles parameter validation and formats the multi-timeframe alignment block.

#### `src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js`
Handles sequential execution and fail-open routing.

### File Structure Additions

```text
docs/antigravity/22feca06-2a95-4db0-8709-ee42f7930919/
├── implementation_plan.md
├── task.md
└── walkthrough.md
```

## Testing infraestructure

### Test Suite

- **11 Unit Tests** (inside `expanded-analysis-alert-report.test.js`)
- **12 Integration Tests** (inside `expanded-analysis-alert-endpoint.test.js`)

### Test Coverage

- Parameter parsing verification for both `includeMultiTimeframe` and `include_multi_timeframe`.
- Spanish report formatting of multi-TF biases and recommendations.
- Sequential controller invocation.
- Fail-open fallback when the multi-TF tool fails or times out.
- Default behavior (non-invocation) when the flag is false or omitted.

### Test Files

- `tests/unit/expanded-analysis-alert-report.test.js`
- `tests/integration/expanded-analysis-alert-endpoint.test.js`

## Configuration Updates

### Environment Variables

No new environment variables added.

## Documentation Updates

- **Walkthrough** Documents the design changes, test suites run, and validation results.

## Examples

Example response payload with `includeMultiTimeframe: true`:
```json
{
  "success": true,
  "alertText": "ANÁLISIS AMPLIADO\n...\n- *Alineación Multi-TF:*\n  • *Semanal (1W):* Alcista (RSI 58.2)\n  • *Diario (1D):* Bajista (RSI 42.4)\n  • *Confluencia:* MIXED (Confianza: Low)\n  • *Recomendación:* HOLD",
  "results": [
    {
      "symbol": "NASDAQ:NVDA",
      "status": "analyzed",
      "multiTimeframe": "success"
    }
  ]
}
```

## Testing

### Pre-merge Verification

- [x] Run unit tests `npm test -- tests/unit/`
- [x] Verify formatter logic handles both camelCase and snake_case request parameters.

### Post-merge Verification

- [ ] Send request to the webhook with `includeMultiTimeframe: true` and verify Telegram/WhatsApp output formatting.

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
