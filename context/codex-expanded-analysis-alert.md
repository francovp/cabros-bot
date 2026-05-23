# feat: add expanded analysis alert report

## Summary

Adds an Expanded Analysis Alert endpoint backed by TradingView MCP that accepts complete `EXCHANGE:SYMBOL` identifiers, generates a grouped Spanish technical-analysis report, sends it through the existing notification channels, returns per-symbol plus delivery results, and caps analysis duration with a request-level deadline.

## Key Changes

### :chart_with_upwards_trend: Expanded Analysis Alert endpoint

- Added `POST /api/webhook/expanded-analysis-alert` behind the existing API-key middleware.
- Parses request body `symbols` first, then falls back to `EXPANDED_ANALYSIS_ALERT_SYMBOLS`.
- Returns `400 NO_SYMBOLS` when neither source provides symbols.
- Applies `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS` as a total analysis deadline with a 60 second default and 120 second cap.
- Returns `504 EXPANDED_ANALYSIS_ALERT_TIMEOUT` when the deadline expires before any symbol can be analyzed.
- Returns `502 ALL_SYMBOLS_FAILED` when every MCP analysis call fails and skips notification delivery.

### :bar_chart: Report generation

- Added request parsing and report formatting in `src/services/tradingview/expandedAnalysisAlertReport.js`.
- Groups symbols by RSI into extreme oversold, oversold, neutral, and overbought sections.
- Formats price, percent change, RSI, SMA20 trend, MACD direction, volume, optional ATR, suggested stop loss, and action suggestion.
- Keeps crypto symbols strict: callers must pass full pairs such as `BINANCE:BTCUSDT`.

### :satellite: MCP integration

- Extended `TradingViewMcpService` with `analyzeSymbolIdentifier()` for `EXCHANGE:SYMBOL` inputs.
- Updated the default MCP endpoint to `https://tradingview-mcp.onrender.com/mcp`.
- Reuses the existing retry helper for report symbol analysis so transient MCP failures respect `TRADINGVIEW_MCP_MAX_RETRIES`.
- Serializes report symbol analysis to avoid concurrent `coin_analysis` calls triggering upstream MCP JSON decode failures.
- Stops retry/backoff chains when the endpoint deadline aborts.
- Propagates abort signals through MCP initialize, initialized notification, tool call, fetch, and response-body reading.
- Supports both the older `technical_indicators` MCP schema and the current top-level `rsi`, `macd`, `sma`, `bollinger_bands`, `atr`, and `volume_analysis` schema.

## Technical Implementation

### Architecture changes

#### `src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js`

Coordinates request parsing, sequential MCP analysis, deadline handling, report creation, notification dispatch through the existing `NotificationManager`, and HTTP response assembly.

#### `src/lib/retryHelper.js`

Extends the shared retry helper with optional `AbortSignal` support so long retry chains can be cancelled without affecting existing callers.

#### `src/services/tradingview/expandedAnalysisAlertReport.js`

Owns validation and formatting for the report endpoint, including timeframe validation and grouped Markdown generation.

### File Structure Additions

```text
docs/superpowers/
├── plans/
│   └── 2026-05-22-expanded-analysis-alert-endpoint.md
└── specs/
    └── 2026-05-22-expanded-analysis-alert-endpoint-design.md
src/controllers/webhooks/handlers/expandedAnalysisAlert/
└── expandedAnalysisAlert.js
src/services/tradingview/
└── expandedAnalysisAlertReport.js
tests/integration/
└── expanded-analysis-alert-endpoint.test.js
tests/unit/
├── retry-helper.test.js
├── expanded-analysis-alert-report.test.js
└── tradingview-mcp-service.test.js
```

## Testing infraestructure

### Test Suite

- **13 Unit Tests**
- **9 Integration Tests**

### Test Coverage

- Request body symbols take precedence over `EXPANDED_ANALYSIS_ALERT_SYMBOLS`.
- Env fallback behavior and `400 NO_SYMBOLS`.
- Invalid `EXCHANGE:SYMBOL` and unsupported timeframe validation.
- Report grouping and Spanish Markdown formatting.
- Current MCP schema mapping for RSI, SMA20 trend, MACD, volume, and stop loss.
- Sequential symbol analysis to avoid concurrent MCP failures.
- Endpoint deadline response with `504 EXPANDED_ANALYSIS_ALERT_TIMEOUT`.
- Timeout result marking for in-flight and remaining symbols.
- Removed-route coverage for the previous endpoint path.
- Abort-aware retry behavior in `sendWithRetry()` and `TradingViewMcpService`.
- Successful notification dispatch and delivery result response.
- All-symbol MCP failure response without delivery.

### Test Files

- `tests/unit/expanded-analysis-alert-report.test.js`: parser and formatter coverage.
- `tests/unit/tradingview-mcp-service.test.js`: retry and abort behavior for report symbol analysis.
- `tests/unit/retry-helper.test.js`: abort-aware retry behavior.
- `tests/integration/expanded-analysis-alert-endpoint.test.js`: endpoint behavior, timeout handling, and notification dispatch coverage.

## Configuration Updates

### Environment Variables

```bash
EXPANDED_ANALYSIS_ALERT_SYMBOLS=BINANCE:BTCUSDT,NASDAQ:NVDA
EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS=60000
TRADINGVIEW_MCP_URL=https://tradingview-mcp.onrender.com/mcp
TRADINGVIEW_MCP_DEFAULT_TIMEFRAME=1D
```

## Documentation Updates

- **README** Documents the new endpoint, response shape, timeout behavior, and TradingView MCP env vars.
- **agents.md** Adds endpoint orientation, failure behavior, and file ownership notes.
- **Superpowers docs** Adds the approved design and implementation plan.

## Testing

### Pre-merge Verification

- [x] `pnpm test -- tests/unit/expanded-analysis-alert-report.test.js tests/integration/expanded-analysis-alert-endpoint.test.js --testTimeout=5000`
- [x] `pnpm test -- tests/unit/tradingview-mcp-service.test.js tests/unit/expanded-analysis-alert-report.test.js tests/integration/expanded-analysis-alert-endpoint.test.js --testTimeout=10000`
- [x] `pnpm test -- tests/unit/expanded-analysis-alert-report.test.js tests/unit/tradingview-mcp-service.test.js tests/integration/expanded-analysis-alert-endpoint.test.js --testTimeout=10000`
- [x] `pnpm test -- tests/unit/retry-helper.test.js tests/unit/tradingview-mcp-service.test.js tests/integration/expanded-analysis-alert-endpoint.test.js --testTimeout=10000`
- [x] Live MCP smoke: new route completed a 2-symbol request with status 200 in about 54 seconds.
- [x] Live timeout smoke: forced 1ms deadline returned `504 EXPANDED_ANALYSIS_ALERT_TIMEOUT` in about 33ms.
- [x] `pnpm test`
- [x] `pnpm lint`

### Post-merge Verification

- [ ] Call `POST /api/webhook/expanded-analysis-alert` with production notification env configured.
- [ ] Verify Telegram/WhatsApp delivery contains the grouped Spanish report.
- [ ] Verify invalid or missing symbols return the expected 400 response.

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
