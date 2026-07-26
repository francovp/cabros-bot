# feat(storage): extract symbol and exchange from raw alert text (CB-91)

## Summary
Enhance `AlertStorageService` symbol extraction logic to parse TradingView symbols and exchange prefixes directly from raw alert text when explicit object properties (`symbol`, `enrichmentData.symbol`) are absent, eliminating `unknown` symbol classification in stored alert analytics (`GET /api/alerts/summary`).

## Key Changes
- **Text Pattern Parsing**: Added `parseSymbolFromText` helper in `AlertStorageService.js` to extract symbols and exchanges from standard TradingView alert formats (`BATS:TSM(D)`, `BINANCE:ETHUSDT(4h)`, `SPCFD:SPX(D)`, `BTCUSDT(1h)`).
- **Symbol & Exchange Extraction**: Extended `extractSymbolAndExchange` to inspect candidate fields (`data.symbol`, `data.ticker`, `data.enrichmentData.symbol`), falling back to raw `data.text` parsing before returning `{ symbol: 'unknown', exchange: null }`.
- **Alert Persistence**: Updated `saveAlert` to extract and attach `symbol` and `exchange` properties to stored Firestore document payloads when valid patterns match.
- **Analytics & Unit Tests**: Added unit tests in `tests/unit/alert-storage-service.test.js` verifying symbol extraction from raw text strings across TradingView formats, and updated summary tests for `bySymbol` metrics.

## Testing
- Unit tests (`tests/unit/alert-storage-service.test.js`): All 46 tests passing.

## References
- **Linear**: [CB-91](https://linear.app/knil/issue/CB-91/implement-regex-symbol-extraction-in-alertstorageservice-and-webhook)
- Closes #222
