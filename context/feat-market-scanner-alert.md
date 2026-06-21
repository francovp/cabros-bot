## Summary

Implement the TradingView Market Scanner webhook alert endpoint to support automated scans (such as top gainers, top losers, Bollinger squeeze, volume breakout, smart volume) and broadcast formatted Spanish reports to Telegram and WhatsApp.

## Key Changes

### 📡 POST /api/webhook/market-scanner-alert

- Endpoint that runs requested scans sequentially with deadline abort-signal monitoring.

### 📊 Spanish Report Formatter

- Translates raw indicator data into clean, formatted Spanish lists.
- Filters out positive percentages in perdedores and negative percentages in ganadores.
- Maps `top_losers` absolute percentage values returned by TradingView's MCP server to negative values so they render and filter correctly.

### 🔌 MCP Scan Wrapper

- Integrates with the remote TradingView MCP server scanner tools using a normalized `callScanTool` service helper.

## Technical Implementation

### Architecture changes

Added new scanner handler and report builder under the existing routes & services patterns.

#### marketScanner / marketScannerReport

- Sequential execution of scans with abort signal.
- Formatting of individual indicators (RSI, Bollinger Width, Volume Ratio) into readable metrics.

### Dependencies Added

- None.

### File Structure Additions

```text
src/
├── controllers/webhooks/handlers/marketScanner/
│   └── marketScanner.js             # Sequential scan handler and abort controller deadline
├── services/tradingview/
│   └── marketScannerReport.js       # Request parsing, validation, and report builder
tests/
├── unit/
│   ├── market-scanner-report.test.js # Parser and report formatter tests
│   └── market-scanner.test.js        # Sequential scans, error & timeout handler tests
├── integration/
│   └── market-scanner-endpoint.test.js # supertest endpoint API key and delivery tests
```

## Testing infraestructure

### Test Suite

- **16 Unit Tests** in `market-scanner-report.test.js`
- **7 Unit Tests** in `market-scanner.test.js`
- **4 Integration Tests** in `market-scanner-endpoint.test.js`

### Test Coverage

- Created tests covering all new validation rules, clamping behavior, formatting edge cases (including positive/negative limits mapping), sequential scan execution ordering, partial failures handling, timeouts, API authorization, and notification triggers.

### Test Files

- `tests/unit/market-scanner-report.test.js`
- `tests/unit/market-scanner.test.js`
- `tests/integration/market-scanner-endpoint.test.js`

## Configuration Updates

### Environment Variables (if applicable)

```bash
ENABLE_MARKET_SCANNER=false
MARKET_SCANNER_DEFAULT_EXCHANGE=BINANCE
MARKET_SCANNER_TIMEOUT_MS=90000
```

### Development Workflow updates

- None.

## Documentation Updates

- **README.md**: Added the env variables and `POST /api/webhook/market-scanner-alert` request/response details.
- **AGENTS.md**: Documented technical details, terminology guide, core components, and failure behaviors.

## Examples

Example curl command for local execution:
```bash
curl -X POST http://localhost:80/api/webhook/market-scanner-alert \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_WEBHOOK_API_KEY" \
  -d '{"scans": ["top_gainers", "top_losers"], "limit": 3}'
```

## Performance Considerations

- Sequential scan runner `runScans` prevents overloading the TradingView MCP server concurrently.
- Endpoint deadline abort signal immediately stops pending scans when timeout is reached.

## Security

- Integrated `validateApiKey` middleware on the new route.

## Deployment Considerations

- Ensure `ENABLE_MARKET_SCANNER=true` is set in production.

## Future Enhancements

- Support scan parameters in Telegram bot commands.

## Testing

### Pre-merge Verification

- [x] Run `npm test -- tests/unit/market-scanner-report.test.js`
- [x] Run `npm test -- tests/unit/market-scanner.test.js`
- [x] Run `npm test -- tests/integration/market-scanner-endpoint.test.js`
- [x] Run `npm test` to verify no regressions (466 tests passed)

### Post-merge Verification

- [ ] Set `ENABLE_MARKET_SCANNER=true` on staging/production.
- [ ] Execute `POST /api/webhook/market-scanner-alert` with valid `x-api-key`.

## References

- None.

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
