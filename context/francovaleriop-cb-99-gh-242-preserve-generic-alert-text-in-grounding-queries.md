fix: preserve generic alert text in grounding queries (CB-99)

## Summary

Restricts fallback asset extraction in `deriveAssetContext()` to explicit exchange-prefixed symbols (`EXCHANGE:SYMBOL`) or recognized crypto tickers, preventing generic prose alerts (such as ordinary headlines) from being reduced to an unrelated first word in grounding search queries.

## Key Changes

- Updated `deriveAssetContext()` in `src/services/tradingview/parseTradingViewSignal.js` to require either an explicit exchange prefix (`EXCHANGE:`) or a recognized crypto suffix (`USDT`, `BUSD`, etc.) before treating a token as a symbol in the fallback path.
- Updated `tests/unit/tradingview-signal-parser.test.js` with regression tests for generic prose alerts (`The SEC approved...`, `Bitcoin ETF inflows...`) to ensure they preserve full text in search queries and return `null` asset context.

## Technical Implementation

In `deriveAssetContext()`, the fallback regex previously matched any initial 2–20 character token without an exchange prefix or ticker validation, defaulting `assetClass` to `'stock'`. This caused `deriveCleanSearchQuery()` to discard the rest of the alert text and generate search queries like `'THE stock price news market analyst'`. The fallback now requires explicit symbol evidence (`EXCHANGE:SYMBOL` or crypto suffix matching), ensuring non-symbol prose alerts fall through to retain full text cleaning.

## Testing

- Ran `pnpm test -- tests/unit/tradingview-signal-parser.test.js` — verified all 10 tests pass.
- Ran full unit test suite `pnpm test -- tests/unit/ --testTimeout=5000` — verified 22/22 test suites and 180/180 tests pass.

## References

- **Linear**: [CB-99](https://linear.app/knil/issue/CB-99/preserve-generic-alert-text-in-grounding-queries-gh-242)
- **GitHub Issue**: [#242](https://github.com/francovp/cabros-bot/issues/242)
