fix: validate signal-outcome worker intervals (CB-108)

## Summary

The autonomous signal-outcome evaluation worker previously passed raw parsed integer values or malformed strings to `setInterval` without validating that the result was a finite, positive number. When interval env variables or options were set to malformed strings (e.g. `"invalid"`), zero (`0`), or negative values, `setInterval` received `NaN`, zero, or negative numbers, triggering continuous polling at Node's minimum timer delay (~1ms) or causing unexpected behavior.

This change introduces a shared `parsePositiveInteger(val, defaultVal)` helper function in `SignalOutcomeService` to sanitize all interval, batch limit, and duration budget configurations, falling back to the documented 300000ms (5 minutes) default cadence whenever an invalid, zero, or negative interval is provided.

## Key Changes

- Added `parsePositiveInteger(val, defaultVal)` helper in `src/services/storage/SignalOutcomeService.js` to ensure positive finite numbers.
- Applied `parsePositiveInteger` validation across worker initialization (`startWorker`), operational status (`getWorkerStatus`), and background sweep parameters (`evaluatePendingOutcomes`).
- Added unit tests in `tests/unit/signal-outcome-worker.test.js` verifying that malformed, zero, and negative interval values correctly fall back to default 300000ms while valid positive values configure the worker as intended.

## Technical Implementation

- In `src/services/storage/SignalOutcomeService.js`:
  - `parsePositiveInteger(val, defaultVal)` checks if value is non-empty, parses as base-10 integer, and returns value if `Number.isFinite(parsed) && parsed > 0`; otherwise returns `defaultVal`.
  - Used for `options.intervalMs`, `process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS`, `process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS`, `process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT`, and `process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS`.

## Testing

- Ran `pnpm test -- tests/unit/signal-outcome-service.test.js tests/unit/signal-outcome-worker.test.js --testTimeout=5000` — all 34 tests passed.

## References

- **Linear**: [CB-108](https://linear.app/knil/issue/CB-108/validate-signal-outcome-worker-intervals)
- **GitHub Issue**: [#270](https://github.com/francovp/cabros-bot/issues/270)
