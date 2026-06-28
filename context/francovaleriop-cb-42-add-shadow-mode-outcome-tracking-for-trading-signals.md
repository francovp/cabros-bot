## Summary

Implement shadow-mode outcome tracking for alert-producing trading surfaces to normalize signal metadata and periodically evaluate signal performance (+1h, +4h, +1D, +1W) using Binance historical kline data, exposing aggregates on summary and export routes.

## Key Changes

### :chart_with_upwards_trend: Signal Telemetry & Storage
- Normalized signal metadata fields (symbol, exchange, timeframe, score, side, price, etc.) across all alert generators.
- Automated entry price resolution from Binance if not supplied at decision time.
- Enforced a strict fail-open path for all storage operations, ensuring database/network errors never block webhook execution or bot alerts.

### :arrows_counterclockwise: Outcome Evaluation Service
- Added background outcome worker evaluating kline history for +1h, +4h, +1D, and +1W windows.
- Calculated return, maximum adverse excursion (MAE), and maximum favorable excursion (MFE) percentages for long/BUY and short/SELL setups.
- Supported marking stock symbols or missing klines as `unavailable`.

### :bar_chart: Analytics Integration
- Surfaced aggregated metrics (`shadowModeMetrics` containing hit rates, average returns, MAE, MFE, drawdown proxy, false-positives, and token/latency costs) inside `/api/alerts/summary`.
- Surfaced metrics in NDJSON/CSV export responses using the custom HTTP header `X-Shadow-Mode-Metrics`.

## Technical Implementation

### Architecture changes

#### `SignalOutcomeService` (`src/services/storage/SignalOutcomeService.js`)
- Exposes `recordSignal`, `evaluatePendingOutcomes`, and `getMetricsSummary`.

#### Webhook Controllers (`alert.js`, `marketScanner.js`, `expandedAnalysisAlert.js`, `analyzer.js`)
- Integrated `recordSignal` calls in a fire-and-forget manner.

### File Structure Additions

```
src/
└── services/
    └── storage/
        └── SignalOutcomeService.js    # Telemetry persistence and metrics worker
tests/
├── unit/
│   └── signal-outcome-service.test.js  # Service logic unit tests
└── integration/
    └── signal-outcome-integration.test.js # Webhook endpoint tests
```

## Testing infrastructure

### Test Suite
- **13 Unit Tests**
- **2 Integration Tests**
- Full test suite run verified with 100% pass rate.

### Test Files
- `tests/unit/signal-outcome-service.test.js`: Checks side normalization, entry price auto-fetching, and MFE/MAE/return math.
- `tests/integration/signal-outcome-integration.test.js`: Checks endpoint integration, summary payload, and export headers.

## Configuration Updates

### Environment Variables

```bash
ENABLE_SHADOW_MODE_OUTCOME_TRACKING=true
```

## References

- Closes #129
- Linear issue CB-42

---

**Review Checklist:**
- [x] Code quality meets project standards
- [x] All tests pass and coverage is maintained
- [x] Documentation is complete and accurate
- [x] Breaking change assessment completed
