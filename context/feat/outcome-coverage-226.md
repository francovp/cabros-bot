feat: expose outcome-measurement coverage before enabling signal tracking (CB-92)

## Summary
Expose outcome-measurement coverage, eligibility state classifications, and per-exchange breakdowns in `SignalOutcomeService` before enabling signal tracking in production.

## Key Changes
- Extended `SignalOutcomeService` to determine terminal eligibility states (`supported_provider`, `unsupported_exchange`, `missing_entry_price`, `unparseable_symbol`) and reason descriptions for recorded signals.
- Updated `getMetricsSummary()` to compute total received, eligible, evaluated, pending, and unavailable signal counts across all exchanges, alongside `coveragePercent` and per-exchange/eligibility breakdowns.
- Preserved existing window statistics (hit rate, return, MAE, MFE, latency, costs) while adding `populationNote` and `isCoverageComplete` flags to clarify the evaluated subset.
- Added comprehensive unit test coverage for non-Binance exchange signals (`BATS`, `SPCFD`), unparseable symbols, missing entry prices, and a 54-alert production mix reconciliation fixture.

## Technical Implementation
- `normalizeSymbolAndExchange()`: Handles `UNKNOWN` symbol and exchange normalization.
- `determineEligibility()`: Classifies eligibility state and reason based on exchange support and entry price availability.
- `recordSignal()`: Persists `eligibilityState`, `eligibilityReason`, and sets initial window outcome status to `unavailable` with reason for ineligible signals.
- `evaluatePendingOutcomes()`: Updates pending windows to `unavailable` when symbols are unsupported or lack entry prices.
- `getMetricsSummary()`: Walks snapshot documents, calculates per-exchange breakdowns (`BINANCE`, `BATS`, `SPCFD`, `UNKNOWN`), reconciles overall counts, and returns coverage statistics.

## Testing
- Unit tests: `pnpm test -- tests/unit/signal-outcome-service.test.js` (18 passed, including coverage breakdown and 54-alert fixture reconciliation).
- Integration tests: `pnpm test -- tests/integration/signal-outcome-integration.test.js` (2 passed).
- Integration tests: `pnpm test -- tests/integration/alerts-endpoint.test.js` (19 passed).

## References
- **GitHub Issue**: https://github.com/francovp/cabros-bot/issues/226
- **Linear**: [CB-92](https://linear.app/knil/issue/CB-92/expose-outcome-measurement-coverage-before-enabling-signal-tracking-gh)
