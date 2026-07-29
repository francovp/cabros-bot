fix: validate signal-outcome worker intervals (CB-108)

## Summary
The signal-outcome evaluation worker previously passed raw interval configurations directly to `setInterval`, allowing malformed, zero, or negative interval values to cause unexpected high-frequency polling. This change validates configuration parameters and falls back to the documented 5-minute default cadence (300,000 ms).

## Key Changes
- Added `parsePositiveInteger` and `resolveWorkerInterval` helpers to `SignalOutcomeService.js`.
- Updated `startWorker` and `getWorkerStatus` to resolve interval configurations through the validation helper before configuring `setInterval` or reporting metrics.
- Added comprehensive unit tests in `tests/unit/signal-outcome-worker.test.js` covering invalid options, zero/negative intervals, malformed env strings, and valid positive intervals.

## Technical Implementation
- Values provided via `options.intervalMs`, `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS`, or `SIGNAL_OUTCOME_EVALUATION_CADENCE_MS` are parsed to ensure they are finite positive integers (`> 0`).
- Any malformed string (e.g., `'invalid'`), zero (`0`), or negative value (`-5000`) safely resolves to the default cadence (`300000` ms).
- Worker status reporting via `getWorkerStatus()` accurately reflects the effective validated interval.

## Testing
- Ran focused unit test suite: `pnpm test -- tests/unit/signal-outcome-worker.test.js`.
- All 10 unit test cases passed successfully.

## References
- **GitHub Issue**: [GH-270](https://github.com/francovp/cabros-bot/issues/270)
- **Linear**: [CB-108](https://linear.app/knil/issue/CB-108/validate-signal-outcome-worker-intervals)
