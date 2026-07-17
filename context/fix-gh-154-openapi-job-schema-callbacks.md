fix: align OpenAPI async job schema with runtime callbacks and statuses (CB-59)

## Summary

The public OpenAPI schema for async TradingView jobs had drifted from the runtime contract in two ways:

1. **`Job.status` enum mismatch**: The schema used American spelling `canceled` and omitted `timed_out`, while the runtime `JobService` uses British spelling `cancelled` and `timed_out` as terminal statuses.
2. **Missing callback fields**: `TradingViewJobRequest` did not document `callbackUrl`, `callbackSecret`, `callbackEvents`, or `timeoutMs` — all of which are accepted and validated at runtime.

## Key Changes

### `src/openapi/openapi.json`
- **`Job.status` enum**: Changed from `["pending","processing","completed","failed","canceled"]` to `["pending","processing","completed","failed","cancelled","timed_out"]` to exactly match `TERMINAL_JOB_STATUSES` in `JobService.js`.
- **`Job` schema**: Expanded to document all runtime-returned fields: `type`, `createdAt`, `updatedAt`, `totalDurationMs`, `callbackStatus`, `requestedChannels`, `deliveredChannels`, `results`, `scanResults`, `alertText`, `deliveryResults`, `error`, `code`.
- **`CallbackFields` schema** (new): Shared component documenting `callbackUrl` (URI), `callbackSecret` (string), `callbackEvents` (enum array: completed/failed/cancelled/timed_out/processing), and `timeoutMs` (integer, 1–600000ms, default 300000ms).
- **`TradingViewJobRequest`**: Both `expanded-analysis` and `market-scanner` variants now include `CallbackFields` via `allOf`, making callback options visible in generated clients and API docs.
- **Request body examples**: Added `expandedAnalysisWithCallback` and `marketScannerWithCallback` examples to demonstrate callback usage.

### `tests/unit/openapi-contract.test.js`
Added 7 new contract tests in a `Job schema alignment with JobService runtime` describe block:
- Verifies `Job.status` enum matches the runtime status set exactly
- Ensures `canceled` (wrong spelling) is absent
- Ensures `cancelled` (correct spelling) and `timed_out` are present
- Verifies `CallbackFields` schema documents all four callback properties
- Verifies `callbackEvents` enum matches runtime `validEvents` exactly
- Verifies `TradingViewJobRequest` references `CallbackFields` for both variants
- Verifies `timeoutMs` has correct `minimum`, `maximum`, and `default`

### `CabrosBot.postman_collection.json`
Added two new request variants to the **Async Jobs** folder:
- `POST Create TradingView Analysis Job (with Callback)` — expanded-analysis with `callbackUrl`, `callbackSecret`, `callbackEvents`, `timeoutMs`
- `POST Create Market Scanner Job (with Callback)` — market-scanner with `callbackUrl` and `callbackEvents`

## Technical Implementation

The `CallbackFields` schema was extracted as a reusable `$ref` component and composed into `TradingViewJobRequest` via OpenAPI `allOf`, following the existing pattern for `ExpandedAnalysisRequest` and `MarketScannerRequest`. The `Job.status` enum now precisely mirrors `TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])` plus the transient `pending` and `processing` states.

## Testing

- `pnpm test -- tests/unit/openapi-contract.test.js` — all 12 tests pass (5 existing + 7 new)

## References

- **GitHub Issue**: https://github.com/francovp/cabros-bot/issues/154
- **Linear**: [CB-59](https://linear.app/knil/issue/CB-59/align-openapi-async-job-schema-with-runtime-callbacks-and-statuses)
- `src/openapi/openapi.json` — canonical OpenAPI spec
- `src/services/jobs/JobService.js` — runtime job state and callback validation (line 31: `TERMINAL_JOB_STATUSES`, line 385: `validEvents`)
