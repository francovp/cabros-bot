## Summary

Add risk/reward and invalidation metadata formatting to market scanner reports to match the feature set of expanded analysis reports.

## Key Changes

### 📈 Risk/Reward and Invalidation Metadata

- Compute stop-loss and invalidation levels using ATR, Bollinger lower band, or support levels when present.
- Derive take-profit targets from nearest resistance, Bollinger upper band, or ATR multiples.
- Compute the risk-to-reward ratio (`riskRewardRatio`) and classify setups as `favorable`, `neutral`, or `poor`.
- Format and append compact Spanish lines under each scan item containing this metadata.
- Safely fail-open and omit risk/reward metadata when required fields are missing.

## Technical Implementation

### Architecture changes

#### `src/services/tradingview/marketScannerReport.js`

- Added helper functions:
  - `getInvalidationDistance(price, stopLoss)`
  - `getRiskRewardRatio(price, stopLoss, takeProfit)`
  - `classifyRiskReward(ratio)`
- Updated `formatScanItem` to extract ATR, Bollinger bands, support, and resistance indicators and append Stop Loss and Target metadata lines when data is available.
- Patched `numberOrNull` to explicitly check for `null` and `undefined` to prevent JS `Number(null)` converting to `0`.

## Testing infrastructure

### Test Suite

- **16 to 20 Unit Tests** (4 new unit tests added)

### Test Coverage

- Added unit tests covering:
  - ATR-based risk/reward formatting.
  - Bollinger-based risk/reward formatting.
  - Support/resistance-based risk/reward formatting.
  - Graceful omission of risk metadata when indicators are missing or incomplete.

### Test Files

- `tests/unit/market-scanner-report.test.js`: Contains unit tests for scanner report parsing and formatting.

## References

- Links:
  - Closes #146
  - Linked to Linear Issue CB-50

---

**Review Checklist:**

- [x] Code quality meets project standards
- [x] All tests pass and coverage is maintained
- [x] Documentation is complete and accurate
