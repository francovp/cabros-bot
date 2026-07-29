fix: enforce signal-outcome deadlines around Binance requests (CB-107)

## Summary

Enforce the signal-outcome evaluation sweep deadline (`SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS`) around Binance `getKlines()` requests and between evaluation windows to prevent delayed background sweeps.

## Key Changes

- Carry remaining duration budget into Binance `getKlines()` calls using a bounded timeout promise (`Promise.race`).
- Re-check the remaining sweep deadline before starting each evaluation window and halt further window/document evaluations immediately if the deadline has expired.
- Preserve fail-open state handling: when a sweep deadline is exceeded during market-data fetch, the pending window remains in `pending` status so it can be retried in a future sweep.
- Add focused unit tests using slow/hanging mocked `getKlines` responses to prove bounded sweep completion and correct deadline re-checking.

## Technical Implementation

- In `SignalOutcomeService.evaluatePendingOutcomes`:
  - Calculate `remainingMs = effectiveMaxDurationMs - (Date.now() - startTime)` before each window.
  - If `remainingMs <= 0`, log a warning, set `allResolved = false`, set `sweepDeadlineExceeded = true`, and break.
  - Wrap `client.getKlines()` in `Promise.race([klinesPromise, timeoutPromise])` with `remainingMs`.
  - Handle sweep deadline timeout error by halting window and document loops without marking the window unavailable.

## Testing

- Ran `pnpm test -- tests/unit/signal-outcome-service.test.js tests/unit/signal-outcome-worker.test.js tests/integration/signal-outcome-integration.test.js` — all 33 tests passed.

## References

- **Linear**: [CB-107](https://linear.app/knil/issue/CB-107/enforce-signal-outcome-deadlines-around-binance-requests-gh-269)
- Fixes #269
