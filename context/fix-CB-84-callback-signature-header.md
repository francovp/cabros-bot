doc(openapi): document callbackSecret signing header and signature verification (CB-84)

## Summary

Update the OpenAPI document (`src/openapi/openapi.json`) to accurately identify `x-callback-signature` as the HMAC-SHA256 signature header generated when `callbackSecret` or `JOB_CALLBACK_SIGNING_SECRET` is configured. Clarify that the shared secret is used server-side for signature generation and is never transmitted in callback requests.

## Key Changes

- **OpenAPI Schema (`src/openapi/openapi.json`)**:
  - Updated `CallbackFields` description to detail `x-callback-signature` (HMAC-SHA256 over timestamp, event, delivery ID, and raw JSON payload) and note that the shared secret is never transmitted.
  - Updated `callbackSecret` description to explicitly note server-side signature computation and state that the secret is never transmitted.
- **Contract Tests (`tests/unit/openapi-contract.test.js`)**:
  - Added unit tests verifying `CallbackFields` and `callbackSecret` OpenAPI descriptions for `x-callback-signature`, `HMAC-SHA256`, and non-transmission of the raw secret.
  - Added contract assertion ensuring documented callback headers (`x-callback-timestamp`, `x-callback-event`, `x-callback-delivery-id`, `x-callback-signature`) match `JobService` runtime delivery headers without stale claims.

## Technical Implementation

- OpenAPI descriptions updated in `src/openapi/openapi.json`.
- Automated regression assertions added under `Job schema alignment with JobService runtime` in `tests/unit/openapi-contract.test.js`.

## Testing

- Unit test suite run via `npx jest tests/unit/openapi-contract.test.js` (14/14 tests passing).
- All unit test suites executed (`npx jest tests/unit/`) with 0 failures across all modules.

## References

- Fixes #200
- **Linear**: [CB-84](https://linear.app/knil/issue/CB-84/document-callbacksecret-signing-header-correctly-gh-200)
