fix: normalize idempotency fingerprint to ignore transport keys (CB-31)

## Summary

Normalize the request fingerprint used for idempotency hashing to exclude key transport fields (`idempotencyKey` and `idempotency_key`) from request body and query. This prevents false 409 IDEMPOTENCY_CONFLICT responses when retries supply the same key via different supported locations.

## Key Changes

- Exclude `idempotencyKey` and `idempotency_key` fields from `body` and `query` when constructing the request fingerprint in `buildRequestFingerprint()`.
- Add comprehensive unit and regression tests in `tests/unit/idempotency.test.js` covering location transitions (header-to-body, body-to-header, query-to-header) and actual payload/query flag mismatch conflict checks.

## Technical Implementation

- Updated `buildRequestFingerprint` in `src/lib/idempotency.js` to create shallow copies of `req.body` and `req.query` and delete the `idempotencyKey` and `idempotency_key` keys if present, ensuring the resulting hash only reflects the business payloads.

## Testing

- Verified all unit and integration tests pass locally.
- Added 5 new regression test cases verifying successful location transitions and correct mismatch conflict detection.

## References

- **GitHub**: Closes #90
- **Linear**: [CB-31](https://linear.app/knil/issue/CB-31/fix-idempotency-conflicts-when-key-moves-between-supported-locations)
