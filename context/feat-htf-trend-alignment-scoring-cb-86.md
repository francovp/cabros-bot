feat: add higher-timeframe trend alignment scoring to market scanner (CB-86)

## Summary
Incorporates higher-timeframe (HTF) trend alignment scoring and counter-trend penalty logic into the market scanner service (`POST /api/webhook/market-scanner-alert`). Candidates matching HTF trend (e.g. bullish HTF for top gainers or bullish breakouts) receive a score boost, while counter-trend setups receive a penalty, reducing false breakout signals and improving setup quality.

## Key Changes
- **`src/services/tradingview/marketScannerScoring.js`**:
  - Extended `scoreScannerItem` to accept `options.htfTrend` (or `item.htfTrend` / `item.htf_trend` / `item.higherTimeframeTrend`).
  - Added HTF setup direction evaluation (`BULLISH` vs `BEARISH`) and applied `htfBoost` (+10 points) or `htfPenalty` (-10 points).
  - Updated score reason text to explicitly include `HTF aligned (+10)` or `⚠️ HTF counter-trend (-10)`.
- **`src/services/tradingview/marketScannerReport.js`**:
  - Added `parseHtfTrend` to `parseMarketScannerRequest` to validate and normalize `htfTrend` input (`bullish`, `bearish`, `neutral`).
  - Updated `prepareMarketScannerItems`, `buildMarketScannerReport`, and `formatScanItem` to propagate and format HTF trend metadata in scanner reports.
- **`src/controllers/webhooks/handlers/marketScanner/marketScanner.js`**:
  - Passed `parsed.htfTrend` to `buildMarketScannerReport` and `compactScanResults`.
- **Tests**:
  - `tests/unit/market-scanner-scoring.test.js`: Verified HTF trend alignment boost, counter-trend penalty, and fail-open fallback when HTF trend is omitted.
  - `tests/integration/market-scanner-endpoint.test.js`: Added integration test for `htfTrend` request parameter and score reason formatting.

## Technical Implementation
- Pure scoring function `scoreScannerItem` normalizes HTF trend tokens (`bullish`, `bearish`, `neutral`).
- Preserves complete fail-open behavior: when HTF trend data is omitted, scoring functions identically to single-timeframe evaluation with 0 impact.

## Testing
- Unit tests: `pnpm test -- tests/unit/market-scanner-scoring.test.js` (19 passing)
- Integration tests: `pnpm test -- tests/integration/market-scanner-endpoint.test.js` (8 passing)
- Full test suite: `pnpm test`

## References
- **GitHub Issue**: #217
- **Linear**: [CB-86](https://linear.app/knil/issue/CB-86/add-higher-timeframe-trend-alignment-to-scanner-scoring)
