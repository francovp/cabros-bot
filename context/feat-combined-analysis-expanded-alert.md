## Summary

Implement Feature 4: "Combined Analysis Upgrade for Expanded Alert" to optionally request combined technical indicators, Reddit sentiment, RSS financial news, and confluence recommendations from the TradingView MCP server, broadcasting a comprehensive formatted Spanish report to Telegram and WhatsApp.

## Key Changes

### 📡 POST /api/webhook/expanded-analysis-alert

- Enhanced parameters parsing to accept `"analysisMode": "combined"` (defaults to `"standard"`).
- Forwarded parameter to the symbol analysis execution flow.

### 📊 Spanish Report Formatter

- Modified `buildReportRow` to extract indicators nested in `technical` objects returned by the `combined_analysis` tool.
- Extended the group row formatting in Spanish:
  - **Sentimiento Reddit**: Translates sentiment labels (Alcista/Bajista/Neutral), outputs sentiment scores, posts analyzed, and displays matching emojis (🐂/🐻/😐).
  - **Confluencia**: Formats the final recommendation actions (e.g. `🟢 STRONG BUY`, `🔴 SELL`) and alerts on signal alignments.
  - **Últimas Noticias**: Lists up to 3 news headlines, extracting and displaying clear domain/publisher names as sources (e.g., `(bloomberg.com)`).

### 🔌 MCP Combined Analysis Wrapper

- Exposed the `callCombinedAnalysis({ symbol, exchange, timeframe, signal })` service method in `TradingViewMcpService.js` to call the `combined_analysis` tool.

---

## Technical Implementation

### Architecture changes

Updated request parsing, analysis routing, and Spanish formatting logic to support the new `combined_analysis` tool integration.

#### TradingViewMcpService

- Routes request to `callCombinedAnalysis` vs `callCoinAnalysis` based on `analysisMode`.

#### expandedAnalysisAlertReport

- Handles parameter validation and checks for nested technical payloads.
- Constructs multi-layered formatting blocks for Reddit sentiment, confluence, and news headlines.

### Dependencies Added

- None.

### File Structure Additions

```text
docs/antigravity/7052c381-6c81-4b22-92f1-c783f2c674c5/
├── implementation_plan.md
├── task.md
└── walkthrough.md
```

## Testing infrastructure

### Test Suite

- **1 Unit Test** (inside `tradingview-mcp-service.test.js` for routing)
- **1 Unit Test** (inside `tradingview-mcp-service.test.js` for combined analysis wrapper)
- **3 Unit Tests** (inside `expanded-analysis-alert-report.test.js` for request validation)
- **1 Unit Test** (inside `expanded-analysis-alert-report.test.js` for combined report Spanish formatting)
- **1 Integration Test** (inside `expanded-analysis-alert-endpoint.test.js` for end-to-end webhook execution and reporting)

### Test Coverage

- `analysisMode` request validation parsing.
- Service tool selection routing.
- Spanish formatting translation and structure of Reddit sentiment, confluence indicators, and RSS news headlines.
- Webhook JSON payload routing and integration mock testing.

### Test Files

- `tests/unit/tradingview-mcp-service.test.js`
- `tests/unit/expanded-analysis-alert-report.test.js`
- `tests/integration/expanded-analysis-alert-endpoint.test.js`

## Configuration Updates

### Environment Variables

No new environment variables added.

## Documentation Updates

- **Walkthrough**: Added implementation walkthrough and testing results.

## Examples

Example JSON response body for combined mode:
```json
{
  "success": true,
  "alertText": "📊 *ANÁLISIS AMPLIADO — Friday 22/05/2026*\n...\n*🟢 TOP GANADORES*\nBTCUSDT $68,450.20 (+1.2%) | RSI 55.4\n- *Tendencia (SMA20):* Alcista | *MACD:* Bullish\n- *Volumen:* Normal | *ATR:* $120.50\n- *Stop Loss sugerido:* $68,269.45\n- *Sugerencia:* MANTENER / ACUMULAR\n- *Sentimiento Reddit:* 🐂 Alcista (Score: 0.45, 12 posts)\n- *Confluencia:* 🟢 STRONG BUY · Señales Alineadas ✅ (Confianza: high)\n- *Últimas Noticias:*\n  • Bitcoin surges past 68k (CoinDesk)",
  "results": [
    {
      "symbol": "BINANCE:BTCUSDT",
      "status": "analyzed",
      "price": 68450.2,
      "rsi": 55.4
    }
  ]
}
```

## Testing

### Pre-merge Verification

- [x] Run `npm test -- tests/unit/tradingview-mcp-service.test.js tests/unit/expanded-analysis-alert-report.test.js tests/integration/expanded-analysis-alert-endpoint.test.js`
- [x] Run `npm test` to verify no regressions (495 tests passed)

### Post-merge Verification

- [ ] Execute `POST /api/webhook/expanded-analysis-alert` with `"analysisMode": "combined"` and verify formatted Telegram/WhatsApp channels receive sentiment, confluence, and news details.

---

**Review Checklist:**

- [x] Code quality meets project standards
- [x] All tests pass and coverage is maintained
- [x] Documentation is complete and accurate
- [x] Breaking change assessment completed
