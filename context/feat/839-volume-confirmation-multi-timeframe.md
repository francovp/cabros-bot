# feat(volume-confirmation): Add optional multi-timeframe confluence to volume confirmation endpoint

## Summary

Adds optional higher-timeframe trend confluence to `POST /api/webhook/volume-confirmation`. When `includeMultiTimeframe: true` (or `include_multi_timeframe: true`) is provided and `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME === 'true'`, the endpoint invokes `tradingViewMcpService.callMultiTimeframeAnalysis({ symbol, exchange })` and scores alignment using `resolveTrendConfluence(item, 'volume_confirmation', { trendConfluence })`. The response returns `multiTimeframeAnalysis`, `htfAlignment` (`aligned` | `counter-trend` | `unknown`), and nested `volumeConfirmation: { ...decision, analysis }`. Failures in multi-timeframe analysis fail open (returning 200 with `multiTimeframeAnalysis: null` and `htfAlignment: 'unknown'`). Non-boolean values for `includeMultiTimeframe` return 400 `INVALID_REQUEST`.

## Key Changes

- **Request Parsing (`src/services/tradingview/volumeConfirmationRequest.js`)**:
  - Implemented `parseIncludeMultiTimeframe(body)`: parses `includeMultiTimeframe` and `include_multi_timeframe`. Supports booleans and case-insensitive `'true'`/`'false'` strings. Throws `VolumeConfirmationRequestError('includeMultiTimeframe must be a boolean')` for non-boolean values. Defaults to `false`.
  - Added extraction of optional directional hints (`side`, `direction`, `breakoutType`, `tradingRecommendation`).
- **Scoring & Alignment (`src/services/tradingview/marketScannerScoring.js`)**:
  - Updated `resolveTrendConfluence` to include `scanType === 'volume_confirmation'` alongside `bollinger_scan` as a directionless scan type.
  - Allows higher-timeframe trend bias to evaluate `status: 'aligned'` when no explicit candidate direction is supplied, while correctly evaluating `aligned` vs `counter-trend` when candidate direction (`side`, `direction`, etc.) is provided.
- **Controller Enrichment & Fail-Open (`src/controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation.js`)**:
  - Gated multi-timeframe execution behind `parsed.includeMultiTimeframe && process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME === 'true'`.
  - Implemented try/catch fail-open behavior logging a warning and falling back to `multiTimeframeAnalysis: null` and `htfAlignment: 'unknown'`.
  - Preserved backward compatibility by maintaining all top-level response properties while adding `volumeConfirmation`, `multiTimeframeAnalysis`, and `htfAlignment`.
- **Contracts & Documentation**:
  - Updated `src/openapi/openapi.json`: Added `includeMultiTimeframe`, `side`, and `direction` properties to `VolumeConfirmationRequest` schema and updated request example.
  - Updated `CabrosBot.postman_collection.json`: Added `includeMultiTimeframe: true` to request body and added 200 (with multi-timeframe confluence) and 400 (invalid flag) response examples.
  - Updated `README.md`: Documented `includeMultiTimeframe` request parameter, directional hints, response payload, and fail-open behavior.

## Technical Implementation

- `src/services/tradingview/volumeConfirmationRequest.js`: Added parsing helper and directional fields.
- `src/services/tradingview/marketScannerScoring.js`: Added `volume_confirmation` to `resolveTrendConfluence` directionless scan conditions.
- `src/controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation.js`: Orchestrated multi-timeframe analysis, scoring, and response formatting.
- `tests/unit/volume-confirmation-request.test.js`: Added unit tests for request parsing variations and error conditions.
- `tests/unit/market-scanner-scoring.test.js`: Added unit tests for `resolveTrendConfluence` with `scanType: 'volume_confirmation'`.
- `tests/integration/volume-confirmation-endpoint.test.js`: Added integration tests for enabled flag, directional evaluation, fail-open fallback, disabled flag, and 400 invalid input.

## Verification

- `pnpm test -- tests/unit/volume-confirmation-request.test.js tests/unit/market-scanner-scoring.test.js tests/integration/volume-confirmation-endpoint.test.js` (50 tests passing)
- `pnpm test -- tests/unit/openapi-contract.test.js tests/integration/openapi-docs.test.js` (28 tests passing)
- `pnpm test -- tests/unit/postman-collection.test.js` (15 tests passing)
- `pnpm test -- tests/unit/docs-alignment.test.js` (9 tests passing)
- `pnpm test` (Full test suite: 151 test suites, 2,750 tests passing, 0 failures)

## References

- Closes #839
- Linear: N/A (Linear issue creation skipped per user instructions)
