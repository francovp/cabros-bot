fix: preserve unprocessed signal-outcome cursor docs (CB-111)

## Summary

The autonomous signal-outcome evaluation worker previously assigned `lastEvaluatedDoc` to the last document of a fetched snapshot before executing the document evaluation loop. When a duration budget (`SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS`) or request deadline was hit during the sweep, the loop halted early, leaving remaining documents in that fetched page unprocessed while `lastEvaluatedDoc` remained set to the end of the page. On the subsequent sweep, `.startAfter(lastEvaluatedDoc)` skipped those remaining unprocessed documents, delaying their outcome evaluations until a full cursor wraparound occurred.

This change updates `SignalOutcomeService.js` to advance the `lastEvaluatedDoc` cursor after each document actually processed (and when doc evaluation completes without exceeding deadline), so that a deadline-aborted sweep resumes immediately from the last processed document on the next sweep without skipping documents or requiring a full wraparound.

## Key Changes

- **SignalOutcomeService Cursor Management**: Removed premature `lastEvaluatedDoc` assignment prior to document iteration in `evaluatePendingOutcomes()`. Updated `lastEvaluatedDoc = doc` upon successful processing of each document and prior to breaking on `sweepDeadlineExceeded`.
- **Unit Testing Coverage**: Added unit test `resumes from the last processed document when a sweep is aborted by deadline` in `tests/unit/signal-outcome-worker.test.js` asserting that a deadline-aborted sweep resumes cleanly from the last processed document.

## Technical Implementation

- In `src/services/storage/SignalOutcomeService.js`:
  - Removed line `lastEvaluatedDoc = snapshot.docs[snapshot.docs.length - 1];`.
  - Added `lastEvaluatedDoc = doc` on early `continue` branches (`missing_entry_price`, `unsupported_exchange`).
  - Added `if (!sweepDeadlineExceeded) lastEvaluatedDoc = doc;` before `if (sweepDeadlineExceeded) break;` at the end of the document processing loop.

## Testing

- Ran `pnpm test -- tests/unit/signal-outcome-worker.test.js tests/unit/signal-outcome-service.test.js --testTimeout=5000` — all 33 tests passed.
- Ran `pnpm test -- tests/integration/signal-outcome-integration.test.js` — all 2 tests passed.

## References

- **Linear**: [CB-111](https://linear.app/knil/issue/CB-111/preserve-unprocessed-signal-outcome-cursor-documents-gh-279)
- **GitHub Issue**: [#279](https://github.com/francovp/cabros-bot/issues/279)
