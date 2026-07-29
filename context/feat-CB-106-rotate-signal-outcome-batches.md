# feat: rotate signal-outcome batches across worker sweeps (CB-106)

## Summary

Resolves starvation in autonomous signal-outcome evaluation worker sweeps when total pending documents exceed the evaluation batch limit (`SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT`, default 50). Successive worker sweeps now rotate cursor position using `startAfter` cursor pagination across sweeps, wrapping around to the start of the pending set when reaching the end.

## Key Changes

- **SignalOutcomeService Cursor Rotation**:
  - Added module-level `lastEvaluatedDoc` cursor to persist rotation state across successive evaluation sweeps.
  - Configured `evaluatePendingOutcomes()` to start queries after `lastEvaluatedDoc` and wrap around cleanly to `null` if the cursor query returns an empty set.
  - Reset `lastEvaluatedDoc` to `null` on `stopWorker()` and when reaching the end of the pending queue.
- **Firebase Admin Mock Enhancements**:
  - Updated `__mocks__/firebase-admin.js` to correctly support `startAfter` cursor pagination and `where` filtering in mock query execution.
- **Unit Testing Coverage**:
  - Added targeted test `rotates signal outcome batches across successive worker sweeps when pending exceeds batch limit` in `tests/unit/signal-outcome-worker.test.js` using 5 pending fixtures with limit 2.

## Technical Implementation

- In `src/services/storage/SignalOutcomeService.js`, `evaluatePendingOutcomes()` applies `.startAfter(lastEvaluatedDoc)` when `lastEvaluatedDoc` is set.
- Upon completing a sweep, `lastEvaluatedDoc` is assigned `snapshot.docs[snapshot.docs.length - 1]`.
- If a cursor query yields no documents (`snapshot.empty`), the service resets `lastEvaluatedDoc = null` and retries from the beginning of `where('outcomeEvaluated', '==', false)`.

## Testing

- Verified unit tests: `pnpm test -- tests/unit/signal-outcome-worker.test.js tests/unit/signal-outcome-service.test.js`
- Verified integration test suite: `pnpm test -- tests/integration/signal-outcome-integration.test.js`
- All 31 signal outcome tests pass cleanly.

## References

- **Linear**: [CB-106](https://linear.app/knil/issue/CB-106/rotate-signal-outcome-batches-across-worker-sweeps)
- **GitHub Issue**: [#268](https://github.com/francovp/cabros-bot/issues/268)
