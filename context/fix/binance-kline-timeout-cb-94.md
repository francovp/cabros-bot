fix: decouple Binance kline timeout from news-monitor price fetch (CB-94)

## Summary

Decouples the Binance price request timeout from the optional kline indicator fetch in the news-monitor analyzer so that a successful price fetch is not discarded when `getKlines` hangs or times out.

## Key Changes

- **Analyzer Bounded Timers**: Refactored `fetchBinancePrice` in `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` to decouple the price timeout (which rejects on timeout to trigger Gemini fallback) from the kline indicators timeout (which resolves to `null` on timeout or error).
- **Timer Cleanup**: Added explicit `clearTimeout` cleanup in a `.finally()` block so lingering timeout handles do not remain open in Jest or production event loops.
- **Unit Test Coverage**: Added `tests/unit/news-monitor-binance-timeout.test.js` to prove that a successful Binance price is returned with `volumeRatio: null` and `rsi: null` even when `getKlines` hangs indefinitely or rejects with an error.

## Technical Implementation

- `withTimeout` helper wraps the mandatory price request (`client.getAvgPrice`) with a rejecting timeout and optional indicators request (`client.getKlines`) with a fallback `null` timeout.
- Both promises run concurrently via `Promise.all([pricePromise, klinesPromise])`.
- Configurable environment variable `BINANCE_FETCH_TIMEOUT_MS` allows unit tests to execute rapidly while maintaining a 5-second production default.

## Testing

- Added `tests/unit/news-monitor-binance-timeout.test.js` covering:
  - `getKlines` hanging/timing out preserving the Binance price.
  - `getAvgPrice` timing out returning `null` (triggering Gemini fallback).
  - Both price and klines succeeding returning calculated indicators.
  - `getKlines` error/rejection returning Binance price with `null` indicators.
- Verified all 50 unit test suites (742 tests) pass clean.

## References

- **Linear**: [CB-94](https://linear.app/knil/issue/CB-94/decouple-binance-kline-timeout-from-news-monitor-price-fetch-gh-236)
- **GitHub**: #236
